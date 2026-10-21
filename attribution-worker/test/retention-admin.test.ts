import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";
import { runRetention } from "../src/retention";
import { GCLID, Harness, USER_A, idToken, resetDb, rows } from "./helpers";

beforeEach(resetDb);

describe("毎日の削除", () => {
  it("90日でクリック・結びつけを消し、問い合わせから識別子を外す（区分は残す）", async () => {
    const h = new Harness();
    const u = await h.adUser();
    const { inquiryId } = await h.inquiry(u.session);
    await env.ATTR_DB.prepare(`UPDATE conversion_uploads SET status = 'uploaded'`).run();

    // 89日目: まだ消さない
    await runRetention(env.ATTR_DB, new Date(h.nowMs + 89 * 86_400_000));
    expect(await rows(`SELECT * FROM ad_clicks`)).toHaveLength(1);

    const report = await runRetention(env.ATTR_DB, new Date(h.nowMs + 90 * 86_400_000 + 1000));
    expect(report).toMatchObject({ clicks_deleted: 1, bindings_deleted: 1, inquiries_scrubbed: 1 });
    expect(await rows(`SELECT * FROM ad_clicks`)).toHaveLength(0);
    expect(await rows(`SELECT * FROM line_bindings`)).toHaveLength(0);
    const [row] = await rows<Record<string, unknown>>(`SELECT * FROM inquiries`);
    expect(row).toMatchObject({ inquiry_id: inquiryId, attribution: "ad_same_day", line_user_hash: null, ad_ref: null });
    const runs = await rows(`SELECT * FROM retention_runs`);
    expect(runs).toHaveLength(2);
  });

  it("送る前に期限が来たものは expired にしてから消す", async () => {
    const h = new Harness();
    const u = await h.adUser();
    const { inquiryId } = await h.inquiry(u.session);
    const report = await runRetention(env.ATTR_DB, new Date(h.nowMs + 91 * 86_400_000));
    expect(report.uploads_expired).toBe(1);
    const [up] = await rows<{ status: string }>(`SELECT status FROM conversion_uploads WHERE inquiry_id = ?1`, inquiryId);
    expect(up.status).toBe("expired");
  });

  it("結ばれないまま結びつけの期限を過ぎたクリックは、90日を待たずに消す", async () => {
    const h = new Harness();
    await h.adClick();
    await runRetention(env.ATTR_DB, new Date(h.nowMs + 23 * 3_600_000));
    expect(await rows(`SELECT * FROM ad_clicks`)).toHaveLength(1);
    await runRetention(env.ATTR_DB, new Date(h.nowMs + 25 * 3_600_000));
    expect(await rows(`SELECT * FROM ad_clicks`)).toHaveLength(0);
  });

  it("13か月を過ぎた問い合わせは件数ごと消す", async () => {
    const h = new Harness();
    const s = (await h.session()).body.session;
    await h.inquiry(s);
    await runRetention(env.ATTR_DB, new Date(h.nowMs + 365 * 86_400_000));
    expect(await rows(`SELECT * FROM inquiries`)).toHaveLength(1);
    const report = await runRetention(env.ATTR_DB, new Date(h.nowMs + 400 * 86_400_000));
    expect(report.inquiries_deleted).toBe(1);
    expect(await rows(`SELECT * FROM inquiries`)).toHaveLength(0);
  });
});

describe("GET /v1/admin/diagnostics", () => {
  const get = (h: Harness, auth?: string) =>
    handleRequest(
      new Request("https://attr.example/v1/admin/diagnostics", {
        headers: auth ? { authorization: auth, "cf-connecting-ip": "192.0.2.1" } : { "cf-connecting-ip": "192.0.2.1" },
      }),
      h.deps,
    );

  it("Bearer が無い・違うときは 401", async () => {
    const h = new Harness();
    expect((await get(h)).status).toBe(401);
    expect((await get(h, "Bearer wrong")).status).toBe(401);
    expect((await get(h, env.ADMIN_TOKEN)).status).toBe(401);
  });

  it("件数だけを返し、クリック識別子・ad_ref・ハッシュは返さない", async () => {
    const h = new Harness();
    const u = await h.adUser();
    await h.inquiry(u.session);
    const res = await get(h, `Bearer ${env.ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(GCLID);
    expect(text).not.toContain(u.adRef);
    const [b] = await rows<{ line_user_hash: string }>(`SELECT line_user_hash FROM line_bindings`);
    expect(text).not.toContain(b.line_user_hash);
    const body = JSON.parse(text);
    expect(body.totals.inquiries).toEqual([{ attribution: "ad_same_day", n: 1 }]);
  });
});

describe("ログ", () => {
  it("処理の途中で落ちても、トークン・本文はログに出さない", async () => {
    const h = new Harness();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = idToken(USER_A);
    const broken = { ...h.deps, db: { prepare: () => { throw new Error(`boom ${token}`); } } as unknown as D1Database };
    const res = await handleRequest(
      new Request("https://attr.example/v1/session", {
        method: "POST",
        headers: { origin: "https://zin624.github.io", "content-type": "text/plain" },
        body: JSON.stringify({ id_token: token }),
      }),
      broken,
    );
    expect(res.status).toBe(500);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain("boom");
    spy.mockRestore();
  });

  it("知らないパスは 404", async () => {
    const h = new Harness();
    const res = await handleRequest(new Request("https://attr.example/v1/export"), h.deps);
    expect(res.status).toBe(404);
  });
});
