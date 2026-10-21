// 毎日の削除。クリック識別子と LINE 利用者のHMACを90日で消し、問い合わせは件数だけを13か月残す。
// 消した件数は retention_runs に残す（監査用）。

import { addDays, addHours } from "./attribution";
import { CLICK_RETENTION_DAYS, INQUIRY_RETENTION_MONTHS } from "./config";

export interface RetentionReport {
  clicks_deleted: number;
  bindings_deleted: number;
  inquiries_scrubbed: number;
  inquiries_deleted: number;
  uploads_expired: number;
  uploads_deleted: number;
  rate_limits_deleted: number;
}

function monthsAgo(iso: string, months: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

export async function runRetention(db: D1Database, now: Date): Promise<RetentionReport> {
  const nowIso = now.toISOString();
  const ninetyDaysAgo = addDays(nowIso, -CLICK_RETENTION_DAYS);
  const inquiryCutoff = monthsAgo(nowIso, INQUIRY_RETENTION_MONTHS);

  // クリックが消える（期限切れ・結ばれないまま結びつけの期限を過ぎた）もの。
  const dyingClicks = `SELECT ad_ref FROM ad_clicks WHERE expires_at <= ?1 OR (bound_at IS NULL AND bind_expires_at <= ?1)`;

  const results = await db.batch([
    // 1. まだ送っていない分は、送れなくなるので expired にする。
    db
      .prepare(
        `UPDATE conversion_uploads SET status = 'expired', last_error_code = 'retention', updated_at = ?1
         WHERE status IN ('pending', 'retry', 'blocked_consent') AND inquiry_id IN (
           SELECT inquiry_id FROM inquiries WHERE ad_ref IN (${dyingClicks}) OR submitted_at <= ?2)`,
      )
      .bind(nowIso, ninetyDaysAgo),
    // 2. 問い合わせから識別子を外す（件数・区分・時刻だけ残る）。
    db
      .prepare(
        `UPDATE inquiries SET line_user_hash = NULL, ad_ref = NULL
         WHERE (line_user_hash IS NOT NULL OR ad_ref IS NOT NULL)
           AND (ad_ref IN (${dyingClicks}) OR submitted_at <= ?2)`,
      )
      .bind(nowIso, ninetyDaysAgo),
    // 3. 結びつけを消す。
    db
      .prepare(`DELETE FROM line_bindings WHERE expires_at <= ?1 OR ad_ref IN (${dyingClicks})`)
      .bind(nowIso),
    // 4. クリックを消す。
    db.prepare(`DELETE FROM ad_clicks WHERE ad_ref IN (${dyingClicks})`).bind(nowIso),
    // 5. 13か月を過ぎた問い合わせと送信記録を消す。
    db.prepare(`DELETE FROM conversion_uploads WHERE inquiry_id IN (SELECT inquiry_id FROM inquiries WHERE submitted_at <= ?1)`).bind(inquiryCutoff),
    db.prepare(`DELETE FROM inquiries WHERE submitted_at <= ?1`).bind(inquiryCutoff),
    // 6. 回数制限の窓・古い診断。
    db.prepare(`DELETE FROM rate_limits WHERE window_start <= ?1`).bind(addHours(nowIso, -48)),
    db.prepare(`DELETE FROM diag_counters WHERE day <= ?1`).bind(addDays(nowIso, -400).slice(0, 10)),
  ]);

  const changes = (i: number) => results[i]?.meta.changes ?? 0;
  const report: RetentionReport = {
    uploads_expired: changes(0),
    inquiries_scrubbed: changes(1),
    bindings_deleted: changes(2),
    clicks_deleted: changes(3),
    uploads_deleted: changes(4),
    inquiries_deleted: changes(5),
    rate_limits_deleted: changes(6),
  };
  await db
    .prepare(
      `INSERT INTO retention_runs (run_at, clicks_deleted, bindings_deleted, inquiries_scrubbed,
         inquiries_deleted, uploads_expired, uploads_deleted, rate_limits_deleted)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT (run_at) DO NOTHING`,
    )
    .bind(
      nowIso,
      report.clicks_deleted,
      report.bindings_deleted,
      report.inquiries_scrubbed,
      report.inquiries_deleted,
      report.uploads_expired,
      report.uploads_deleted,
      report.rate_limits_deleted,
    )
    .run();
  return report;
}
