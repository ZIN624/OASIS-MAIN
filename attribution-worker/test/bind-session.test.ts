import { beforeEach, describe, expect, it } from "vitest";
import { ENTRY_CHANNEL, FORM_CHANNEL, Harness, OTHER_CHANNEL, USER_A, USER_B, dumpAllTables, idToken, resetDb, rows } from "./helpers";

beforeEach(resetDb);

describe("POST /v1/bind（LIFF の入口ページから）", () => {
  it("IDトークンを検証して結ぶ。LINE の生のIDとトークンは保存しない", async () => {
    const h = new Harness();
    const click = await h.adClick();
    const res = await h.bind(click.body.ad_ref);
    expect(res.status).toBe(200);
    expect(h.line.calls).toHaveLength(1);
    expect(h.line.calls[0].clientId).toBe(ENTRY_CHANNEL);
    const [b] = await rows<{ line_user_hash: string; consent_ad_data: string; consent_version: string }>(
      `SELECT * FROM line_bindings`,
    );
    expect(b.line_user_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.consent_ad_data).toBe("granted");
    expect(b.consent_version).toBe("2026-10-21");
    const dump = await dumpAllTables();
    expect(dump).not.toContain(USER_A);
    expect(dump).not.toContain(idToken(USER_A, ENTRY_CHANNEL));
  });

  it("同じ人がもう一度結ぶのは成功（再読み込み）。別の人は 409", async () => {
    const h = new Harness();
    const click = await h.adClick();
    expect((await h.bind(click.body.ad_ref)).status).toBe(200);
    expect((await h.bind(click.body.ad_ref)).status).toBe(200);
    const other = await h.bind(click.body.ad_ref, USER_B);
    expect(other.status).toBe(409);
    expect(await rows(`SELECT * FROM line_bindings`)).toHaveLength(1);
  });

  it("期限切れ・改ざん・別チャネルのIDトークンは拒否する", async () => {
    const h = new Harness();
    const ref = (await h.adClick()).body.ad_ref;
    expect((await h.bind(ref, USER_A, { tag: "expired" })).body.error).toBe("token_expired");
    expect((await h.bind(ref, USER_A, { tag: "invalid" })).body.error).toBe("token_invalid");
    expect((await h.bind(ref, USER_A, { tag: "bad_iss" })).body.error).toBe("token_invalid");
    const before = h.line.calls.length;
    const other = await h.bind(ref, USER_A, { aud: OTHER_CHANNEL });
    expect(other.status).toBe(401);
    expect(other.body.error).toBe("aud_not_allowed");
    // 許可していないチャネルのトークンは LINE に問い合わせもしない。
    expect(h.line.calls.length).toBe(before);
    expect((await h.post("/v1/bind", { ad_ref: ref, id_token: "not-a-jwt", consent: { ad_data: "granted", version: "2026-10-21" } })).body.error).toBe("token_malformed");
    expect(await rows(`SELECT * FROM line_bindings`)).toHaveLength(0);
  });

  it("LINE の検証APIが落ちていたら 503（入口ページはいつもの導線へ進む）", async () => {
    const h = new Harness();
    const ref = (await h.adClick()).body.ad_ref;
    const res = await h.bind(ref, USER_A, { tag: "down" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("verify_unavailable");
  });

  it("知らない ad_ref・形の崩れた ad_ref・結びつけの期限切れは拒否する", async () => {
    const h = new Harness();
    expect((await h.bind("A".repeat(22))).status).toBe(404);
    expect((await h.bind("short")).status).toBe(400);
    expect((await h.bind("' OR 1=1 --xxxxxxxxxxx")).status).toBe(400);
    const ref = (await h.adClick()).body.ad_ref;
    h.advanceHours(25);
    const late = await h.bind(ref);
    expect(late.status).toBe(410);
    expect(await rows(`SELECT * FROM line_bindings`)).toHaveLength(0);
  });

  it("同意していないなら結ばない", async () => {
    const h = new Harness();
    const ref = (await h.adClick()).body.ad_ref;
    expect((await h.bind(ref, USER_A, { consent: { ad_data: "denied", version: "2026-10-21" } })).status).toBe(400);
    expect((await h.bind(ref, USER_A, { consent: null })).status).toBe(400);
    expect((await h.bind(ref, USER_A, { consent: { ad_data: "granted", version: "<b>" } })).status).toBe(400);
    expect(await rows(`SELECT * FROM line_bindings`)).toHaveLength(0);
  });

  it("Wix の Origin からは結べない", async () => {
    const h = new Harness();
    const ref = (await h.adClick()).body.ad_ref;
    const res = await h.post(
      "/v1/bind",
      { ad_ref: ref, id_token: idToken(USER_A, ENTRY_CHANNEL), consent: { ad_data: "granted", version: "2026-10-21" } },
      { origin: "https://www.cuthome-oasis.com" },
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/session（予約フォームを開いたとき）", () => {
  it("IDトークンを検証して、12時間の印を返す", async () => {
    const h = new Harness();
    const res = await h.session();
    expect(res.status).toBe(200);
    expect(res.body.session).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(Date.parse(res.body.expires_at) - h.nowMs).toBe(12 * 3_600_000);
    expect(h.line.calls[0].clientId).toBe(FORM_CHANNEL);
    expect(JSON.stringify(res.body)).not.toContain(USER_A);
  });

  it("期限切れ・改ざんのIDトークンには印を出さない", async () => {
    const h = new Harness();
    expect((await h.session(USER_A, { tag: "expired" })).status).toBe(401);
    expect((await h.session(USER_A, { tag: "invalid" })).status).toBe(401);
    expect((await h.post("/v1/session", {})).status).toBe(401);
  });
});
