// Google 広告への送信の段取り（送信先の API に依存しない部分）。
//
// 🚧 送信そのもの（ConversionSender の実装）はまだ無い。
//   Google 広告 API の UploadClickConversions は、2026-06-15 以降「過去に使ったことのない
//   Cloud プロジェクト」からは失敗する（公式: developers.google.com/google-ads/api/docs/conversions/upload-offline）。
//   代わりは Data Manager API だが、オーナーの決定④（Google 広告 API）と違うため、決め直してもらうまで作らない。
// ここにあるのは「どれを・いつ・何回まで送るか」と「行ごとの結果の反映」だけで、外とは通信しない。

import type { Config } from "./config";
import { addHours, formatJstDateTime } from "./attribution";
import { countDiag } from "./store";

export interface ConversionEvent {
  /** 重複防止の鍵（Google 側の order_id / transactionId）。inquiry_id をそのまま使う。 */
  orderId: string;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  /** UTC ISO */
  conversionAt: string;
  /** yyyy-mm-dd HH:mm:ss+09:00 */
  conversionAtJst: string;
  currency: "JPY";
  /** 入口ページで明示的に同意した人だけが pending になる。 */
  adUserData: "GRANTED";
}

export type RowOutcome = "accepted" | "rejected" | "retryable";

export type SendResult =
  /** 行ごとの結果（partial failure）。HTTP 200 でも行ごとに見る。 */
  | { kind: "rows"; rows: { orderId: string; outcome: RowOutcome; code: string }[] }
  /** 認証切れ・権限不足。行の試行回数は増やさず、全体を止める。 */
  | { kind: "auth_error"; code: string }
  /** 一時的な障害（5xx・429・タイムアウト）。 */
  | { kind: "transient"; code: string }
  /** リクエスト全体が拒否された（設定の不整合など）。 */
  | { kind: "request_rejected"; code: string };

export interface ConversionSender {
  send(events: ConversionEvent[]): Promise<SendResult>;
}

export const UPLOAD_BATCH_SIZE = 100;
export const MAX_ATTEMPTS = 6;
/** n 回目の失敗のあと、次に試すまでの時間（時間）。 */
export const BACKOFF_HOURS = [1, 3, 6, 12, 24];
/** 締め切りの直前は送らない（Google 側の受付と時計のずれを見込む）。 */
export const DEADLINE_MARGIN_HOURS = 12;

/** 送信先が返す文は保存しない。決まった形の短いコードだけを残す。 */
export function safeCode(code: unknown): string {
  return typeof code === "string" && /^[A-Za-z0-9_:.-]{1,64}$/.test(code) ? code : "unknown";
}

interface DueRow {
  inquiry_id: string;
  attempts: number;
  conversion_at: string;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
}

export interface UploadPassReport {
  skipped?: "disabled" | "not_configured" | "auth_error";
  expired: number;
  sent: number;
  uploaded: number;
  failed: number;
  retry: number;
}

