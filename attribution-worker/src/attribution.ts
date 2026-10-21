// 広告クリックの識別子の形の確認と、帰属の判定（純粋関数）。

import { CLICK_RETENTION_DAYS } from "./config";

export interface ClickIds {
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
}

// Google は形式を公開していないので、URL に載る文字（英数と - _）と長さだけを確かめる。
const CLICK_ID_RE = /^[A-Za-z0-9_-]{16,512}$/;

export function parseClickIds(input: unknown): ClickIds | null {
  if (!input || typeof input !== "object") return null;
  const src = input as Record<string, unknown>;
  const pick = (name: "gclid" | "gbraid" | "wbraid"): string | null | undefined => {
    const v = src[name];
    if (v === undefined || v === null || v === "") return null;
    return typeof v === "string" && CLICK_ID_RE.test(v) ? v : undefined;
  };
  const gclid = pick("gclid");
  const gbraid = pick("gbraid");
  const wbraid = pick("wbraid");
  // 1つでも形が崩れていたら全体を拒否する（改ざんされた URL を部分的に信じない）。
  if (gclid === undefined || gbraid === undefined || wbraid === undefined) return null;
  if (!gclid && !gbraid && !wbraid) return null;
  return { gclid, gbraid, wbraid };
}

export type Attribution = "none" | "ad_same_day" | "ad_delayed" | "expired";

export interface BindingCandidate {
  adRef: string;
  clickAt: string;
  boundAt: string;
  consentAdData: "granted" | "denied";
}

const HOUR_MS = 3_600_000;

/**
 * 最終有効クリック: 問い合わせより前に結びつけられた、最も新しいクリックを採る。
 * - 24時間以内: ad_same_day
 * - 24時間超〜90日以内: ad_delayed
 * - 90日超: expired（Google には送らない）
 */
export function classify(
  submittedAt: string,
  candidates: BindingCandidate[],
): { attribution: Attribution; binding: BindingCandidate | null; hoursFromClick: number | null } {
  const submitted = Date.parse(submittedAt);
  const valid = candidates
    .filter((c) => Date.parse(c.clickAt) <= submitted && Date.parse(c.boundAt) <= submitted)
    .sort((a, b) => Date.parse(b.clickAt) - Date.parse(a.clickAt));
  const latest = valid[0];
  if (!latest) return { attribution: "none", binding: null, hoursFromClick: null };
  const diffMs = submitted - Date.parse(latest.clickAt);
  const hours = Math.floor(diffMs / HOUR_MS);
  if (diffMs > CLICK_RETENTION_DAYS * 24 * HOUR_MS) {
    return { attribution: "expired", binding: null, hoursFromClick: hours };
  }
  return {
    attribution: diffMs <= 24 * HOUR_MS ? "ad_same_day" : "ad_delayed",
    binding: latest,
    hoursFromClick: hours,
  };
}

export function addHours(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * HOUR_MS).toISOString();
}

export function addDays(iso: string, days: number): string {
  return addHours(iso, days * 24);
}

/** Google 広告 API が求める形（yyyy-mm-dd HH:mm:ss+09:00）。日本時間で出す。 */
export function formatJstDateTime(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * HOUR_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+09:00`
  );
}

/** Data Manager API の eventTimestamp（RFC 3339）。日本時間で出す。 */
export function formatJstRfc3339(iso: string): string {
  return formatJstDateTime(iso).replace(" ", "T");
}

export function jstDay(iso: string): string {
  return formatJstDateTime(iso).slice(0, 10);
}
