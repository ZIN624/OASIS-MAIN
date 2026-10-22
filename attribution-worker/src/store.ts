// 回数制限と診断の件数（D1）。どちらも生のIP・利用者IDを持たない。

import { hmacHex } from "./crypto";
import { jstDay } from "./attribution";

export type RateBucket = "ad_click" | "bind" | "session" | "inquiry" | "inquiry_user" | "admin";

export const RATE_LIMITS: Record<RateBucket, { limit: number; windowSec: number }> = {
  ad_click: { limit: 30, windowSec: 600 },
  bind: { limit: 10, windowSec: 600 },
  session: { limit: 30, windowSec: 600 },
  inquiry: { limit: 20, windowSec: 600 },
  inquiry_user: { limit: 10, windowSec: 3600 },
  admin: { limit: 30, windowSec: 600 },
};

/** 固定窓で数える。上限を超えたら false。 */
export async function takeRate(
  db: D1Database,
  rootKey: string,
  bucket: RateBucket,
  rawKey: string,
  nowMs: number,
): Promise<boolean> {
  const { limit, windowSec } = RATE_LIMITS[bucket];
  const windowStart = new Date(Math.floor(nowMs / (windowSec * 1000)) * windowSec * 1000).toISOString();
  const key = await hmacHex(rootKey, "rate-key/v1", `${bucket}:${rawKey}`);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, key, window_start, count) VALUES (?1, ?2, ?3, 1)
       ON CONFLICT (bucket, key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(bucket, key, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

export type DiagCode =
  | "ad_click_ok"
  | "ad_click_rejected"
  | "ad_click_path_rejected"
  | "bind_ok"
  | "bind_declined"
  | "bind_ref_unknown"
  | "bind_ref_expired"
  | "bind_ref_taken"
  | "session_ok"
  | "inquiry_ok"
  | "inquiry_duplicate"
  | "inquiry_resent"
  | "inquiry_session_invalid"
  | "inquiry_rejected"
  | "inquiry_attributed"
  | "inquiry_suppressed_duplicate"
  | "rate_limited"
  | "origin_rejected"
  | "disabled"
  | "upload_disabled"
  | "upload_not_configured"
  | "upload_live_not_allowed"
  | "upload_validate_only_invalid"
  | "upload_test_click_blocked"
  | "upload_auth_error"
  | "upload_config_error"
  | "upload_submitted"
  | "upload_validated"
  | "upload_field_warning"
  | "upload_row_duplicate"
  | "upload_transient_error"
  | "upload_row_ok"
  | "upload_row_failed"
  | "upload_row_retry"
  | "upload_expired"
  | `line_${string}`;

/** 診断の件数を足す。失敗しても本処理は止めない。 */
export async function countDiag(db: D1Database, code: DiagCode, nowIso: string): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO diag_counters (day, code, count) VALUES (?1, ?2, 1)
         ON CONFLICT (day, code) DO UPDATE SET count = count + 1`,
      )
      .bind(jstDay(nowIso), code)
      .run();
  } catch {
    // 診断の記録に失敗しても受付は続ける。
  }
}
