// 品質監査（2026-10-22）で足したテスト。既存のテストが見ていなかった「境目」と「止め具」を確かめる。
// 本番のコード（src/）は変えていない。
import { beforeEach, describe, expect, it } from "vitest";
import { Harness, USER_A, USER_B, resetDb, rows, testConfig } from "./helpers";

beforeEach(resetDb);

const inquiry = async (id: string) =>
  (await rows<{ attribution: string; ad_ref: string | null; line_user_hash: string | null; resent: number }>(
    `SELECT * FROM inquiries WHERE inquiry_id = ?1`,
    id,
  ))[0];
const upload = async (id: string) =>
  (await rows<{ status: string }>(`SELECT status FROM conversion_uploads WHERE inquiry_id = ?1`, id))[0];
const MINUTE_H = 1 / 60;

describe("区分の境目", () => {
  it("クリックからちょうど24時間は ad_same_day、1分過ぎたら ad_delayed", async () => {
    const h = new Harness();
    await h.adUser();
    h.advanceHours(24);
    const a = await h.inquiry((await h.session(USER_A)).body.session);
    expect((await inquiry(a.inquiryId)).attribution).toBe("ad_same_day");

    h.advanceHours(MINUTE_H);
    const b = await h.inquiry((await h.session(USER_A)).body.session);
    expect((await inquiry(b.inquiryId)).attribution).toBe("ad_delayed");
  });

  it("クリックからちょうど90日はまだ帰属する。1分過ぎたら expired で送信しない", async () => {
    const h = new Harness();
    await h.adUser();
    h.advanceHours(24 * 90);
    const a = await h.inquiry((await h.session(USER_A)).body.session);
    expect((await inquiry(a.inquiryId)).attribution).toBe("ad_delayed");

    h.advanceHours(MINUTE_H);
    const b = await h.inquiry((await h.session(USER_A)).body.session);
    const row = await inquiry(b.inquiryId);
    expect(row.attribution).toBe("expired");
    expect(row.ad_ref).toBeNull();
    expect(await upload(b.inquiryId)).toBeUndefined();
  });

  it("結びつけはクリックから24時間の手前まで。ちょうど24時間からは 410", async () => {
    // 区分（ad_same_day）は「24時間以内」を含むが、結びつけの期限は24時間ちょうどで閉じる（bind_expires_at <= 今）。
    const h = new Harness();
    const first = await h.adClick();
    h.advanceHours(24 - MINUTE_H);
    expect((await h.bind(first.body.ad_ref)).body.ok).toBe(true);

    const second = await h.adClick({ gclid: "Cj0KCQjw-second_click_ABCDEFGHIJKLMNOPQRS" });
    h.advanceHours(24);
    expect((await h.bind(second.body.ad_ref, USER_B)).status).toBe(410);
  });
});

describe("送り直し（予約フォームに残っていた未送信の記録）", () => {
  it("クリックより前に送った予約希望を、あとで送り直しても広告の成果にしない", async () => {
    // ステージングで見えた「none・resent=1」の行と同じ流れ。
    const h = new Harness();
    const s = await h.session(USER_A);
    const submittedBeforeClick = h.nowIso();
    const inquiryId = crypto.randomUUID();
    h.advanceHours(1);
    const click = await h.adClick();
    await h.bind(click.body.ad_ref, USER_A);
    h.advanceHours(1);
    await h.inquiry(s.body.session, inquiryId, { submitted_at: submittedBeforeClick, resent: true });

    const row = await inquiry(inquiryId);
    expect(row.attribution).toBe("none");
    expect(row.resent).toBe(1);
    expect(row.ad_ref).toBeNull();
    expect(row.line_user_hash).toBeNull();
    expect(await upload(inquiryId)).toBeUndefined();
  });
});

const expectOnlyDisabledCount = async () => {
  for (const t of ["ad_clicks", "line_bindings", "inquiries", "conversion_uploads", "rate_limits", "retention_runs"]) {
    expect(await rows(`SELECT 1 FROM ${t}`), t).toHaveLength(0);
  }
  expect(await rows(`SELECT code, count FROM diag_counters`)).toEqual([{ code: "disabled", count: 4 }]);
};

describe("止め具", () => {
  const endpoints = async (h: Harness) => [
    (await h.adClick()).status,
    (await h.bind("A".repeat(22))).status,
    (await h.session(USER_A)).status,
    (await h.inquiry("x")).res.status,
  ];

  it("停止スイッチが false なら、4つの入口すべてが 503。残るのは件数（disabled）だけ", async () => {
    const h = new Harness(undefined, testConfig({ AD_ATTR_ENABLED: "false" }));
    expect(await endpoints(h)).toEqual([503, 503, 503, 503]);
    expect(h.line.calls).toHaveLength(0);
    await expectOnlyDisabledCount();
  });

  it("本店以外の店舗の設定（STORE_ID）では動かない（PLUS に混ぜない）。残るのは件数だけ", async () => {
    const h = new Harness(undefined, testConfig({ STORE_ID: "plus" }));
    expect(await endpoints(h)).toEqual([503, 503, 503, 503]);
    expect(h.line.calls).toHaveLength(0);
    await expectOnlyDisabledCount();
  });
});

describe("テストが本物の外部に出ないこと", () => {
  it("本物の fetch（LINE・Google への通信）はテストの中では使えない", async () => {
    await expect(fetch("https://api.line.me/oauth2/v2.1/verify")).rejects.toThrow(/外への通信/);
    await expect(fetch("https://datamanager.googleapis.com/v1/events:ingest")).rejects.toThrow(/外への通信/);
  });
});

// 偽の gclid（先頭が TEST_ / TEST-）を Google へ送らない止め具と、そのテストは ZIN624/OASIS-MAIN#9 にある
// （test/upload-guard.test.ts）。このファイルは本番のコードを変えないテストだけにしている。
