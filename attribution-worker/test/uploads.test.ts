import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { formatJstDateTime } from "../src/attribution";
import { MAX_ATTEMPTS, runUploadPass, safeCode, type ConversionEvent, type ConversionSender, type SendResult } from "../src/uploads";
import { GCLID, Harness, USER_A, USER_B, resetDb, rows, testConfig } from "./helpers";

beforeEach(resetDb);

const sub = (n: number) => "U" + n.toString(16).padStart(32, "0");

function recorder(reply: (events: ConversionEvent[]) => SendResult | Promise<SendResult>) {
  const batches: ConversionEvent[][] = [];
  const sender: ConversionSender = {
    async send(events) {
      batches.push(events);
      return reply(events);
    },
  };
  return { sender, batches };
}

async function pendingInquiries(h: Harness, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const u = await h.adUser(sub(i + 1));
    ids.push((await h.inquiry(u.session)).inquiryId);
  }
  return ids;
}

const statusOf = async (id: string) =>
  (await rows<{ status: string; attempts: number; last_error_code: string | null; next_attempt_at: string | null }>(
    `SELECT status, attempts, last_error_code, next_attempt_at FROM conversion_uploads WHERE inquiry_id = ?1`,
    id,
  ))[0];

describe("Google 広告への送信の段取り", () => {
  it("送信のスイッチが false なら何もしない", async () => {
    const h = new Harness(undefined, testConfig({ UPLOAD_ENABLED: "false" }));
    const [id] = await pendingInquiries(h, 1);
    const r = recorder(() => ({ kind: "rows", rows: [] }));
    const report = await runUploadPass(env.ATTR_DB, h.cfg, r.sender, new Date(h.nowMs));
    expect(report.skipped).toBe("disabled");
    expect(r.batches).toHaveLength(0);
    expect((await statusOf(id)).status).toBe("pending");
  });

  it("送信方式が未実装（sender が null）のあいだは何もしない", async () => {
    const h = new Harness();
    const [id] = await pendingInquiries(h, 1);
    const report = await runUploadPass(env.ATTR_DB, h.cfg, null, new Date(h.nowMs));
    expect(report.skipped).toBe("not_configured");
    expect((await statusOf(id)).status).toBe("pending");
  });

  it("送る中身はクリック識別子・時刻・order_id だけ（個人情報は入らない）", async () => {
    const h = new Harness();
    const [id] = await pendingInquiries(h, 1);
    const r = recorder((ev) => ({ kind: "rows", rows: ev.map((e) => ({ orderId: e.orderId, outcome: "accepted", code: "ok" })) }));
    await runUploadPass(env.ATTR_DB, h.cfg, r.sender, new Date(h.nowMs));
    const [event] = r.batches[0];
    expect(event).toEqual({
      orderId: id,
      gclid: GCLID,
      gbraid: null,
      wbraid: null,
      conversionAt: expect.any(String),
      conversionAtJst: formatJstDateTime(event.conversionAt),
      currency: "JPY",
      adUserData: "GRANTED",
    });
    expect(event.conversionAtJst).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+09:00$/);
    expect(JSON.stringify(r.batches)).not.toContain(USER_A);
    expect((await statusOf(id)).status).toBe("uploaded");
  });

  it("部分的な失敗は行ごとに扱う（200 でも全件成功とみなさない）", async () => {
    const h = new Harness();
    const ids = await pendingInquiries(h, 4);
    const r = recorder(() => ({
      kind: "rows",
      rows: [
        { orderId: ids[0], outcome: "accepted", code: "ok" },
        { orderId: ids[1], outcome: "rejected", code: "CLICK_NOT_FOUND" },
        { orderId: ids[2], outcome: "retryable", code: "CONCURRENT_MODIFICATION" },
        // ids[3] は結果が返ってこなかった
      ],
    }));
    const report = await runUploadPass(env.ATTR_DB, h.cfg, r.sender, new Date(h.nowMs));
    expect(report).toMatchObject({ sent: 4, uploaded: 1, failed: 1, retry: 2 });
    expect((await statusOf(ids[0])).status).toBe("uploaded");
    expect(await statusOf(ids[1])).toMatchObject({ status: "failed", last_error_code: "CLICK_NOT_FOUND" });
    expect(await statusOf(ids[2])).toMatchObject({ status: "retry", attempts: 1 });
    expect(await statusOf(ids[3])).toMatchObject({ status: "retry", last_error_code: "missing_row_result" });
  });

  it("送ったものは二度送らない。再試行は待ち時間のあとだけ", async () => {
    const h = new Harness();
    const ids = await pendingInquiries(h, 2);
    let call = 0;
    const r = recorder((ev) => {
      call += 1;
      return {
        kind: "rows",
        rows: ev.map((e) => ({
          orderId: e.orderId,
          outcome: call === 1 && e.orderId === ids[1] ? "retryable" : "accepted",
          code: "x",
        })),
      };
    });
    await runUploadPass(env.ATTR_DB, h.cfg, r.sender, new Date(h.nowMs));
    await runUploadPass(env.ATTR_DB, h.cfg, r.sender, new Date(h.nowMs + 30 * 60_000));
    expect(r.batches).toHaveLength(1);
    await runUploadPass(env.ATTR_DB, h.cfg, r.sender, new Date(h.nowMs + 61 * 60_000));
    expect(r.batches).toHaveLength(2);
    expect(r.batches[1].map((e) => e.orderId)).toEqual([ids[1]]);
    expect((await statusOf(ids[1])).status).toBe("uploaded");
  });

  it("認証切れ・権限不足は行の回数を増やさず、全体を止める", async () => {
    const h = new Harness();
    const [id] = await pendingInquiries(h, 1);
    const r = recorder(() => ({ kind: "auth_error", code: "PERMISSION_DENIED" }));
    const report = await runUploadPass(env.ATTR_DB, h.cfg, r.sender, new Date(h.nowMs));
    expect(report.skipped).toBe("auth_error");
    expect(await statusOf(id)).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("一時的な障害・例外は再試行し、上限の回数で止める（無限に再試行しない）", async () => {
    const h = new Harness();
    const [id] = await pendingInquiries(h, 1);
    const r = recorder(() => {
      throw new Error("timeout");
    });
    let t = h.nowMs;
    for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) {
      await runUploadPass(env.ATTR_DB, h.cfg, r.sender, new Date(t));
      t += 25 * 3_600_000;
    }
    expect(r.batches).toHaveLength(MAX_ATTEMPTS);
    expect(await statusOf(id)).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
  });

  it("リクエスト全体の拒否（コンバージョンアクションの不整合など）も回数を数える", async () => {
    const h = new Harness();
    const [id] = await pendingInquiries(h, 1);
    const r = recorder(() => ({ kind: "request_rejected", code: "INVALID_CONVERSION_ACTION" }));
    await runUploadPass(env.ATTR_DB, h.cfg, r.sender, new Date(h.nowMs));
    expect(await statusOf(id)).toMatchObject({ status: "retry", attempts: 1, last_error_code: "INVALID_CONVERSION_ACTION" });
  });

  it("締め切り（クリックから90日・余裕12時間）を過ぎたものは送らない", async () => {
    const h = new Harness();
    const u = await h.adUser();
    h.advanceHours(24 * 89);
    const s = await h.session(USER_A);
    const { inquiryId } = await h.inquiry(s.body.session);
    const r = recorder(() => ({ kind: "rows", rows: [] }));
    await runUploadPass(env.ATTR_DB, h.cfg, r.sender, new Date(h.nowMs + 24 * 3_600_000 * 0.6));
    expect(r.batches).toHaveLength(0);
    expect((await statusOf(inquiryId)).status).toBe("expired");
    expect(u.adRef).toBeTruthy();
  });

  it("同意が無い・2件目として抑えたものは送らない", async () => {
    const h = new Harness();
    const u = await h.adUser(USER_B);
    await h.inquiry(u.session);
    const second = await h.inquiry(u.session);
    await env.ATTR_DB.prepare(`UPDATE conversion_uploads SET status = 'blocked_consent' WHERE inquiry_id <> ?1`)
      .bind(second.inquiryId)
      .run();
    const r = recorder(() => ({ kind: "rows", rows: [] }));
    await runUploadPass(env.ATTR_DB, h.cfg, r.sender, new Date(h.nowMs));
    expect(r.batches).toHaveLength(0);
  });

  it("相手が返した文はそのまま保存しない（決まった形のコードだけ）", () => {
    expect(safeCode("CLICK_NOT_FOUND")).toBe("CLICK_NOT_FOUND");
    expect(safeCode("The click for gclid Cj0K... was not found")).toBe("unknown");
    expect(safeCode(undefined)).toBe("unknown");
  });
});

describe("日時の形", () => {
  it("UTC を日本時間の Google 広告の形にする", () => {
    expect(formatJstDateTime("2026-10-21T15:30:05.000Z")).toBe("2026-10-22 00:30:05+09:00");
  });
});
