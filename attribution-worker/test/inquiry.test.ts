import { beforeEach, describe, expect, it } from "vitest";
import { signSession } from "../src/crypto";
import { env } from "cloudflare:test";
import { Harness, USER_A, USER_B, dumpAllTables, resetDb, rows } from "./helpers";

beforeEach(resetDb);

interface InquiryRow {
  inquiry_id: string;
  attribution: string;
  line_user_hash: string | null;
  ad_ref: string | null;
  hours_from_click: number | null;
  resent: number;
}

const inquiry = async (id: string) =>
  (await rows<InquiryRow>(`SELECT * FROM inquiries WHERE inquiry_id = ?1`, id))[0];
const upload = async (id: string) =>
  (await rows<{ status: string; deadline_at: string }>(`SELECT * FROM conversion_uploads WHERE inquiry_id = ?1`, id))[0];

describe("POST /v1/inquiry（LINE 送信が成功したあと）", () => {
  it("広告を通っていない人は none。識別子を残さず、送信の対象にもしない", async () => {
    const h = new Harness();
    const s = await h.session(USER_B);
    const { inquiryId, res } = await h.inquiry(s.body.session);
    expect(res.status).toBe(200);
    const row = await inquiry(inquiryId);
    expect(row.attribution).toBe("none");
    expect(row.line_user_hash).toBeNull();
    expect(row.ad_ref).toBeNull();
    expect(await upload(inquiryId)).toBeUndefined();
  });

  it("広告クリックから24時間以内は ad_same_day で、送信待ちになる", async () => {
    const h = new Harness();
    const u = await h.adUser();
    h.advanceHours(2);
    const { inquiryId } = await h.inquiry(u.session);
    const row = await inquiry(inquiryId);
    expect(row.attribution).toBe("ad_same_day");
    expect(row.ad_ref).toBe(u.adRef);
    expect(row.hours_from_click).toBe(2);
    const up = await upload(inquiryId);
    expect(up.status).toBe("pending");
  });

  it("数日後（友だち追加のあと、リッチメニューから）は ad_delayed", async () => {
    const h = new Harness();
    const { adRef } = await h.adUser();
    h.advanceHours(24 * 3);
    // 3日後にもう一度フォームを開いた（新しいセッション）。
    const s = await h.session(USER_A);
    const { inquiryId } = await h.inquiry(s.body.session);
    const row = await inquiry(inquiryId);
    expect(row.attribution).toBe("ad_delayed");
    expect(row.ad_ref).toBe(adRef);
    expect((await upload(inquiryId)).status).toBe("pending");
  });

  it("クリックから90日を過ぎたら expired。送信しない", async () => {
    const h = new Harness();
    await h.adUser();
    h.advanceHours(24 * 91);
    const s = await h.session(USER_A);
    const { inquiryId } = await h.inquiry(s.body.session);
    const row = await inquiry(inquiryId);
    expect(row.attribution).toBe("expired");
    expect(row.line_user_hash).toBeNull();
    expect(await upload(inquiryId)).toBeUndefined();
  });

  it("同じ inquiry_id（再試行・二重タップ）は1件だけ", async () => {
    const h = new Harness();
    const u = await h.adUser();
    const id = crypto.randomUUID();
    const [a, b] = await Promise.all([h.inquiry(u.session, id), h.inquiry(u.session, id)]);
    expect(a.res.status).toBe(200);
    expect(b.res.status).toBe(200);
    await h.inquiry(u.session, id, { resent: true });
    expect(await rows(`SELECT * FROM inquiries`)).toHaveLength(1);
    expect(await rows(`SELECT * FROM conversion_uploads`)).toHaveLength(1);
  });

  it("同じ人の2件目（24時間以内）は記録するが、送信はしない", async () => {
    const h = new Harness();
    const u = await h.adUser();
    const first = await h.inquiry(u.session);
    h.advanceHours(1);
    const second = await h.inquiry(u.session);
    expect((await upload(first.inquiryId)).status).toBe("pending");
    expect((await upload(second.inquiryId)).status).toBe("suppressed_duplicate");
    h.advanceHours(30);
    const s = await h.session(USER_A);
    const third = await h.inquiry(s.body.session);
    expect((await upload(third.inquiryId)).status).toBe("pending");
  });

  it("広告から何度も来たときは、問い合わせより前の最も新しいクリックを採る", async () => {
    const h = new Harness();
    const first = await h.adClick();
    await h.bind(first.body.ad_ref);
    h.advanceHours(48);
    const second = await h.adClick();
    await h.bind(second.body.ad_ref);
    h.advanceHours(1);
    const s = await h.session(USER_A);
    const { inquiryId } = await h.inquiry(s.body.session);
    const row = await inquiry(inquiryId);
    expect(row.ad_ref).toBe(second.body.ad_ref);
    expect(row.attribution).toBe("ad_same_day");
  });

  it("問い合わせのあとに結ばれたクリックは使わない（あとから成果を付け替えない）", async () => {
    const h = new Harness();
    const s = await h.session(USER_A);
    const sentAt = h.nowIso();
    h.advanceHours(1);
    const u = await h.adClick();
    await h.bind(u.body.ad_ref);
    // 送った直後に閉じて届かず、次に開いたときに再送された（送信時刻は元のまま）。
    const { inquiryId } = await h.inquiry(s.body.session, crypto.randomUUID(), { submitted_at: sentAt, resent: true });
    const row = await inquiry(inquiryId);
    expect(row.attribution).toBe("none");
    expect(row.resent).toBe(1);
  });

  it("別の人の結びつけは使わない", async () => {
    const h = new Harness();
    await h.adUser(USER_A);
    const s = await h.session(USER_B);
    const { inquiryId } = await h.inquiry(s.body.session);
    expect((await inquiry(inquiryId)).attribution).toBe("none");
  });

  it("セッションが無い・改ざん・期限切れ・別の鍵で作ったものは拒否する", async () => {
    const h = new Harness();
    const s = await h.session();
    const tampered = s.body.session.replace(/.$/, (c: string) => (c === "A" ? "B" : "A"));
    expect((await h.inquiry("")).res.status).toBe(401);
    expect((await h.inquiry(tampered)).res.status).toBe(401);
    const forged = await signSession("another-root-key-0123456789abcdef0123", {
      v: 1,
      h: "a".repeat(64),
      iat: 0,
      exp: Math.floor(h.nowMs / 1000) + 3600,
    });
    expect((await h.inquiry(forged)).res.status).toBe(401);
    h.advanceHours(13);
    expect((await h.inquiry(s.body.session)).res.status).toBe(401);
    expect(await rows(`SELECT * FROM inquiries`)).toHaveLength(0);
    // 正しい鍵で作った別人の印は、検証は通る（鍵が漏れない限り作れない）。
    const ok = await signSession(env.ATTR_ROOT_KEY, { v: 1, h: "b".repeat(64), iat: 0, exp: Math.floor(h.nowMs / 1000) + 60 });
    expect((await h.inquiry(ok)).res.status).toBe(200);
  });

  it("inquiry_id は UUID v4 だけ。送信時刻は未来・7日より前を拒否する", async () => {
    const h = new Harness();
    const s = (await h.session()).body.session;
    expect((await h.inquiry(s, "not-a-uuid")).res.status).toBe(400);
    expect((await h.inquiry(s, "' OR '1'='1")).res.status).toBe(400);
    const future = new Date(h.nowMs + 3_600_000).toISOString();
    expect((await h.inquiry(s, crypto.randomUUID(), { submitted_at: future })).res.status).toBe(400);
    const old = new Date(h.nowMs - 8 * 86_400_000).toISOString();
    expect((await h.inquiry(s, crypto.randomUUID(), { submitted_at: old })).res.status).toBe(400);
    expect((await h.inquiry(s, crypto.randomUUID(), { submitted_at: "yesterday" })).res.status).toBe(400);
    const fine = new Date(h.nowMs - 2 * 86_400_000).toISOString();
    expect((await h.inquiry(s, crypto.randomUUID(), { submitted_at: fine, resent: true })).res.status).toBe(200);
  });

  it("同じ人から1時間に11件目は 429（違う inquiry_id を作って水増しさせない）", async () => {
    const h = new Harness();
    const s = (await h.session()).body.session;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await h.inquiry(s)).res.status);
    expect(statuses.slice(0, 10).every((x) => x === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("予約フォームの Origin 以外からは受け付けない", async () => {
    const h = new Harness();
    const s = (await h.session()).body.session;
    const res = await h.post(
      "/v1/inquiry",
      { session: s, inquiry_id: crypto.randomUUID() },
      { origin: "https://www.cuthome-oasis.com" },
    );
    expect(res.status).toBe(403);
  });

  it("どの表にも LINE の生のID・氏名・電話番号は入らない", async () => {
    const h = new Harness();
    const u = await h.adUser();
    await h.inquiry(u.session, crypto.randomUUID(), {
      // フォームが誤って余計な項目を送っても、保存しない。
      username: "オアシス太郎",
      phoneNumber: "09012345678",
    });
    const dump = await dumpAllTables();
    expect(dump).not.toContain(USER_A);
    expect(dump).not.toContain("オアシス太郎");
    expect(dump).not.toContain("09012345678");
  });
});
