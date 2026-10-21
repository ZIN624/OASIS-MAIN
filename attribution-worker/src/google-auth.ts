// Google のサービスアカウントで、Data Manager API 用のアクセストークンを取る（OAuth 2.0 の JWT ベアラー）。
// 一次情報: https://developers.google.com/identity/protocols/oauth2/service-account#httprest
// 鍵（GOOGLE_SA_KEY_JSON）は Cloudflare の Secret にだけ置く。鍵・JWT・トークンはログにもエラー文にも出さない。

import { toBase64Url } from "./crypto";
import type { FetchLike } from "./line";

export const DATA_MANAGER_SCOPE = "https://www.googleapis.com/auth/datamanager";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_TIMEOUT_MS = 10_000;

export type TokenResult = { ok: true; accessToken: string } | { ok: false; kind: "auth_error" | "transient"; code: string };

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

/** 鍵の JSON を読む。形が違えば null（送信しない）。token_uri は固定にして、別のサーバへ署名を送らない。 */
export function parseServiceAccountKey(json: string | undefined): ServiceAccountKey | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    if (v.type !== "service_account") return null;
    if (typeof v.client_email !== "string" || !/^[^@\s]+@[a-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(v.client_email)) return null;
    if (typeof v.private_key !== "string" || !v.private_key.includes("BEGIN PRIVATE KEY")) return null;
    if (v.token_uri !== undefined && v.token_uri !== GOOGLE_TOKEN_URL) return null;
    return {
      client_email: v.client_email,
      private_key: v.private_key,
      private_key_id: typeof v.private_key_id === "string" ? v.private_key_id : undefined,
    };
  } catch {
    return null;
  }
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function signJwt(key: ServiceAccountKey, nowSec: number): Promise<string> {
  const enc = new TextEncoder();
  const header = { alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) };
  const claims = { iss: key.client_email, scope: DATA_MANAGER_SCOPE, aud: GOOGLE_TOKEN_URL, iat: nowSec, exp: nowSec + 3600 };
  const input = `${toBase64Url(enc.encode(JSON.stringify(header)))}.${toBase64Url(enc.encode(JSON.stringify(claims)))}`;
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(key.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, enc.encode(input));
  return `${input}.${toBase64Url(new Uint8Array(sig))}`;
}

export async function fetchAccessToken(key: ServiceAccountKey, nowSec: number, fetchImpl: FetchLike): Promise<TokenResult> {
  let assertion: string;
  try {
    assertion = await signJwt(key, nowSec);
  } catch {
    // 鍵が壊れている。人が直すまで送らない。
    return { ok: false, kind: "auth_error", code: "sa_key_invalid" };
  }
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, kind: "transient", code: "token_network" };
  }
  if (res.status >= 500 || res.status === 429) return { ok: false, kind: "transient", code: `token_http_${res.status}` };
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // 下で扱う
  }
  if (!res.ok) {
    // invalid_grant（鍵の失効・削除）・unauthorized_client など。どれも人が直すもの。
    const err = typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : "unknown";
    return { ok: false, kind: "auth_error", code: `token_${err}` };
  }
  if (typeof body.access_token !== "string" || body.access_token.length < 10) {
    return { ok: false, kind: "transient", code: "token_bad_response" };
  }
  return { ok: true, accessToken: body.access_token };
}
