import { env } from "cloudflare:test";
import { readConfig, type Config } from "../src/config";
import type { Deps } from "../src/handlers";
import { handleRequest } from "../src/index";

export const ENTRY_CHANNEL = "1000000001";
export const FORM_CHANNEL = "1000000002";
export const OTHER_CHANNEL = "1999999999";
export const WIX_ORIGIN = "https://www.cuthome-oasis.com";
export const FORM_ORIGIN = "https://zin624.github.io";
export const USER_A = "U" + "a".repeat(32);
export const USER_B = "U" + "b".repeat(32);
export const GCLID = "Cj0KCQjw-test_gclid_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function b64url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** LINE の IDトークンに見える文字列。署名は偽物で、検証は fakeLine が引き受ける。 */
export function idToken(sub: string, aud = FORM_CHANNEL, tag = "ok"): string {
  return `${b64url(JSON.stringify({ alg: "ES256" }))}.${b64url(JSON.stringify({ sub, aud, tag }))}.${b64url("sig-" + tag)}`;
}

export interface FakeLine {
  calls: { idToken: string; clientId: string }[];
  fetch: Deps["fetchImpl"];
}

/** LINE の verify API の代わり。tag で応答を変える（ok / expired / invalid / down / bad_iss）。 */
export function fakeLine(nowSec: () => number): FakeLine {
  const calls: FakeLine["calls"] = [];
  const fetchImpl: Deps["fetchImpl"] = async (_url, init) => {
    const params = new URLSearchParams(String(init?.body ?? ""));
    const token = params.get("id_token") ?? "";
    const clientId = params.get("client_id") ?? "";
    calls.push({ idToken: token, clientId });
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.tag === "down") throw new TypeError("network");
    if (payload.tag === "expired") {
      return Response.json({ error: "invalid_request", error_description: "IdToken expired." }, { status: 400 });
    }
    if (payload.tag === "invalid") {
      return Response.json({ error: "invalid_request", error_description: "Invalid IdToken." }, { status: 400 });
    }
    if (payload.aud !== clientId) {
      return Response.json({ error: "invalid_request", error_description: "Invalid IdToken Audience." }, { status: 400 });
    }
    return Response.json({
      iss: payload.tag === "bad_iss" ? "https://evil.example" : "https://access.line.me",
      sub: payload.sub,
      aud: payload.aud,
      exp: nowSec() + 3600,
      iat: nowSec(),
    });
  };
  return { calls, fetch: fetchImpl };
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return readConfig({
    ATTR_DB: env.ATTR_DB,
    ENV_NAME: "test",
    STORE_ID: "honten",
    AD_ATTR_ENABLED: "true",
    UPLOAD_ENABLED: "true",
    AD_CLICK_ORIGINS: "https://www.cuthome-oasis.com,https://cuthome-oasis.com",
    FORM_ORIGINS: FORM_ORIGIN,
    LANDING_PATHS: "/oasis本店,/本店新規問い合わせ,/本店詳細",
    LINE_CHANNEL_IDS: `${ENTRY_CHANNEL},${FORM_CHANNEL}`,
    BIND_WINDOW_HOURS: "24",
    ATTR_ROOT_KEY: env.ATTR_ROOT_KEY,
    ADMIN_TOKEN: env.ADMIN_TOKEN,
    ...overrides,
  });
}

export class Harness {
  nowMs: number;
  cfg: Config;
  line: FakeLine;
  private ipCounter = 0;

  constructor(start = "2026-11-01T01:00:00.000Z", cfg = testConfig()) {
    this.nowMs = Date.parse(start);
    this.cfg = cfg;
    this.line = fakeLine(() => Math.floor(this.nowMs / 1000));
  }

  get deps(): Deps {
    return { db: env.ATTR_DB, cfg: this.cfg, now: () => new Date(this.nowMs), fetchImpl: this.line.fetch };
  }

  advanceHours(h: number): void {
    this.nowMs += h * 3_600_000;
  }

  nowIso(): string {
    return new Date(this.nowMs).toISOString();
  }

  /** 既定ではリクエストごとに別のIPにして、回数制限を試すテスト以外に影響させない。 */
  async post(path: string, body: unknown, opts: { origin?: string | null; ip?: string; raw?: string } = {}) {
    const headers = new Headers({ "content-type": "text/plain;charset=UTF-8" });
    const origin = opts.origin === undefined ? (path === "/v1/ad-click" ? WIX_ORIGIN : FORM_ORIGIN) : opts.origin;
    if (origin) headers.set("origin", origin);
    headers.set("cf-connecting-ip", opts.ip ?? `198.51.100.${(this.ipCounter += 1) % 250}`);
    const res = await handleRequest(
      new Request(`https://attr.example${path}`, {
        method: "POST",
        headers,
        body: opts.raw ?? JSON.stringify(body),
      }),
      this.deps,
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }

  async adClick(ids: Record<string, string> = { gclid: GCLID }, extra: Record<string, unknown> = {}) {
    return this.post("/v1/ad-click", {
      store: "honten",
      click_ids: ids,
      landing_path: "/%E6%9C%AC%E5%BA%97%E6%96%B0%E8%A6%8F%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B",
      utm: { source: "google", medium: "cpc", campaign: "honten" },
      ...extra,
    });
  }

  async bind(adRef: string, sub = USER_A, opts: { aud?: string; tag?: string; consent?: unknown } = {}) {
    return this.post("/v1/bind", {
      ad_ref: adRef,
      id_token: idToken(sub, opts.aud ?? ENTRY_CHANNEL, opts.tag ?? "ok"),
      consent: "consent" in opts ? opts.consent : { ad_data: "granted", version: "2026-10-21" },
    });
  }

  async session(sub = USER_A, opts: { aud?: string; tag?: string } = {}) {
    return this.post("/v1/session", { id_token: idToken(sub, opts.aud ?? FORM_CHANNEL, opts.tag ?? "ok") });
  }

  async inquiry(session: string, inquiryId = crypto.randomUUID(), extra: Record<string, unknown> = {}) {
    return { inquiryId, res: await this.post("/v1/inquiry", { session, inquiry_id: inquiryId, ...extra }) };
  }

  /** 広告クリック → 結びつけ → セッション、までを1回で。 */
  async adUser(sub = USER_A): Promise<{ adRef: string; session: string }> {
    const click = await this.adClick();
    await this.bind(click.body.ad_ref, sub);
    const s = await this.session(sub);
    return { adRef: click.body.ad_ref, session: s.body.session };
  }
}

export async function rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await env.ATTR_DB.prepare(sql).bind(...params).all<T>();
  return results;
}

/** すべての表の中身を1つの文字列にする（個人情報が入っていないかを見る）。 */
export async function dumpAllTables(): Promise<string> {
  const tables = await rows<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'`,
  );
  let out = "";
  for (const t of tables) out += JSON.stringify(await rows(`SELECT * FROM ${t.name}`));
  return out;
}

export async function resetDb(): Promise<void> {
  await env.ATTR_DB.batch(
    ["conversion_uploads", "inquiries", "line_bindings", "ad_clicks", "rate_limits", "diag_counters", "retention_runs"].map(
      (t) => env.ATTR_DB.prepare(`DELETE FROM ${t}`),
    ),
  );
}
