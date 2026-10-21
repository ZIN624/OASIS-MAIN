// 応答・CORS・本文の読み取り。
// CORS はブラウザに読ませてよい相手を決めるだけで、認証ではない。
// 本当の守りは IDトークンの検証・セッションの署名・回数制限（handlers）。

import { MAX_BODY_BYTES } from "./config";

export function json(status: number, body: unknown, origin: string | null = null): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function preflight(origin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
      vary: "Origin",
    },
  });
}

/** 許可した Origin だけを返す。無い・違うときは null。 */
export function allowedOrigin(request: Request, allowed: string[]): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  return allowed.includes(origin) ? origin : null;
}

/**
 * 本文を JSON として読む。プリフライトを避けるため text/plain でも受け付ける。
 * 上限を超える・JSON でない・オブジェクトでないときは null。
 */
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > MAX_BODY_BYTES) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(buf));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}
