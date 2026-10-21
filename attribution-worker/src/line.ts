// LINE の IDトークンをサーバで検証する。
// 一次情報: https://developers.line.biz/en/reference/line-login/#verify-id-token
//   POST https://api.line.me/oauth2/v2.1/verify（id_token, client_id）
// LINE の検証に加えて、iss・aud・exp・sub の形をこちらでも確かめる。
// トークンそのものはログ・DB・エラー文のどこにも出さない。

import { fromBase64Url } from "./crypto";

export const LINE_VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";
const LINE_ISSUER = "https://access.line.me";
const VERIFY_TIMEOUT_MS = 5000;

export type LineVerifyResult =
  | { ok: true; sub: string; aud: string }
  | { ok: false; code: LineVerifyError };

export type LineVerifyError =
  | "token_missing"
  | "token_malformed"
  | "aud_not_allowed"
  | "token_expired"
  | "token_invalid"
  | "verify_unavailable";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 署名を確かめる前の中身。aud（どのチャネルか）を選ぶためだけに読む。 */
function peekAudience(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const raw = fromBase64Url(parts[1]);
  if (!raw) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(raw)) as { aud?: unknown };
    return typeof payload.aud === "string" ? payload.aud : null;
  } catch {
    return null;
  }
}

export async function verifyLineIdToken(
  idToken: unknown,
  allowedChannelIds: string[],
  nowSec: number,
  fetchImpl: FetchLike = fetch,
): Promise<LineVerifyResult> {
  if (typeof idToken !== "string" || idToken.length === 0) return { ok: false, code: "token_missing" };
  if (idToken.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(idToken)) {
    return { ok: false, code: "token_malformed" };
  }
  const aud = peekAudience(idToken);
  if (!aud) return { ok: false, code: "token_malformed" };
  if (!allowedChannelIds.includes(aud)) return { ok: false, code: "aud_not_allowed" };

  let res: Response;
  try {
    res = await fetchImpl(LINE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: idToken, client_id: aud }).toString(),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: "verify_unavailable" };
  }

  if (res.status >= 500 || res.status === 429) return { ok: false, code: "verify_unavailable" };
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, code: res.ok ? "verify_unavailable" : "token_invalid" };
  }
  if (!res.ok) {
    // 例: {"error":"invalid_request","error_description":"IdToken expired."}
    const desc = typeof body.error_description === "string" ? body.error_description.toLowerCase() : "";
    return { ok: false, code: desc.includes("expired") ? "token_expired" : "token_invalid" };
  }

  const sub = body.sub;
  if (body.iss !== LINE_ISSUER) return { ok: false, code: "token_invalid" };
  if (body.aud !== aud) return { ok: false, code: "token_invalid" };
  if (typeof body.exp !== "number" || body.exp <= nowSec) return { ok: false, code: "token_expired" };
  if (typeof sub !== "string" || !/^U[0-9a-f]{32}$/.test(sub)) return { ok: false, code: "token_invalid" };
  return { ok: true, sub, aud };
}
