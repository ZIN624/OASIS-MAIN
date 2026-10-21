// OASIS本店 LINE予約希望の広告帰属 Worker。
// 予約の受付（LINE への送信）はこの Worker を通らない。ここが止まっても予約は止まらない。

import { readConfig, type Env } from "./config";
import { handleAdClick, handleBind, handleDiagnostics, handleInquiry, handleSession, type Deps } from "./handlers";
import { allowedOrigin, json, preflight } from "./http";
import { runRetention } from "./retention";
import { countDiag } from "./store";
import { createDataManagerSender } from "./data-manager";
import { runUploadPass } from "./uploads";

const POST_ROUTES = {
  "/v1/ad-click": { handler: handleAdClick, origins: "ad" },
  "/v1/bind": { handler: handleBind, origins: "form" },
  "/v1/session": { handler: handleSession, origins: "form" },
  "/v1/inquiry": { handler: handleInquiry, origins: "form" },
} as const;

/** 日本時間 4 時台に削除を回す。 */
const RETENTION_UTC_HOUR = 19;

export async function handleRequest(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/v1/admin/diagnostics" && request.method === "GET") {
    return handleDiagnostics(request, deps);
  }

  const route = POST_ROUTES[path as keyof typeof POST_ROUTES];
  if (!route) return json(404, { ok: false, error: "not_found" });
  const origins = route.origins === "ad" ? deps.cfg.adClickOrigins : deps.cfg.formOrigins;
  const origin = allowedOrigin(request, origins);

  if (request.method === "OPTIONS") {
    return origin ? preflight(origin) : new Response(null, { status: 403 });
  }
  if (request.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" }, origin);

  if (!deps.cfg.enabled) {
    // 停止スイッチ。Wix はこれを見て、いつもの LINE リンクのままにする。
    await countDiag(deps.db, "disabled", deps.now().toISOString());
    return json(503, { ok: false, enabled: false }, origin);
  }
  try {
    return await route.handler(request, deps);
  } catch {
    // 中身（リクエスト・トークン）はログに出さない。場所だけ。
    console.error(JSON.stringify({ event: "handler_error", path }));
    return json(500, { ok: false, error: "internal" }, origin);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const deps: Deps = { db: env.ATTR_DB, cfg: readConfig(env), now: () => new Date(), fetchImpl: fetch };
    return handleRequest(request, deps);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = new Date(controller.scheduledTime);
    const cfg = readConfig(env);
    // 削除はスイッチに関係なく回す（止めたあとも、残ったデータを期限どおりに消すため）。
    if (now.getUTCHours() === RETENTION_UTC_HOUR) {
      const report = await runRetention(env.ATTR_DB, now);
      console.log(JSON.stringify({ event: "retention", ...report }));
    }
    // 送信先の設定（DM_*）とサービスアカウントの鍵がそろわない限り sender は null で、何も送らない。
    const sender = createDataManagerSender(cfg.dataManager, env.GOOGLE_SA_KEY_JSON, fetch, () => Math.floor(Date.now() / 1000));
    const upload = await runUploadPass(env.ATTR_DB, cfg, sender, now);
    console.log(JSON.stringify({ event: "upload_pass", ...upload }));
  },
};
