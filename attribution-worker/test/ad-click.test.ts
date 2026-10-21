import { beforeEach, describe, expect, it } from "vitest";
import { GCLID, Harness, resetDb, rows, testConfig } from "./helpers";

beforeEach(resetDb);

describe("POST /v1/ad-click（Wix の本店ページから）", () => {
  it("gclid があれば ad_ref を返し、クリック識別子はサーバにだけ残す", async () => {
    const h = new Harness();
    const res = await h.adClick();
    expect(res.status).toBe(201);
    expect(res.body.ad_ref).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(JSON.stringify(res.body)).not.toContain(GCLID);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://www.cuthome-oasis.com");
    const [row] = await rows<Record<string, string>>(`SELECT * FROM ad_clicks`);
    expect(row.gclid).toBe(GCLID);
    expect(row.store).toBe("honten");
    expect(row.landing_path).toBe("/本店新規問い合わせ");
    expect(Date.parse(row.expires_at) - Date.parse(row.first_seen_at)).toBe(90 * 86_400_000);
    expect(Date.parse(row.bind_expires_at) - Date.parse(row.first_seen_at)).toBe(24 * 3_600_000);
  });

  it("gbraid だけ・wbraid だけでも受け付ける", async () => {
    const h = new Harness();
    expect((await h.adClick({ gbraid: "0AAAAAx_gbraid-test-1234567890" })).status).toBe(201);
    expect((await h.adClick({ wbraid: "CkAKCQ-wbraid_test_1234567890" })).status).toBe(201);
    const r = await rows<{ gbraid: string | null; wbraid: string | null }>(`SELECT gbraid, wbraid FROM ad_clicks`);
    expect(r).toHaveLength(2);
  });

  it("クリック識別子が無い・形が崩れている・一部だけ不正なら拒否する", async () => {
    const h = new Harness();
    expect((await h.adClick({})).status).toBe(400);
    expect((await h.adClick({ gclid: "short" })).status).toBe(400);
    expect((await h.adClick({ gclid: "abc<script>alert(1)</script>0123456789" })).status).toBe(400);
    expect((await h.adClick({ gclid: GCLID, wbraid: "bad value with spaces 123" })).status).toBe(400);
    expect((await h.adClick({ gclid: "x".repeat(600) })).status).toBe(400);
    expect(await rows(`SELECT * FROM ad_clicks`)).toHaveLength(0);
  });

  it("本店以外の店舗・本店以外のページは受け付けない（PLUSと混ぜない）", async () => {
    const h = new Harness();
    expect((await h.adClick({ gclid: GCLID }, { store: "plus" })).status).toBe(400);
    expect((await h.adClick({ gclid: GCLID }, { landing_path: "/oasisplus" })).status).toBe(400);
    expect((await h.adClick({ gclid: GCLID }, { landing_path: "/堀町店詳細" })).status).toBe(400);
    expect((await h.adClick({ gclid: GCLID }, { landing_path: "/oasis本店" })).status).toBe(201);
    expect((await h.adClick({ gclid: GCLID }, { landing_path: "/oasis%E6%9C%AC%E5%BA%97/" })).status).toBe(201);
  });

  it("許可していない Origin・Origin なしは 403", async () => {
    const h = new Harness();
    expect((await h.post("/v1/ad-click", { store: "honten" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await h.post("/v1/ad-click", { store: "honten" }, { origin: null })).status).toBe(403);
    // 予約フォームの Origin からは広告クリックを登録できない（入口ごとに分けている）。
    expect((await h.post("/v1/ad-click", { store: "honten" }, { origin: "https://zin624.github.io" })).status).toBe(403);
  });

  it("同じ広告クリックが2回来ても、それぞれ別の ad_ref になる（推測で他人の ad_ref を得られない）", async () => {
    const h = new Harness();
    const a = await h.adClick();
    const b = await h.adClick();
    expect(a.body.ad_ref).not.toBe(b.body.ad_ref);
  });

  it("同じIPから10分に31回目は 429", async () => {
    const h = new Harness();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      statuses.push(
        (
          await h.post(
            "/v1/ad-click",
            { store: "honten", click_ids: { gclid: GCLID }, landing_path: "/本店詳細" },
            { ip: "203.0.113.9" },
          )
        ).status,
      );
    }
    expect(statuses.slice(0, 30).every((s) => s === 201)).toBe(true);
    expect(statuses[30]).toBe(429);
    // 生のIPは保存しない。
    expect(JSON.stringify(await rows(`SELECT * FROM rate_limits`))).not.toContain("203.0.113.9");
  });

  it("大きすぎる本文・JSONでない本文は拒否する", async () => {
    const h = new Harness();
    expect((await h.post("/v1/ad-click", null, { raw: "x".repeat(5000) })).status).toBe(400);
    expect((await h.post("/v1/ad-click", null, { raw: "not json" })).status).toBe(400);
    expect((await h.post("/v1/ad-click", null, { raw: "[1,2]" })).status).toBe(400);
  });

  it("停止スイッチが false なら何も記録せず 503（Wix はいつもの LINE リンクのまま）", async () => {
    const h = new Harness(undefined, testConfig({ AD_ATTR_ENABLED: "false" }));
    const res = await h.adClick();
    expect(res.status).toBe(503);
    expect(res.body.enabled).toBe(false);
    expect(await rows(`SELECT * FROM ad_clicks`)).toHaveLength(0);
  });

  it("秘密鍵が無ければ、スイッチが true でも動かない", async () => {
    const h = new Harness(undefined, testConfig({ ATTR_ROOT_KEY: "" }));
    expect((await h.adClick()).status).toBe(503);
  });

  it("SQL に見える値もただの文字列として扱う", async () => {
    const h = new Harness();
    const res = await h.adClick({ gclid: GCLID }, { utm: { campaign: "x'); DROP TABLE ad_clicks; --" } });
    expect(res.status).toBe(201);
    const [row] = await rows<{ utm_campaign: string }>(`SELECT utm_campaign FROM ad_clicks`);
    expect(row.utm_campaign).toBe("x'); DROP TABLE ad_clicks; --");
  });

  it("プリフライトは許可した Origin にだけ答える", async () => {
    const h = new Harness();
    const { handleRequest } = await import("../src/index");
    const ok = await handleRequest(
      new Request("https://attr.example/v1/ad-click", { method: "OPTIONS", headers: { origin: "https://cuthome-oasis.com" } }),
      h.deps,
    );
    expect(ok.status).toBe(204);
    const ng = await handleRequest(
      new Request("https://attr.example/v1/ad-click", { method: "OPTIONS", headers: { origin: "https://evil.example" } }),
      h.deps,
    );
    expect(ng.status).toBe(403);
  });
});
