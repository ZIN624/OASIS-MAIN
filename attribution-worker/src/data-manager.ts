// Google Data Manager API でオフラインコンバージョン（クリック識別子つき）を送る。
// 一次情報（2026-10-21 に確認）:
//   - POST https://datamanager.googleapis.com/v1/events:ingest / GET v1/requestStatus:retrieve
//     （discovery 文書 revision 20261016・スコープ https://www.googleapis.com/auth/datamanager）
//   - 1件でも不正ならリクエスト全体が失敗する（fast-fail）。成功すると requestId が返り、
//     取り込みの成否はあとから requestStatus で「理由ごとの件数」として返る（どの行かは返らない）
//     → 行ごとの結果を確実に得るため、1リクエストに1件だけ入れる。
//   - 最初の確認は送ってから30分後。処理は最大24時間かかることがある
//   - 恒久的なエラー（400 など）は直すまで送り直さない。一時的なもの（5xx・429）は待って送り直す
//   - productDestinationId は種類 UPLOAD_CLICKS のコンバージョンアクションの ID
// 送るのはクリック識別子・時刻・取引ID（= inquiry_id）・同意だけ。氏名・電話番号・メール・LINE の ID は送らない。

import { hasTestClickId } from "./attribution";
import type { DataManagerConfig } from "./config";
import { fetchAccessToken, parseServiceAccountKey } from "./google-auth";
import type { FetchLike } from "./line";
import type { CallError, ConversionEvent, ConversionSender, StatusResult, SubmitResult } from "./uploads";

export const DATA_MANAGER_BASE = "https://datamanager.googleapis.com/v1";
const REQUEST_TIMEOUT_MS = 20_000;

/** 1件分のリクエスト本文。テストでそのまま中身を確かめる。 */
export function buildIngestRequest(cfg: DataManagerConfig, event: ConversionEvent): Record<string, unknown> {
  const adIdentifiers: Record<string, string> = {};
  // 1件に入れる識別子は1つだけ。gclid を最優先し、無いときだけ gbraid、それも無いときだけ wbraid。
  // gbraid / wbraid は「カウント: 1回」のアクションでは使えない（PROCESSING_ERROR_REASON_ONE_PER_CLICK_
  // CONVERSION_ACTION_NOT_PERMITTED_WITH_BRAID・公式 RPC リファレンス）。gclid があるときに braid を足して
  // その制限に触れないよう、gclid と一緒には送らない。
  if (event.gclid) {
    adIdentifiers.gclid = event.gclid;
  } else if (event.gbraid) {
    adIdentifiers.gbraid = event.gbraid;
  } else if (event.wbraid) {
    adIdentifiers.wbraid = event.wbraid;
  }
  const destination: Record<string, unknown> = {
    operatingAccount: { accountType: "GOOGLE_ADS", accountId: cfg.operatingAccountId },
    productDestinationId: cfg.conversionActionId,
  };
  if (cfg.loginAccountId) destination.loginAccount = { accountType: "GOOGLE_ADS", accountId: cfg.loginAccountId };
  return {
    destinations: [destination],
    events: [
      {
        adIdentifiers,
        eventTimestamp: event.conversionAtRfc3339,
        transactionId: event.orderId,
        eventSource: "WEB",
        consent: { adUserData: "CONSENT_GRANTED" },
      },
    ],
    validateOnly: cfg.validateOnly,
  };
}

const safe = (v: unknown, fallback: string): string =>
  typeof v === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(v) ? v : fallback;

interface GoogleError {
  status?: string;
  details?: { "@type"?: string; reason?: string; fieldViolations?: { field?: string; reason?: string }[] }[];
}

/** events:ingest の応答を分類する（相手の文は残さない）。 */
export function classifyIngestResponse(status: number, body: unknown, validateOnly: boolean): SubmitResult {
  const b = (body ?? {}) as { requestId?: unknown; fieldWarnings?: unknown; error?: GoogleError };
  if (status === 200) {
    // 任意の項目が受け付けられなかったときに入る（中身の文は残さず、件数だけ見る）。
    const warnings = Array.isArray(b.fieldWarnings) ? b.fieldWarnings.length : 0;
    if (validateOnly) return { kind: "validated", warnings };
    return typeof b.requestId === "string" && b.requestId.length > 0 && b.requestId.length <= 200
      ? { kind: "accepted", requestId: b.requestId, warnings }
      : { kind: "transient", code: "bad_response" };
  }
  const err = b.error ?? {};
  const code = safe(err.status, `http_${status}`);
  if (status === 401 || status === 403) return { kind: "auth_error", code };
  if (status === 429 || status >= 500) return { kind: "transient", code };
  if (status === 400) {
    const violations = (err.details ?? []).flatMap((d) => d.fieldViolations ?? []);
    // 送信先（アカウントID・コンバージョンアクション）の誤りは、どの行を送っても同じ。全体を止める。
    if (violations.some((v) => typeof v.field === "string" && v.field.startsWith("destinations"))) {
      return { kind: "config_error", code: `destination:${safe(violations[0]?.reason, "INVALID_ARGUMENT")}` };
    }
    return { kind: "rejected", code: safe(violations[0]?.reason, code) };
  }
  // 404（送信先が無い）など、その他の 4xx は設定の問題として止める。
  return { kind: "config_error", code };
}