export async function runUploadPass(
  db: D1Database,
  cfg: Config,
  sender: ConversionSender | null,
  now: Date,
): Promise<UploadPassReport> {
  const nowIso = now.toISOString();
  const report: UploadPassReport = { expired: 0, sent: 0, uploaded: 0, failed: 0, retry: 0 };
  if (!cfg.enabled || !cfg.uploadEnabled) {
    await countDiag(db, "upload_disabled", nowIso);
    return { ...report, skipped: "disabled" };
  }
  if (!sender) {
    await countDiag(db, "upload_not_configured", nowIso);
    return { ...report, skipped: "not_configured" };
  }

  // 締め切りを過ぎた・クリックが消えたものは送らない。
  const cutoff = addHours(nowIso, DEADLINE_MARGIN_HOURS);
  const expired = await db
    .prepare(
      `UPDATE conversion_uploads SET status = 'expired', last_error_code = 'deadline', updated_at = ?2
       WHERE status IN ('pending', 'retry') AND (
         deadline_at <= ?1 OR NOT EXISTS (
           SELECT 1 FROM inquiries i JOIN ad_clicks c ON c.ad_ref = i.ad_ref
           WHERE i.inquiry_id = conversion_uploads.inquiry_id))`,
    )
    .bind(cutoff, nowIso)
    .run();
  report.expired = expired.meta.changes ?? 0;
  if (report.expired > 0) await countDiag(db, "upload_expired", nowIso);

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
    .bind(cfg.store, nowIso, UPLOAD_BATCH_SIZE)
    .all<DueRow>();
  if (due.length === 0) return report;

  const events: ConversionEvent[] = due.map((r) => ({
    orderId: r.inquiry_id,
    gclid: r.gclid,
    gbraid: r.gbraid,
    wbraid: r.wbraid,
    conversionAt: r.conversion_at,
    conversionAtJst: formatJstDateTime(r.conversion_at),
    currency: "JPY",
    adUserData: "GRANTED",
  }));
  report.sent = events.length;

  let result: SendResult;
  try {
    result = await sender.send(events);
  } catch {
    result = { kind: "transient", code: "sender_exception" };
  }

  if (result.kind === "auth_error") {
    // 認証の問題は行のせいではない。回数を増やさず、人が直すまで止める（診断に出す）。
    await countDiag(db, "upload_auth_error", nowIso);
    return { ...report, sent: 0, skipped: "auth_error" };
  }

  const byId = new Map<string, { outcome: RowOutcome; code: string }>();
  if (result.kind === "rows") {
    for (const row of result.rows) byId.set(row.orderId, { outcome: row.outcome, code: safeCode(row.code) });
  } else {
    await countDiag(db, "upload_transient_error", nowIso);
  }
  const requestCode = result.kind === "rows" ? "missing_row_result" : safeCode(result.code);

  const stmts: D1PreparedStatement[] = [];
  for (const row of due) {
    // 結果が返らなかった行は「届いたか分からない」。order_id で重複は防げるので、もう一度送る。
    const r = byId.get(row.inquiry_id) ?? { outcome: "retryable" as const, code: requestCode };
    const attempts = row.attempts + 1;
    if (r.outcome === "accepted") {
      report.uploaded += 1;
      stmts.push(
        db
          .prepare(
            `UPDATE conversion_uploads SET status = 'uploaded', attempts = ?2, uploaded_at = ?3,
               last_error_code = NULL, next_attempt_at = NULL, updated_at = ?3 WHERE inquiry_id = ?1`,
          )
          .bind(row.inquiry_id, attempts, nowIso),
      );
    } else if (r.outcome === "rejected" || attempts >= MAX_ATTEMPTS) {
      report.failed += 1;
      stmts.push(
        db
          .prepare(
            `UPDATE conversion_uploads SET status = 'failed', attempts = ?2, last_error_code = ?3,
               next_attempt_at = NULL, updated_at = ?4 WHERE inquiry_id = ?1`,
          )
          .bind(row.inquiry_id, attempts, r.outcome === "rejected" ? r.code : `max_attempts:${r.code}`, nowIso),
      );
    } else {
      report.retry += 1;
      const wait = BACKOFF_HOURS[Math.min(attempts - 1, BACKOFF_HOURS.length - 1)];
      stmts.push(
        db
          .prepare(
            `UPDATE conversion_uploads SET status = 'retry', attempts = ?2, last_error_code = ?3,
               next_attempt_at = ?4, updated_at = ?5 WHERE inquiry_id = ?1`,
          )
          .bind(row.inquiry_id, attempts, r.code, addHours(nowIso, wait), nowIso),
      );
    }
  }
  await db.batch(stmts);
  if (report.uploaded) await countDiag(db, "upload_row_ok", nowIso);
  if (report.failed) await countDiag(db, "upload_row_failed", nowIso);
  if (report.retry) await countDiag(db, "upload_row_retry", nowIso);
  return report;
}
