// 受付API。どの処理も、失敗したら「何も記録しない」側に倒す。

import { addDays, addHours, classify, parseClickIds, type BindingCandidate } from "./attribution";
import {
  CLICK_RETENTION_DAYS,
  FIRST_UPLOAD_AFTER_CLICK_HOURS,
  normalizePath,
  RESEND_MAX_AGE_DAYS,
  SESSION_TTL_HOURS,
  type Config,
} from "./config";
import { hmacHex, isRef, randomRef, safeEqual, signSession, verifySession } from "./crypto";
import { allowedOrigin, clientIp, json, readJsonBody } from "./http";
import { verifyLineIdToken, type FetchLike } from "./line";
import { countDiag, takeRate, type RateBucket } from "./store";

export interface Deps {
  db: D1Database;
  cfg: Config;
  now: () => Date;
  fetchImpl: FetchLike;
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONSENT_VERSION_RE = /^\d{4}-\d{2}-\d{2}[a-z0-9-]{0,20}$/;

function shortText(value: unknown, max = 100): string | null {
  if (typeof value !== "string") return null;
  const t = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return t ? t.slice(0, max) : null;
}

async function guard(
  request: Request,
  deps: Deps,
  origins: string[],
  bucket: RateBucket,
): Promise<{ origin: string } | Response> {
  const nowIso = deps.now().toISOString();
  const origin = allowedOrigin(request, origins);
  if (!origin) {
    await countDiag(deps.db, "origin_rejected", nowIso);
    return json(403, { ok: false, error: "forbidden" });
  }
  const rootKey = deps.cfg.rootKey as string;
  if (!(await takeRate(deps.db, rootKey, bucket, clientIp(request), deps.now().getTime()))) {
    await countDiag(deps.db, "rate_limited", nowIso);
    return json(429, { ok: false, error: "rate_limited" }, origin);
  }
  return { origin };
}

/** LINE 側の障害は 503（入口ページは通常の導線へ進む）、トークンの問題は 401。 */
function lineErrorStatus(code: string): number {
  return code === "verify_unavailable" ? 503 : 401;
}

async function lineUserHash(deps: Deps, idToken: unknown): Promise<{ hash: string } | { error: string }> {
  const nowIso = deps.now().toISOString();
  const result = await verifyLineIdToken(
    idToken,
    deps.cfg.lineChannelIds,
    Math.floor(deps.now().getTime() / 1000),
    deps.fetchImpl,
  );
  if (!result.ok) {
    await countDiag(deps.db, `line_${result.code}`, nowIso);
    return { error: result.code };
  }
  return { hash: await hmacHex(deps.cfg.rootKey as string, "line-user-hash/v1", result.sub) };
}

/** POST /v1/ad-click … Wix の本店ページから。クリック識別子を受け取り、ad_ref を返す。 */
export async function handleAdClick(request: Request, deps: Deps): Promise<Response> {
  const g = await guard(request, deps, deps.cfg.adClickOrigins, "ad_click");
  if (g instanceof Response) return g;
  const nowIso = deps.now().toISOString();
  const body = await readJsonBody(request);
  const reject = async (code = "ad_click_rejected" as const) => {
    await countDiag(deps.db, code, nowIso);
    return json(400, { ok: false, error: "invalid_request" }, g.origin);
  };
  if (!body || body.store !== deps.cfg.store) return reject();

  const path = typeof body.landing_path === "string" ? normalizePath(body.landing_path.slice(0, 300)) : "";
  if (!deps.cfg.landingPaths.includes(path)) {
    await countDiag(deps.db, "ad_click_path_rejected", nowIso);
    return json(400, { ok: false, error: "invalid_request" }, g.origin);
  }
  const ids = parseClickIds(body.click_ids);
  if (!ids) return reject();

  const utm = body.utm && typeof body.utm === "object" ? (body.utm as Record<string, unknown>) : {};
  const adRef = randomRef();
  const expiresAt = addDays(nowIso, CLICK_RETENTION_DAYS);
  const bindExpiresAt = addHours(nowIso, deps.cfg.bindWindowHours);
  await deps.db
    .prepare(
      `INSERT INTO ad_clicks (ad_ref, store, gclid, gbraid, wbraid, landing_path,
         utm_source, utm_medium, utm_campaign, first_seen_at, expires_at, bind_expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(
      adRef,
      deps.cfg.store,
      ids.gclid,
      ids.gbraid,
      ids.wbraid,
      path,
      shortText(utm.source),
      shortText(utm.medium),
      shortText(utm.campaign),
      nowIso,
      expiresAt,
      bindExpiresAt,
    )
    .run();
  await countDiag(deps.db, "ad_click_ok", nowIso);
  return json(201, { ok: true, ad_ref: adRef, bind_expires_at: bindExpiresAt }, g.origin);
}

/** POST /v1/bind … LIFF の入口ページから。IDトークンを検証し、LINE の利用者と ad_ref を結ぶ。 */
export async function handleBind(request: Request, deps: Deps): Promise<Response> {
  const g = await guard(request, deps, deps.cfg.formOrigins, "bind");
  if (g instanceof Response) return g;
  const nowIso = deps.now().toISOString();
  const body = await readJsonBody(request);
  const consent = body?.consent && typeof body.consent === "object" ? (body.consent as Record<string, unknown>) : null;
  if (
    !body ||
    !isRef(body.ad_ref) ||
    !consent ||
    consent.ad_data !== "granted" ||
    typeof consent.version !== "string" ||
    !CONSENT_VERSION_RE.test(consent.version)
  ) {
    return json(400, { ok: false, error: "invalid_request" }, g.origin);
  }

  const click = await deps.db
    .prepare(`SELECT ad_ref, store, expires_at, bind_expires_at FROM ad_clicks WHERE ad_ref = ?1`)
    .bind(body.ad_ref)
    .first<{ ad_ref: string; store: string; expires_at: string; bind_expires_at: string }>();
  if (!click || click.store !== deps.cfg.store) {
    await countDiag(deps.db, "bind_ref_unknown", nowIso);
    return json(404, { ok: false, error: "invalid_ref" }, g.origin);
  }
  if (click.bind_expires_at <= nowIso) {
    await countDiag(deps.db, "bind_ref_expired", nowIso);
    return json(410, { ok: false, error: "ref_expired" }, g.origin);
  }

  const user = await lineUserHash(deps, body.id_token);
  if ("error" in user) return json(lineErrorStatus(user.error), { ok: false, error: user.error }, g.origin);

  const existing = await deps.db
    .prepare(`SELECT line_user_hash FROM line_bindings WHERE ad_ref = ?1`)
    .bind(click.ad_ref)
    .first<{ line_user_hash: string }>();
  if (existing) {
    if (existing.line_user_hash === user.hash) return json(200, { ok: true }, g.origin);
    await countDiag(deps.db, "bind_ref_taken", nowIso);
    return json(409, { ok: false, error: "ref_taken" }, g.origin);
  }

  await deps.db.batch([
    deps.db
      .prepare(
        `INSERT INTO line_bindings (ad_ref, line_user_hash, bound_at, expires_at, consent_ad_data, consent_version)
         VALUES (?1, ?2, ?3, ?4, 'granted', ?5) ON CONFLICT (ad_ref) DO NOTHING`,
      )
      .bind(click.ad_ref, user.hash, nowIso, click.expires_at, consent.version),
    deps.db.prepare(`UPDATE ad_clicks SET bound_at = ?2 WHERE ad_ref = ?1 AND bound_at IS NULL`).bind(click.ad_ref, nowIso),
  ]);
  // 同時に2人が結ぼうとしたときは、先に入った方だけが有効。
  const winner = await deps.db
    .prepare(`SELECT line_user_hash FROM line_bindings WHERE ad_ref = ?1`)
    .bind(click.ad_ref)
    .first<{ line_user_hash: string }>();
  if (winner?.line_user_hash !== user.hash) {
    await countDiag(deps.db, "bind_ref_taken", nowIso);
    return json(409, { ok: false, error: "ref_taken" }, g.origin);
  }
  await countDiag(deps.db, "bind_ok", nowIso);
  return json(200, { ok: true }, g.origin);
}

/** POST /v1/session … 予約フォームを開いたとき。IDトークン（1時間で切れる）を、12時間の印に替える。 */
export async function handleSession(request: Request, deps: Deps): Promise<Response> {
  const g = await guard(request, deps, deps.cfg.formOrigins, "session");
  if (g instanceof Response) return g;
  const nowIso = deps.now().toISOString();
  const body = await readJsonBody(request);
  if (!body) return json(400, { ok: false, error: "invalid_request" }, g.origin);
  const user = await lineUserHash(deps, body.id_token);
  if ("error" in user) return json(lineErrorStatus(user.error), { ok: false, error: user.error }, g.origin);
  const iat = Math.floor(deps.now().getTime() / 1000);
  const exp = iat + SESSION_TTL_HOURS * 3600;
  const session = await signSession(deps.cfg.rootKey as string, { v: 1, h: user.hash, iat, exp });
  await countDiag(deps.db, "session_ok", nowIso);
  return json(200, { ok: true, session, expires_at: new Date(exp * 1000).toISOString() }, g.origin);
}

/**
 * POST /v1/inquiry … LINE への送信が成功した「あと」にフォームが呼ぶ。
 * サーバは LINE のトークを見られないので、ここで分かるのは「本人のフォームが成功を報告した」ことまで。
 * 水増しを抑えるため、同じ広告クリックからの予約希望は1件だけ送信の対象にする（記録はすべて残す）。
 */
export async function handleInquiry(request: Request, deps: Deps): Promise<Response> {
  const g = await guard(request, deps, deps.cfg.formOrigins, "inquiry");
  if (g instanceof Response) return g;
  const now = deps.now();
  const nowIso = now.toISOString();
  const body = await readJsonBody(request);
  const bad = async () => {
    await countDiag(deps.db, "inquiry_rejected", nowIso);
    return json(400, { ok: false, error: "invalid_request" }, g.origin);
  };
  if (!body || typeof body.inquiry_id !== "string" || !UUID_V4_RE.test(body.inquiry_id)) return bad();

  const claims = await verifySession(deps.cfg.rootKey as string, body.session, Math.floor(now.getTime() / 1000));
  if (!claims) {
    await countDiag(deps.db, "inquiry_session_invalid", nowIso);
    return json(401, { ok: false, error: "session_invalid" }, g.origin);
  }

  let submittedAt = nowIso;
  if (body.submitted_at !== undefined) {
    const t = typeof body.submitted_at === "string" ? Date.parse(body.submitted_at) : NaN;
    if (!Number.isFinite(t)) return bad();
    if (t > now.getTime() + 5 * 60_000 || t < now.getTime() - RESEND_MAX_AGE_DAYS * 86_400_000) return bad();
    submittedAt = new Date(t).toISOString();
  }
  const resent = body.resent === true ? 1 : 0;
  const inquiryId = body.inquiry_id;

  if (!(await takeRate(deps.db, deps.cfg.rootKey as string, "inquiry_user", claims.h, now.getTime()))) {
    await countDiag(deps.db, "rate_limited", nowIso);
    return json(429, { ok: false, error: "rate_limited" }, g.origin);
  }

  const dup = await deps.db.prepare(`SELECT 1 AS x FROM inquiries WHERE inquiry_id = ?1`).bind(inquiryId).first();
  if (dup) {
    await countDiag(deps.db, "inquiry_duplicate", nowIso);
    return json(200, { ok: true }, g.origin);
  }

  const { results } = await deps.db
    .prepare(
      `SELECT b.ad_ref AS adRef, c.first_seen_at AS clickAt, b.bound_at AS boundAt, b.consent_ad_data AS consentAdData
       FROM line_bindings b JOIN ad_clicks c ON c.ad_ref = b.ad_ref
       WHERE b.line_user_hash = ?1 AND c.store = ?2`,
    )
    .bind(claims.h, deps.cfg.store)
    .all<BindingCandidate>();
  const verdict = classify(submittedAt, results);
  const attributed = verdict.binding !== null;

  const stmts = [
    deps.db
      .prepare(
        `INSERT INTO inquiries (inquiry_id, store, line_user_hash, ad_ref, attribution, hours_from_click,
           submitted_at, received_at, resent)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT (inquiry_id) DO NOTHING`,
      )
      .bind(
        inquiryId,
        deps.cfg.store,
        attributed ? claims.h : null,
        attributed ? verdict.binding!.adRef : null,
        verdict.attribution,
        verdict.hoursFromClick,
        submittedAt,
        nowIso,
        resent,
      ),
  ];
  if (attributed) {
    const binding = verdict.binding!;
    const base = binding.consentAdData === "granted" ? "pending" : "blocked_consent";
    // クリックの直後は Google がまだ処理していないことがある。早くてもクリックの6時間後に送る。
    const notBefore = addHours(binding.clickAt, FIRST_UPLOAD_AFTER_CLICK_HOURS);
    // 同じ広告クリックの2件目は送らない（Google の「1回」の数え方と同じ。gbraid/wbraid は「1回」にできないため、ここで防ぐ）。
    // 同じクリックの判定: 同じ ad_ref か、同じ gclid / gbraid / wbraid。判定と書き込みは1つの batch（トランザクション）。
    stmts.push(
      deps.db
        .prepare(
          `INSERT INTO conversion_uploads (inquiry_id, store, status, conversion_at, deadline_at,
             attempts, next_attempt_at, created_at, updated_at)
           SELECT ?1, ?2,
             CASE
               WHEN ?3 <> 'pending' THEN ?3
               WHEN EXISTS (
                 SELECT 1 FROM conversion_uploads u
                 JOIN inquiries i ON i.inquiry_id = u.inquiry_id
                 JOIN ad_clicks c ON c.ad_ref = i.ad_ref
                 JOIN ad_clicks me ON me.ad_ref = ?4
                 WHERE u.inquiry_id <> ?1
                   AND u.status IN ('pending', 'retry', 'submitted', 'uploaded', 'duplicate')
                   AND (c.ad_ref = me.ad_ref OR c.gclid = me.gclid OR c.gbraid = me.gbraid OR c.wbraid = me.wbraid)
               ) THEN 'suppressed_duplicate'
               ELSE 'pending'
             END,
             ?5, ?6, 0, CASE WHEN ?7 > ?8 THEN ?7 ELSE NULL END, ?8, ?8
           WHERE EXISTS (SELECT 1 FROM inquiries WHERE inquiry_id = ?1 AND received_at = ?8)
           ON CONFLICT (inquiry_id) DO NOTHING`,
        )
        .bind(
          inquiryId,
          deps.cfg.store,
          base,
          binding.adRef,
          submittedAt,
          addDays(binding.clickAt, CLICK_RETENTION_DAYS),
          notBefore,
          nowIso,
        ),
    );
  }
  await deps.db.batch(stmts);

  await countDiag(deps.db, resent ? "inquiry_resent" : "inquiry_ok", nowIso);
  if (attributed) {
    const row = await deps.db
      .prepare(`SELECT status FROM conversion_uploads WHERE inquiry_id = ?1`)
      .bind(inquiryId)
      .first<{ status: string }>();
    await countDiag(
      deps.db,
      row?.status === "suppressed_duplicate" ? "inquiry_suppressed_duplicate" : "inquiry_attributed",
      nowIso,
    );
  }
  return json(200, { ok: true }, g.origin);
}

/** GET /v1/admin/diagnostics … 件数だけを返す（識別子は返さない）。 */
export async function handleDiagnostics(request: Request, deps: Deps): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const { adminToken, rootKey } = deps.cfg;
  if (!adminToken || !rootKey || !token || !(await safeEqual(rootKey, token, adminToken))) {
    return json(401, { ok: false, error: "unauthorized" });
  }
  if (!(await takeRate(deps.db, rootKey, "admin", clientIp(request), deps.now().getTime()))) {
    return json(429, { ok: false, error: "rate_limited" });
  }
  const one = async (sql: string) => {
    const { results } = await deps.db.prepare(sql).all();
    return results;
  };
  const since = addDays(deps.now().toISOString(), -30).slice(0, 10);
  return json(200, {
    ok: true,
    env: deps.cfg.envName,
    enabled: deps.cfg.enabled,
    upload_enabled: deps.cfg.uploadEnabled,
    totals: {
      ad_clicks: await one(`SELECT COUNT(*) AS n, COUNT(bound_at) AS bound FROM ad_clicks`),
      inquiries: await one(`SELECT attribution, COUNT(*) AS n FROM inquiries GROUP BY attribution`),
      uploads: await one(`SELECT status, COUNT(*) AS n FROM conversion_uploads GROUP BY status`),
      upload_errors: await one(
        `SELECT last_error_code AS code, COUNT(*) AS n FROM conversion_uploads
         WHERE last_error_code IS NOT NULL GROUP BY last_error_code`,
      ),
    },
    daily: await deps.db
      .prepare(`SELECT day, code, count FROM diag_counters WHERE day >= ?1 ORDER BY day DESC, code`)
      .bind(since)
      .all()
      .then((r) => r.results),
    retention_runs: await one(`SELECT * FROM retention_runs ORDER BY run_at DESC LIMIT 10`),
  });
}