/** 取り込みの理由（ProcessingErrorReason）ごとの扱い。 */
const RETRY_LATER_HOURS: Record<string, number> = {
  // Google がまだクリックを処理していない。12時間後に送り直す（Google 広告ヘルプ）
  PROCESSING_ERROR_REASON_TOO_RECENT_CLICK: 12,
  // コンバージョンアクションを作ったばかり
  PROCESSING_ERROR_REASON_DESTINATION_TOO_RECENTLY_CREATED: 24,
  PROCESSING_ERROR_REASON_INTERNAL_ERROR: 6,
};
const DUPLICATE_REASONS = new Set([
  // 同じ取引ID（= 同じ問い合わせ）をもう受け取っている。送り直しが重複として弾かれたもの
  "PROCESSING_ERROR_REASON_DUPLICATE_TRANSACTION_ID",
  // 同じクリックですでに数えている
  "PROCESSING_ERROR_REASON_DUPLICATE_GCLID",
]);

/** requestStatus:retrieve の応答を分類する。1リクエスト1件なので、理由は全部その1件のもの。 */
export function classifyStatusResponse(status: number, body: unknown): StatusResult {
  if (status === 401 || status === 403) return { kind: "auth_error", code: `http_${status}` };
  if (status === 404) return { kind: "unknown" };
  if (status !== 200) return { kind: "transient", code: `http_${status}` };
  const per = ((body ?? {}) as { requestStatusPerDestination?: unknown[] }).requestStatusPerDestination;
  const first = (Array.isArray(per) ? per[0] : null) as
    | { requestStatus?: string; errorInfo?: { errorCounts?: { reason?: string }[] } }
    | null;
  if (!first) return { kind: "transient", code: "bad_response" };
  const reasons = (first.errorInfo?.errorCounts ?? []).map((e) => safe(e.reason, "PROCESSING_ERROR_REASON_UNSPECIFIED"));
  switch (first.requestStatus) {
    case "SUCCESS":
      return { kind: "success" };
    case "FAILED":
    case "PARTIAL_SUCCESS": {
      const reason = reasons[0] ?? "PROCESSING_ERROR_REASON_UNSPECIFIED";
      if (DUPLICATE_REASONS.has(reason)) return { kind: "duplicate", code: reason };
      if (reason in RETRY_LATER_HOURS) return { kind: "retry_later", code: reason, hours: RETRY_LATER_HOURS[reason] };
      return { kind: "failed", code: reason };
    }
    default:
      // PROCESSING・REQUEST_STATUS_UNKNOWN は、まだ終わっていない。
      return { kind: "processing" };
  }
}

/** 設定と鍵がそろっていなければ null（送らない）。 */
export function createDataManagerSender(
  cfg: DataManagerConfig | null,
  saKeyJson: string | undefined,
  fetchImpl: FetchLike,
  nowSec: () => number,
): ConversionSender | null {
  const key = parseServiceAccountKey(saKeyJson);
  if (!cfg || !key) return null;
  let token: { value: string; until: number } | null = null;

  async function authHeader(): Promise<{ ok: true; header: string } | { ok: false; error: CallError }> {
    if (token && token.until > nowSec()) return { ok: true, header: `Bearer ${token.value}` };
    const r = await fetchAccessToken(key!, nowSec(), fetchImpl);
    if (!r.ok) return { ok: false, error: { kind: r.kind, code: r.code } };
    token = { value: r.accessToken, until: nowSec() + 50 * 60 };
    return { ok: true, header: `Bearer ${r.accessToken}` };
  }

  async function call(url: string, init: RequestInit): Promise<{ status: number; body: unknown } | { error: CallError }> {
    const auth = await authHeader();
    if (!auth.ok) return { error: auth.error };
    try {
      const res = await fetchImpl(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: auth.header },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    } catch {
      return { error: { kind: "transient", code: "network" } };
    }
  }

  return {
    async submit(event) {
      // 二重の止め具。送信の処理を通らずに呼ばれても、偽の識別子は Google へ出さない。
      if (hasTestClickId(event)) return { kind: "rejected", code: "test_click_id" };
      const r = await call(`${DATA_MANAGER_BASE}/events:ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildIngestRequest(cfg, event)),
      });
      return "error" in r ? r.error : classifyIngestResponse(r.status, r.body, cfg.validateOnly);
    },
    async status(requestId) {
      const r = await call(`${DATA_MANAGER_BASE}/requestStatus:retrieve?requestId=${encodeURIComponent(requestId)}`, {
        method: "GET",
      });
      return "error" in r ? r.error : classifyStatusResponse(r.status, r.body);
    },
  };
}
