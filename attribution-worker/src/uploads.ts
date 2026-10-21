// Google 広告への送信の段取り（Data Manager API を前提にした2段階）。
//
//   pending/retry ──送る──▶ submitted ──30分後から結果を確かめる──▶ uploaded / duplicate / failed
//                                         └─ まだ処理中 → 間をあけてまた確かめる（26時間で送り直し）
//
// - 1リクエスト1件で送り、行ごとの結果を確実に得る（Data Manager API は理由ごとの件数しか返さない）
// - 重複は transactionId（= inquiry_id）で Google 側でも防がれる。届いたか分からないときは同じIDで送り直してよい
// - 認証・送信先の設定の問題は、行のせいではないので回数を数えずに全体を止める
// - 一時的な障害は待って送り直し、MAX_ATTEMPTS 回で打ち切る
// - 1回の実行で外へ出す通信の数に上限を置く（件数に比例して増やさない）

import type { Config } from "./config";
import { addHours, formatJstRfc3339 } from "./attribution";
import { countDiag } from "./store";

export interface ConversionEvent {
  /** Google 側の transactionId。inquiry_id をそのまま使う。 */
  orderId: string;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  /** UTC ISO */
  conversionAt: string;
  /** RFC 3339・日本時間（例: 2026-10-21T12:34:56+09:00） */
  conversionAtRfc3339: string;
}

/** 行のせいではない失敗（通信・認証）。 */
export type CallError = { kind: "auth_error" | "transient"; code: string };

export type SubmitResult =
  /** warnings: 任意の項目が受け付けられなかった数（fieldWarnings） */
  | { kind: "accepted"; requestId: string; warnings: number }
  /** validateOnly のとき。取り込まれていない。 */
  | { kind: "validated"; warnings: number }
  /** この1件の中身が受け付けられない（直すまで送らない） */
  | { kind: "rejected"; code: string }
  /** 送信先の設定（アカウント・コンバージョンアクション）の問題。全体を止める */
  | { kind: "config_error"; code: string }
  | CallError;

export type StatusResult =
  | { kind: "processing" }
  | { kind: "success" }
  | { kind: "duplicate"; code: string }
  | { kind: "retry_later"; code: string; hours: number }
  | { kind: "failed"; code: string }
  /** requestId が見つからない。同じ transactionId で送り直す（重複は Google 側で弾かれる） */
  | { kind: "unknown" }
  | CallError;

export interface ConversionSender {
  submit(event: ConversionEvent): Promise<SubmitResult>;
  status(requestId: string): Promise<StatusResult>;
}

export const MAX_ATTEMPTS = 6;
/** n 回目の送信の失敗のあと、次に送るまでの時間（時間）。 */
export const BACKOFF_HOURS = [1, 3, 6, 12, 24];
/** 送ってから最初に結果を確かめるまで（分）。公式は「30分待ってから」。 */
export const FIRST_STATUS_CHECK_MIN = 30;
/** 結果の確認の間隔の上限（時間）。 */
export const MAX_STATUS_INTERVAL_HOURS = 8;
/** これだけ待っても処理中なら、同じ transactionId で送り直す（公式は「最大24時間」）。 */
export const STATUS_GIVE_UP_HOURS = 26;
/** 締め切りの直前は送らない（Google 側の受付と時計のずれを見込む）。 */
export const DEADLINE_MARGIN_HOURS = 12;
/** 1回の実行で送る件数・確かめる件数の上限（外への通信の数を決めておく）。 */
export const SUBMITS_PER_PASS = 10;
export const STATUS_CHECKS_PER_PASS = 20;

/** 相手が返した文は保存しない。決まった形の短いコードだけを残す。 */
export function safeCode(code: unknown): string {
  return typeof code === "string" && /^[A-Za-z0-9_:.-]{1,80}$/.test(code) ? code : "unknown";
}

export interface UploadPassReport {
  skipped?: "disabled" | "not_configured" | "auth_error" | "config_error";
  expired: number;
  submitted: number;
  validated: number;
  checked: number;
  uploaded: number;
  duplicate: number;
  failed: number;
  retry: number;
}

interface DueSubmit {
  inquiry_id: string;
  attempts: number;
  conversion_at: string;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
}

interface DueCheck {
  inquiry_id: string;
  attempts: number;
  request_id: string;
  submitted_at: string;
  status_checks: number;
}

function retryAfterFailure(attempts: number): number {
  return BACKOFF_HOURS[Math.min(Math.max(attempts, 1) - 1, BACKOFF_HOURS.length - 1)];
}

