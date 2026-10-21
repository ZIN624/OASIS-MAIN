import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { formatJstDateTime, formatJstRfc3339 } from "../src/attribution";
import {
  MAX_ATTEMPTS,
  runUploadPass,
  safeCode,
  type ConversionEvent,
  type ConversionSender,
  type StatusResult,
  type SubmitResult,
} from "../src/uploads";
import { Harness, USER_A, resetDb, rows, testConfig } from "./helpers";

beforeEach(resetDb);

const sub = (n: number) => "U" + n.toString(16).padStart(32, "0");
const HOUR = 3_600_000;

/** Data Manager API の代わり。送った中身と確かめた requestId を記録する。 */
function fakeSender(opts: {
  submit?: (e: ConversionEvent, n: number) => SubmitResult | Promise<SubmitResult>;
  status?: (requestId: string, n: number) => StatusResult | Promise<StatusResult>;
}) {
  const submitted: ConversionEvent[] = [];
  const checked: string[] = [];
  const sender: ConversionSender = {
    async submit(e) {
      submitted.push(e);
      return opts.submit ? opts.submit(e, submitted.length) : { kind: "accepted", requestId: `req-${submitted.length}` };
    },
    async status(id) {
      checked.push(id);
      return opts.status ? opts.status(id, checked.length) : { kind: "success" };
    },
  };
  return { sender, submitted, checked };
}

/** 広告経由の予約希望を n 件（別々の人・別々のクリック）作り、送れる時刻（クリックの6時間後）まで進める。 */
async function pendingInquiries(h: Harness, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    // 別々の人・別々の広告クリック（同じクリックの2件目は送らない決まりのため）
    const u = await h.adUser(sub(i + 1), `Cj0KCQjw-test_click_${String(i).padStart(4, "0")}_ABCDEFGH`);
    ids.push((await h.inquiry(u.session)).inquiryId);
  }
  h.advanceHours(6);
  return ids;
}

const row = async (id: string) =>
  (
    await rows<{ status: string; attempts: number; last_error_code: string | null; next_attempt_at: string | null; request_id: string | null }>(
      `SELECT status, attempts, last_error_code, next_attempt_at, request_id FROM conversion_uploads WHERE inquiry_id = ?1`,
      id,
    )
  )[0];

const pass = (h: Harness, s: ConversionSender | null, offsetMs = 0) =>
  runUploadPass(env.ATTR_DB, h.cfg, s, new Date(h.nowMs + offsetMs));

