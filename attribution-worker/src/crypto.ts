// 鍵の派生・HMAC・乱数・セッションの署名。WebCrypto だけを使う。

const enc = new TextEncoder();

export type KeyPurpose = "line-user-hash/v1" | "session/v1" | "rate-key/v1" | "admin/v1";

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/** 元鍵から用途ごとの HMAC 鍵を HKDF で作る。用途が違えば同じ値でも別のハッシュになる。 */
export function deriveKey(rootKey: string, purpose: KeyPurpose): Promise<CryptoKey> {
  const cacheKey = `${purpose}\u0000${rootKey}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey("raw", enc.encode(rootKey), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: enc.encode("oasis-honten-attribution"), info: enc.encode(purpose) },
        base,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign", "verify"],
      );
    })();
    keyCache.set(cacheKey, key);
  }
  return key;
}

export async function hmacHex(rootKey: string, purpose: KeyPurpose, value: string): Promise<string> {
  const key = await deriveKey(rootKey, purpose);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
}

/** 128ビットの乱数（base64url 22文字）。 */
export function randomRef(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export function isRef(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{22}$/.test(value);
}

/** 長さに関係なく、時間差で中身が分からない比較（HMAC して比べる）。 */
export async function safeEqual(rootKey: string, a: string, b: string): Promise<boolean> {
  const key = await deriveKey(rootKey, "admin/v1");
  const [ha, hb] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(a)),
    crypto.subtle.sign("HMAC", key, enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i += 1) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export interface SessionClaims {
  v: 1;
  /** line_user_hash */
  h: string;
  iat: number;
  exp: number;
}

export async function signSession(rootKey: string, claims: SessionClaims): Promise<string> {
  const body = toBase64Url(enc.encode(JSON.stringify(claims)));
  const key = await deriveKey(rootKey, "session/v1");
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${toBase64Url(sig)}`;
}

export async function verifySession(rootKey: string, token: unknown, nowSec: number): Promise<SessionClaims | null> {
  if (typeof token !== "string" || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sigText] = parts;
  const sig = fromBase64Url(sigText);
  if (!sig) return null;
  const key = await deriveKey(rootKey, "session/v1");
  const ok = await crypto.subtle.verify("HMAC", key, sig, enc.encode(body));
  if (!ok) return null;
  const raw = fromBase64Url(body);
  if (!raw) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(raw)) as SessionClaims;
    if (claims.v !== 1 || typeof claims.h !== "string" || !/^[0-9a-f]{64}$/.test(claims.h)) return null;
    if (typeof claims.exp !== "number" || claims.exp <= nowSec) return null;
    return claims;
  } catch {
    return null;
  }
}