export async function runUploadPass(
  db: D1Database,
  cfg: Config,
  sender: ConversionSender | null,
  now: Date,
): Promise<UploadPassReport> {
  const nowIso = now.toISOString();
  const report: UploadPassReport = {
    expired: 0,
    submitted: 0,
    validated: 0,
    checked: 0,
    uploaded: 0,
    duplicate: 0,
    failed: 0,
    retry: 0,
  };
  if (!cfg.enabled || !cfg.uploadEnabled) {
    await countDiag(db, "upload_disabled", nowIso);
    return { ...report, skipped: "disabled" };
  }
  if (!sender) {
    await countDiag(db, "upload_not_configured", nowIso);
    return { ...report, skipped: "not_configured" };
  }

  const set = (id: string, fields: Record<string, string | number | null>) => {
    const cols = Object.keys(fields);
    const sql = `UPDATE conversion_uploads SET ${cols.map((c, i) => `${c} = ?${i + 2}`).join(", ")}, updated_at = ?${cols.length + 2} WHERE inquiry_id = ?1`;
    return db.prepare(sql).bind(id, ...cols.map((c) => fields[c]), nowIso).run();
  };

  // 0. 締め切りを過ぎた・クリックが消えたものは送らない（送ったあとの結果待ちは対象外）。
  const expired = await db
    .prepare(
      `UPDATE conversion_uploads SET status = 'expired', last_error_code = 'deadline', updated_at = ?2
       WHERE status IN ('pending', 'retry') AND (
         deadline_at <= ?1 OR NOT EXISTS (
           SELECT 1 FROM inquiries i JOIN ad_clicks c ON c.ad_ref = i.ad_ref
           WHERE i.inquiry_id = conversion_uploads.inquiry_id))`,
    )
    .bind(addHours(nowIso, DEADLINE_MARGIN_HOURS), nowIso)
    .run();
  report.expired = expired.meta.changes ?? 0;
  if (report.expired > 0) await countDiag(db, "upload_expired", nowIso);

  // 1. 送ったものの結果を確かめる。
  const { results: checks } = await db
    .prepare(
      `SELECT inquiry_id, attempts, request_id, submitted_at, status_checks FROM conversion_uploads
       WHERE status = 'submitted' AND store = ?1 AND next_attempt_at <= ?2
       ORDER BY next_attempt_at LIMIT ?3`,
    )
    .bind(cfg.store, nowIso, STATUS_CHECKS_PER_PASS)
    .all<DueCheck>();
  for (const row of checks) {
    let r: StatusResult;
    try {
      r = await sender.status(row.request_id);
    } catch {
      r = { kind: "transient", code: "sender_exception" };
    }
    report.checked += 1;
    if (r.kind === "auth_error") {
      await countDiag(db, "upload_auth_error", nowIso);
      return { ...report, skipped: "auth_error" };
    }
    if (r.kind === "success") {
      report.uploaded += 1;
      await set(row.inquiry_id, { status: "uploaded", uploaded_at: nowIso, next_attempt_at: null, last_error_code: null });
    } else if (r.kind === "duplicate") {
      report.duplicate += 1;
      await set(row.inquiry_id, { status: "duplicate", next_attempt_at: null, last_error_code: safeCode(r.code) });
    } else if (r.kind === "failed") {
      report.failed += 1;
      await set(row.inquiry_id, { status: "failed", next_attempt_at: null, last_error_code: safeCode(r.code) });
    } else if (
      row.attempts >= MAX_ATTEMPTS &&
      (r.kind === "retry_later" || r.kind === "unknown" || (r.kind === "processing" && Date.parse(nowIso) - Date.parse(row.submitted_at) >= STATUS_GIVE_UP_HOURS * 3_600_000))
    ) {
      // 送り直す必要があるが、もう上限まで送った。打ち切る。
      report.failed += 1;
      await set(row.inquiry_id, {
        status: "failed",
        next_attempt_at: null,
        request_id: null,
        last_error_code: `max_attempts:${r.kind === "retry_later" ? safeCode(r.code) : r.kind === "unknown" ? "status_not_found" : "status_timeout"}`,
      });
    } else if (r.kind === "retry_later") {
      report.retry += 1;
      await set(row.inquiry_id, {
        status: "retry",
        next_attempt_at: addHours(nowIso, r.hours),
        last_error_code: safeCode(r.code),
        request_id: null,
      });
    } else if (r.kind === "unknown" || (r.kind === "processing" && Date.parse(nowIso) - Date.parse(row.submitted_at) >= STATUS_GIVE_UP_HOURS * 3_600_000)) {
      // 結果が分からないまま。同じ transactionId で送り直す（取り込み済みなら重複として弾かれる）。
      report.retry += 1;
      await set(row.inquiry_id, {
        status: "retry",
        next_attempt_at: nowIso,
        last_error_code: r.kind === "unknown" ? "status_not_found" : "status_timeout",
        request_id: null,
      });
    } else {
      // 処理中・一時的な障害: 間をあけてまた確かめる。
      const checksDone = row.status_checks + 1;
      const waitHours = Math.min((FIRST_STATUS_CHECK_MIN / 60) * 2 ** checksDone, MAX_STATUS_INTERVAL_HOURS);
      await set(row.inquiry_id, {
        status_checks: checksDone,
        next_attempt_at: addHours(nowIso, waitHours),
        last_error_code: r.kind === "transient" ? safeCode(r.code) : null,
      });
    }
  }

  // 2. まだ送っていないもの・送り直すものを送る（1リクエスト1件）。
  const { results: due } = await db
    .prepare(
      `SELECT u.inquiry_id, u.attempts, u.conversion_at, c.gclid, c.gbraid, c.wbraid
       FROM conversion_uploads u
       JOIN inquiries i ON i.inquiry_id = u.inquiry_id
       JOIN ad_clicks c ON c.ad_ref = i.ad_ref
       WHERE u.status IN ('pending', 'retry') AND u.store = ?1
         AND (u.next_attempt_at IS NULL OR u.next_attempt_at <= ?2)
       ORDER BY u.created_at LIMIT ?3`,
    )
    .bind(cfg.store, nowIso, SUBMITS_PER_PASS)
    .all<DueSubmit>();
  for (const row of due) {
    const event: ConversionEvent = {
      orderId: row.inquiry_id,
      gclid: row.gclid,
      gbraid: row.gbraid,
      wbraid: row.wbraid,
      conversionAt: row.conversion_at,
      conversionAtRfc3339: formatJstRfc3339(row.conversion_at),
    };
    let r: SubmitResult;
    try {
      r = await sender.submit(event);
    } catch {
      r = { kind: "transient", code: "sender_exception" };
    }
    if (r.kind === "auth_error" || r.kind === "config_error") {
      // 行のせいではない。回数を数えず、人が直すまで止める。
      await countDiag(db, r.kind === "auth_error" ? "upload_auth_error" : "upload_config_error", nowIso);
      await set(row.inquiry_id, { last_error_code: safeCode(r.code) });
      return { ...report, skipped: r.kind };
    }
    if ((r.kind === "validated" || r.kind === "accepted") && r.warnings > 0) {
      await countDiag(db, "upload_field_warning", nowIso);
    }
    if (r.kind === "validated") {
      // 確かめるだけのモード。取り込まれていないので、状態は変えずに1日あける。
      report.validated += 1;
      await set(row.inquiry_id, {
        next_attempt_at: addHours(nowIso, 24),
        last_error_code: r.warnings > 0 ? "validated_with_field_warnings" : "validated_only",
      });
      continue;
    }
    const attempts = row.attempts + 1;
    if (r.kind === "accepted") {
      report.submitted += 1;
      await set(row.inquiry_id, {
        status: "submitted",
        attempts,
        request_id: r.requestId,
        submitted_at: nowIso,
        status_checks: 0,
        next_attempt_at: addHours(nowIso, FIRST_STATUS_CHECK_MIN / 60),
        last_error_code: r.warnings > 0 ? "field_warnings" : null,
      });
    } else if (r.kind === "rejected" || attempts >= MAX_ATTEMPTS) {
      report.failed += 1;
      await set(row.inquiry_id, {
        status: "failed",
        attempts,
        next_attempt_at: null,
        last_error_code: r.kind === "rejected" ? safeCode(r.code) : `max_attempts:${safeCode(r.code)}`,
      });
    } else {
      report.retry += 1;
      await set(row.inquiry_id, {
        status: "retry",
        attempts,
        next_attempt_at: addHours(nowIso, retryAfterFailure(attempts)),
        last_error_code: safeCode(r.code),
      });
    }
  }

  if (report.submitted) await countDiag(db, "upload_submitted", nowIso);
  if (report.uploaded) await countDiag(db, "upload_row_ok", nowIso);
  if (report.duplicate) await countDiag(db, "upload_row_duplicate", nowIso);
  if (report.failed) await countDiag(db, "upload_row_failed", nowIso);
  if (report.retry) await countDiag(db, "upload_row_retry", nowIso);
  if (report.validated) await countDiag(db, "upload_validated", nowIso);
  return report;
}