describe("Google 広告への送信（2段階：送る → 結果を確かめる）", () => {
  it("送信のスイッチが false・sender が無い（設定・鍵が無い）なら何もしない", async () => {
    const off = new Harness(undefined, testConfig({ UPLOAD_ENABLED: "false" }));
    const [id] = await pendingInquiries(off, 1);
    const f = fakeSender({});
    expect((await pass(off, f.sender)).skipped).toBe("disabled");
    expect((await pass(new Harness(), null)).skipped).toBe("not_configured");
    expect(f.submitted).toHaveLength(0);
    expect((await row(id)).status).toBe("pending");
  });

  it("クリックから6時間たつまでは送らない（Google がまだクリックを処理していないため）", async () => {
    const h = new Harness();
    const u = await h.adUser();
    await h.inquiry(u.session);
    const f = fakeSender({});
    await pass(h, f.sender, 5 * HOUR);
    expect(f.submitted).toHaveLength(0);
    await pass(h, f.sender, 6 * HOUR + 1000);
    expect(f.submitted).toHaveLength(1);
  });

  it("送る中身はクリック識別子・時刻・取引IDだけ（個人情報は入らない）", async () => {
    const h = new Harness();
    const [id] = await pendingInquiries(h, 1);
    const f = fakeSender({});
    await pass(h, f.sender);
    expect(f.submitted[0]).toEqual({
      orderId: id,
      gclid: expect.stringMatching(/^Cj0KCQjw-test_click_0000_/),
      gbraid: null,
      wbraid: null,
      conversionAt: expect.any(String),
      conversionAtRfc3339: formatJstRfc3339(f.submitted[0].conversionAt),
    });
    expect(JSON.stringify(f.submitted)).not.toContain(USER_A);
  });

  it("受け付けられたら submitted。30分後に結果を確かめ、成功なら uploaded", async () => {
    const h = new Harness();
    const [id] = await pendingInquiries(h, 1);
    const f = fakeSender({});
    const r1 = await pass(h, f.sender);
    expect(r1.submitted).toBe(1);
    expect(await row(id)).toMatchObject({ status: "submitted", attempts: 1, request_id: "req-1" });
    await pass(h, f.sender, 10 * 60_000);
    expect(f.checked).toHaveLength(0);
    await pass(h, f.sender, 31 * 60_000);
    expect(f.checked).toEqual(["req-1"]);
    expect((await row(id)).status).toBe("uploaded");
    // 取り込まれたものは二度と送らない。
    await pass(h, f.sender, 50 * HOUR);
    expect(f.submitted).toHaveLength(1);
  });

  it("処理中のあいだは間をあけて確かめ、26時間たっても終わらなければ同じ取引IDで送り直す", async () => {
    const h = new Harness();
    const [id] = await pendingInquiries(h, 1);
    const f = fakeSender({ status: () => ({ kind: "processing" }) });
    await pass(h, f.sender);
    for (let t = 0.5; t <= 40; t += 0.5) await pass(h, f.sender, t * HOUR);
    // 30分ごとに80回動いても、確認の間隔は 1h, 2h, 4h, 8h, 8h…と広がるので、確認は十数回で済む（2回目の送信の分も含む）。
    expect(f.checked.length).toBeGreaterThan(5);
    expect(f.checked.length).toBeLessThan(14);
    expect(f.submitted.length).toBe(2);
    expect(f.submitted[1].orderId).toBe(id);
  });

  it("結果: 重複（同じ取引ID・同じクリック）は duplicate、取り込めない理由は failed、あとで送り直す理由は retry", async () => {
    const h = new Harness();
    const ids = await pendingInquiries(h, 3);
    const outcomes: StatusResult[] = [
      { kind: "duplicate", code: "PROCESSING_ERROR_REASON_DUPLICATE_TRANSACTION_ID" },
      { kind: "failed", code: "PROCESSING_ERROR_REASON_CLICK_NOT_FOUND" },
      { kind: "retry_later", code: "PROCESSING_ERROR_REASON_TOO_RECENT_CLICK", hours: 12 },
    ];
    const f = fakeSender({ status: (_id, n) => outcomes[n - 1] });
    await pass(h, f.sender);
    await pass(h, f.sender, 31 * 60_000);
    expect(await row(ids[0])).toMatchObject({ status: "duplicate" });
    expect(await row(ids[1])).toMatchObject({ status: "failed", last_error_code: "PROCESSING_ERROR_REASON_CLICK_NOT_FOUND" });
    const retry = await row(ids[2]);
    expect(retry).toMatchObject({ status: "retry", request_id: null });
    expect(Date.parse(retry.next_attempt_at!) - (h.nowMs + 31 * 60_000)).toBe(12 * HOUR);
  });

  it("送ったときに中身を拒否された（400）ものは failed。直すまで送らない", async () => {
    const h = new Harness();
    const [id] = await pendingInquiries(h, 1);
    const f = fakeSender({ submit: () => ({ kind: "rejected", code: "INVALID_FORMAT" }) });
    await pass(h, f.sender);
    await pass(h, f.sender, 48 * HOUR);
    expect(f.submitted).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: "failed", last_error_code: "INVALID_FORMAT" });
  });

  it("認証の失敗・送信先の設定の誤りは、行の回数を増やさず全体を止める", async () => {
    for (const r of [
      { kind: "auth_error", code: "PERMISSION_DENIED" },
      { kind: "config_error", code: "destination:INVALID_ARGUMENT" },
    ] as SubmitResult[]) {
      await resetDb();
      const h = new Harness();
      const ids = await pendingInquiries(h, 2);
      const f = fakeSender({ submit: () => r });
      const report = await pass(h, f.sender);
      expect(report.skipped).toBe(r.kind);
      expect(f.submitted).toHaveLength(1);
      expect(await row(ids[0])).toMatchObject({ status: "pending", attempts: 0 });
      expect(await row(ids[1])).toMatchObject({ status: "pending", attempts: 0 });
    }
  });

  it("結果の確認で認証が切れていたら止める（結果待ちのまま残る）", async () => {
    const h = new Harness();
    const [id] = await pendingInquiries(h, 1);
    const f = fakeSender({ status: () => ({ kind: "auth_error", code: "http_401" }) });
    await pass(h, f.sender);
    const r = await pass(h, f.sender, 31 * 60_000);
    expect(r.skipped).toBe("auth_error");
    expect((await row(id)).status).toBe("submitted");
  });

  it("一時的な障害・例外は待って送り直し、上限の回数で打ち切る（無限に送り直さない）", async () => {
    const h = new Harness();
    const [id] = await pendingInquiries(h, 1);
    const f = fakeSender({
      submit: () => {
        throw new Error("timeout");
      },
    });
    for (let i = 0; i < MAX_ATTEMPTS + 3; i += 1) await pass(h, f.sender, i * 25 * HOUR);
    expect(f.submitted).toHaveLength(MAX_ATTEMPTS);
    expect(await row(id)).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
  });

  it("「あとで送り直す」が続いても、送った回数の上限で止まる", async () => {
    const h = new Harness();
    const [id] = await pendingInquiries(h, 1);
    const f = fakeSender({ status: () => ({ kind: "retry_later", code: "PROCESSING_ERROR_REASON_TOO_RECENT_CLICK", hours: 12 }) });
    for (let i = 0; i < 40; i += 1) await pass(h, f.sender, i * 6 * HOUR);
    expect(f.submitted).toHaveLength(MAX_ATTEMPTS);
    expect((await row(id)).status).toBe("failed");
  });

  it("validateOnly（確かめるだけ）の結果は取り込み扱いにせず、1日あけてまた確かめる", async () => {
    const h = new Harness();
    const [id] = await pendingInquiries(h, 1);
    const f = fakeSender({ submit: () => ({ kind: "validated" }) });
    const r = await pass(h, f.sender);
    expect(r.validated).toBe(1);
    expect(await row(id)).toMatchObject({ status: "pending", attempts: 0, last_error_code: "validated_only" });
    await pass(h, f.sender, HOUR);
    expect(f.submitted).toHaveLength(1);
    await pass(h, f.sender, 25 * HOUR);
    expect(f.submitted).toHaveLength(2);
  });

  it("締め切り（クリックから90日・余裕12時間）を過ぎたものは送らない", async () => {
    const h = new Harness();
    await h.adUser();
    h.advanceHours(24 * 89);
    const s = await h.session(USER_A);
    const { inquiryId } = await h.inquiry(s.body.session);
    const f = fakeSender({});
    await pass(h, f.sender, 0.6 * 24 * HOUR);
    expect(f.submitted).toHaveLength(0);
    expect((await row(inquiryId)).status).toBe("expired");
  });

  it("1回の実行で送る件数には上限がある（件数に比例して通信を増やさない）", async () => {
    const h = new Harness();
    await pendingInquiries(h, 12);
    const f = fakeSender({});
    await pass(h, f.sender);
    expect(f.submitted).toHaveLength(10);
    await pass(h, f.sender, 60_000);
    expect(f.submitted).toHaveLength(12);
  });

  it("相手が返した文はそのまま保存しない（決まった形のコードだけ）", () => {
    expect(safeCode("PROCESSING_ERROR_REASON_CLICK_NOT_FOUND")).toBe("PROCESSING_ERROR_REASON_CLICK_NOT_FOUND");
    expect(safeCode("The click for gclid Cj0K... was not found")).toBe("unknown");
    expect(safeCode(undefined)).toBe("unknown");
  });
});

describe("日時の形", () => {
  it("UTC を日本時間にする（Google 広告 API の形と RFC 3339）", () => {
    expect(formatJstDateTime("2026-10-21T15:30:05.000Z")).toBe("2026-10-22 00:30:05+09:00");
    expect(formatJstRfc3339("2026-10-21T15:30:05.000Z")).toBe("2026-10-22T00:30:05+09:00");
  });
});
