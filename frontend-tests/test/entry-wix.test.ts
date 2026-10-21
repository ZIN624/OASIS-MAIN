import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { ENDPOINT, ENTRY_LIFF_ID, ROOT, fakeFetch, fakeLiff, loadPage, wait } from "./page";

const AD_REF = "AbCdEfGhIjKlMnOpQrStUv";
const LINE_URL = "https://line.me/R/ti/p/%40nlx8658m";

async function openEntry(opts: { search?: string; liff?: ReturnType<typeof fakeLiff>; fetch?: ReturnType<typeof fakeFetch>; configured?: boolean } = {}) {
  const assign = vi.fn();
  const page = await loadPage({
    page: "entry.html",
    url: `https://zin624.github.io/OASIS-MAIN/entry.html${opts.search ?? `?ad_ref=${AD_REF}`}`,
    liff: opts.liff,
    fetch: opts.fetch,
    configured: opts.configured ?? true,
    // jsdom では別のサイトへ移動できないので、行き先だけを受け取る。
    transform: (src, code) => (src === "js/entry.js" ? code.replace("window.location.assign(LINE_URL)", "window.__nav(LINE_URL)") : code),
  });
  page.w.__nav = assign;
  await wait(10);
  return { ...page, assign };
}

describe("入口ページ（entry.html）", () => {
  it("同意したら IDトークンと ad_ref を結びつけに送り、そのあと LINE の友だち追加へ進む", async () => {
    const bodies: any[] = [];
    const fetch = fakeFetch(async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return { status: 200, body: { ok: true } };
    });
    const { doc, assign } = await openEntry({ fetch });
    expect((doc.getElementById("entryConsent") as HTMLElement).hidden).toBe(false);
    (doc.getElementById("entryAgree") as HTMLButtonElement).click();
    await wait(20);
    expect(fetch.mock.calls[0][0]).toBe(`${ENDPOINT}/v1/bind`);
    expect(bodies[0]).toEqual({ ad_ref: AD_REF, id_token: "header.payload.sig", consent: { ad_data: "granted", version: "2026-10-21" } });
    expect(assign).toHaveBeenCalledWith(LINE_URL);
  });

  it("同意しなければ何も送らずに LINE へ進む", async () => {
    const fetch = fakeFetch(async () => ({ status: 200 }));
    const { doc, assign } = await openEntry({ fetch });
    (doc.getElementById("entryDecline") as HTMLButtonElement).click();
    await wait(10);
    expect(fetch).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith(LINE_URL);
  });

  it("結びつけが失敗・応答が遅くても、LINE へ進む", async () => {
    const down = fakeFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const a = await openEntry({ fetch: down });
    (a.doc.getElementById("entryAgree") as HTMLButtonElement).click();
    await wait(20);
    expect(a.assign).toHaveBeenCalledWith(LINE_URL);

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const hang = fakeFetch(() => new Promise(() => {}));
      const b = await (async () => {
        const p = openEntry({ fetch: hang });
        await vi.advanceTimersByTimeAsync(20);
        return p;
      })();
      (b.doc.getElementById("entryAgree") as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(4100);
      expect(b.assign).toHaveBeenCalledWith(LINE_URL);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ad_ref が無い・形が崩れていれば、同意を聞かずに LINE のリンクだけを出す", async () => {
    for (const search of ["", "?ad_ref=short", "?ad_ref=%3Cscript%3E"]) {
      const fetch = fakeFetch(async () => ({ status: 200 }));
      const { doc } = await openEntry({ search, fetch });
      expect((doc.getElementById("entryConsent") as HTMLElement).hidden).toBe(true);
      expect((doc.getElementById("entryFallback") as HTMLElement).hidden).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("LINE の外（ログインしていない）ならログインへ。戻り先はこのページ", async () => {
    const liff = fakeLiff({ loggedIn: false });
    await openEntry({ liff });
    expect(liff.login).toHaveBeenCalledWith({ redirectUri: `https://zin624.github.io/OASIS-MAIN/entry.html?ad_ref=${AD_REF}` });
  });

  it("設定が空・LIFF の初期化に失敗したら、LINE のリンクだけを出す", async () => {
    const a = await openEntry({ configured: false });
    expect((a.doc.getElementById("entryFallback") as HTMLAnchorElement).hidden).toBe(false);
    expect((a.doc.getElementById("entryFallback") as HTMLAnchorElement).href).toBe(LINE_URL);
    const b = await openEntry({ liff: fakeLiff({ initFails: true }) });
    expect((b.doc.getElementById("entryConsent") as HTMLElement).hidden).toBe(true);
  });

  it("このページは解析タグ（GA4・Clarity）を読み込まない・画面に絵文字を出さない", () => {
    const html = readFileSync(join(ROOT, "entry.html"), "utf8");
    expect(html).not.toMatch(/googletagmanager|clarity\.ms/);
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

// ---- Wix のカスタムコード案 ----

function wixScript(configured = true): string {
  const html = readFileSync(join(ROOT, "wix", "honten-ad-entry.html"), "utf8");
  let code = html.match(/<script>([\s\S]*)<\/script>/)![1];
  if (configured) {
    code = code.replace('endpoint: ""', `endpoint: "${ENDPOINT}"`).replace('entryLiffId: ""', `entryLiffId: "${ENTRY_LIFF_ID}"`);
  }
  return code;
}

async function openWix(search: string, opts: { fetch?: ReturnType<typeof fakeFetch>; consent?: unknown; configured?: boolean; path?: string } = {}) {
  const dom = new JSDOM(
    `<!doctype html><body>
      <a id="line1" href="https://line.me/R/ti/p/%40nlx8658m">LINEで予約</a>
      <a id="line2" href="https://line.me/R/ti/p/@nlx8658m" target="_blank">友だち追加</a>
      <a id="plus" href="https://line.me/R/ti/p/%40otherplus">PLUS</a>
    </body>`,
    { url: `https://www.cuthome-oasis.com${opts.path ?? "/%E6%9C%AC%E5%BA%97%E8%A9%B3%E7%B4%B0"}${search}`, runScripts: "outside-only" },
  );
  const w = dom.window as any;
  const fetch = opts.fetch ?? fakeFetch(async () => ({ status: 201, body: { ok: true, ad_ref: AD_REF } }));
  w.fetch = fetch;
  if (opts.consent) w.consentPolicyManager = { getCurrentConsentPolicy: () => opts.consent };
  w.eval(wixScript(opts.configured ?? true));
  await wait(20);
  const href = (id: string) => w.document.getElementById(id).getAttribute("href");
  return { w, fetch, href };
}

const ENTRY_URL = `https://liff.line.me/${ENTRY_LIFF_ID}?ad_ref=${AD_REF}`;

describe("Wix のカスタムコード案（本店ページ）", () => {
  it("gclid があれば登録して、本店の LINE ボタンだけを入口ページに変える。クリック識別子は URL に載せない", async () => {
    const { fetch, href } = await openWix("?gclid=Cj0KCQjw-test_gclid_ABCDEFGHIJKLMNOP&utm_source=google&utm_medium=cpc");
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetch.mock.calls[0][1].body));
    expect(body).toMatchObject({ store: "honten", click_ids: { gclid: "Cj0KCQjw-test_gclid_ABCDEFGHIJKLMNOP" }, landing_path: "/%E6%9C%AC%E5%BA%97%E8%A9%B3%E7%B4%B0" });
    expect(href("line1")).toBe(ENTRY_URL);
    expect(href("line2")).toBe(ENTRY_URL);
    expect(href("line1")).not.toContain("gclid");
    expect(href("plus")).toBe("https://line.me/R/ti/p/%40otherplus");
  });

  it("gbraid・wbraid でも動く", async () => {
    expect((await openWix("?gbraid=0AAAAAx_gbraid-test-1234567890")).href("line1")).toBe(ENTRY_URL);
    expect((await openWix("?wbraid=CkAKCQ-wbraid_test_1234567890")).href("line1")).toBe(ENTRY_URL);
  });

  it("広告以外（クリック識別子なし）・不正な値なら、何も送らずリンクもそのまま", async () => {
    for (const search of ["", "?utm_source=google", "?gclid=bad%20value", "?gclid=Cj0KCQjw-test_gclid_ABCDEFGHIJKLMNOP&wbraid=%3Cx%3E"]) {
      const { fetch, href } = await openWix(search);
      expect(fetch).not.toHaveBeenCalled();
      expect(href("line1")).toBe("https://line.me/R/ti/p/%40nlx8658m");
    }
  });

  it("受付が止まっている（503）・通信エラーなら、いつもの LINE リンクのまま", async () => {
    const off = await openWix("?gclid=Cj0KCQjw-test_gclid_ABCDEFGHIJKLMNOP", { fetch: fakeFetch(async () => ({ status: 503, body: { enabled: false } })) });
    expect(off.href("line1")).toBe("https://line.me/R/ti/p/%40nlx8658m");
    const down = await openWix("?gclid=Cj0KCQjw-test_gclid_ABCDEFGHIJKLMNOP", {
      fetch: fakeFetch(async () => {
        throw new TypeError("Failed");
      }),
    });
    expect(down.href("line1")).toBe("https://line.me/R/ti/p/%40nlx8658m");
  });

  it("Wix の同意で「広告」を拒否している人には何もしない", async () => {
    const { fetch } = await openWix("?gclid=Cj0KCQjw-test_gclid_ABCDEFGHIJKLMNOP", { consent: { defaultPolicy: false, policy: { advertising: false } } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("設定が空なら何もしない", async () => {
    const { fetch } = await openWix("?gclid=Cj0KCQjw-test_gclid_ABCDEFGHIJKLMNOP", { configured: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("あとから描かれたボタン・描き直されたボタンも入口ページに変える", async () => {
    const { w, href } = await openWix("?gclid=Cj0KCQjw-test_gclid_ABCDEFGHIJKLMNOP");
    const a = w.document.createElement("a");
    a.id = "late";
    a.setAttribute("href", "https://line.me/R/ti/p/%40nlx8658m");
    w.document.body.appendChild(a);
    w.document.getElementById("line1").setAttribute("href", "https://line.me/R/ti/p/%40nlx8658m");
    await wait(10);
    expect(href("late")).toBe(ENTRY_URL);
    expect(href("line1")).toBe(ENTRY_URL);
  });
});
