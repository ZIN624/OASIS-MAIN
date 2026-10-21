// 予約フォーム（index.html）・入口ページ（entry.html）を jsdom で開き、LIFF・gtag・fetch を差し替えて動かす。
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { vi } from "vitest";

/** 調べる版。既定はこのリポジトリ。FORM_ROOT=… で main の写しなど別の場所を指せる。 */
export const ROOT = resolve(process.env.FORM_ROOT ?? join(__dirname, "..", ".."));
export const ENDPOINT = "https://attr.example";
export const ENTRY_LIFF_ID = "1000000001-AbCdEfGh";

export interface FakeLiffOptions {
  inClient?: boolean;
  loggedIn?: boolean;
  idToken?: string | null;
  expSec?: number;
  initFails?: boolean;
  send?: () => Promise<unknown>;
}

export function fakeLiff(opts: FakeLiffOptions = {}) {
  return {
    init: vi.fn(() => (opts.initFails ? Promise.reject(new Error("init failed")) : Promise.resolve())),
    isInClient: vi.fn(() => opts.inClient ?? true),
    isLoggedIn: vi.fn(() => opts.loggedIn ?? true),
    login: vi.fn(),
    getIDToken: vi.fn(() => (opts.idToken === undefined ? "header.payload.sig" : opts.idToken)),
    getDecodedIDToken: vi.fn(() => ({ exp: opts.expSec ?? Math.floor(Date.now() / 1000) + 3600 })),
    sendMessages: vi.fn(opts.send ?? (() => Promise.resolve())),
    closeWindow: vi.fn(),
  };
}

export type FetchHandler = (url: string, init: RequestInit) => Promise<{ status: number; body?: unknown }>;

export function fakeFetch(handler: FetchHandler) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const r = await handler(url, init);
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => r.body ?? {},
    };
  });
}

export interface LoadOptions {
  page?: "index.html" | "entry.html";
  url?: string;
  liff?: ReturnType<typeof fakeLiff> | null;
  fetch?: ReturnType<typeof fakeFetch>;
  /** attribution-config.js の endpoint / entryLiffId を入れるか（既定は入れない＝いまの本番と同じ） */
  configured?: boolean;
  storage?: Record<string, string>;
  /** 読み込む前にソースを書き換える（jsdom では移動できない location.assign を差し替えるときだけ使う）。 */
  transform?: (src: string, code: string) => string;
}

export async function loadPage(opts: LoadOptions = {}) {
  const page = opts.page ?? "index.html";
  const html = readFileSync(join(ROOT, page), "utf8");
  const dom = new JSDOM(html, {
    url: opts.url ?? `https://zin624.github.io/OASIS-MAIN/${page === "index.html" ? "" : page}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window as unknown as Window & typeof globalThis & Record<string, any>;
  for (const [k, v] of Object.entries(opts.storage ?? {})) w.localStorage.setItem(k, v);
  w.alert = vi.fn();
  w.scrollTo = vi.fn();
  w.HTMLElement.prototype.scrollIntoView = vi.fn();
  if (opts.liff !== null) w.liff = opts.liff ?? fakeLiff();
  w.fetch = opts.fetch ?? fakeFetch(async () => ({ status: 200 }));
  const gtagCalls: unknown[][] = [];
  w.gtag = vi.fn((...args: unknown[]) => {
    gtagCalls.push(args);
    const params = args[2] as { event_callback?: () => void } | undefined;
    if (params?.event_callback) setTimeout(params.event_callback, 5);
  });

  // index.html の順番どおりに、ローカルの script だけを実行する（LINE の SDK は fakeLiff で代わりにする）。
  const srcs = [...html.matchAll(/<script[^>]*src="\.?\/?(js\/[^"]+)"/g)].map((m) => m[1]);
  for (const src of srcs) {
    const path = join(ROOT, src);
    if (!existsSync(path)) continue;
    let code = readFileSync(path, "utf8");
    if (src === "js/attribution-config.js" && opts.configured) {
      code = code.replace('endpoint: ""', `endpoint: "${ENDPOINT}"`).replace('entryLiffId: ""', `entryLiffId: "${ENTRY_LIFF_ID}"`);
    }
    if (opts.transform) code = opts.transform(src, code);
    w.eval(code);
  }
  // jsdom は解析のあとで DOMContentLoaded を自分で出す。まだなら待ち、済んでいたら自分で出す（二重に出さない）。
  if (w.document.readyState === "loading") {
    await new Promise((resolve) => w.document.addEventListener("DOMContentLoaded", resolve, { once: true }));
  } else {
    w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  }
  return { dom, w, doc: w.document, gtagCalls };
}

export const CUSTOMER = { username: "オアシス太郎", furigana: "オアシスタロウ", gender: "男性", phoneNumber: "09012345678" };

export function returningCustomerStorage(extra: Record<string, string> = {}) {
  return { oasis_customer_info: JSON.stringify(CUSTOMER), customerStatus: "再来", ...extra };
}

/** 再来のお客様が「はい（前回と同じ）」→ 日程・メニュー・担当を選んで確認画面へ進む。 */
export function fillAndConfirm(doc: Document): string {
  (doc.getElementById("existingSameBtn") as HTMLButtonElement).click();
  const day1 = doc.getElementById("day1") as HTMLSelectElement;
  const open = [...day1.options].find((o) => !o.disabled && o.value);
  if (!open) throw new Error("no open day");
  day1.value = open.value;
  (doc.getElementById("menu") as HTMLTextAreaElement).value = "カット";
  (doc.querySelector('.stylist-card[data-stylist="店長"]') as HTMLElement).click();
  (doc.getElementById("submitReservation") as HTMLButtonElement).click();
  (doc.getElementById("agreeCheckbox") as HTMLInputElement).checked = true;
  return open.value;
}

export function pressSend(doc: Document) {
  (doc.getElementById("submitbtn") as HTMLButtonElement).click();
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
