// 送信の止め具: ステージングなどで設定を誤っても、Google へ実際に取り込ませない。
// 偽のクリック識別子は Google へ出さない。本物の gclid / gbraid / wbraid は止めない。
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { isTestClickId } from "../src/attribution";
import { readConfig, type Env } from "../src/config";
import { runUploadPass, type ConversionEvent, type ConversionSender } from "../src/uploads";
import { Harness, resetDb, rows, testConfig } from "./helpers";

beforeEach(resetDb);

const DM = { DM_OPERATING_ACCOUNT_ID: "1234567890", DM_CONVERSION_ACTION_ID: "987654321" };
const cfgOf = (vars: Partial<Env>) => readConfig({ ATTR_DB: env.ATTR_DB, ...DM, ...vars });
const sub = (n: number) => "U" + n.toString(16).padStart(32, "0");

function fakeSender() {
  const submitted: ConversionEvent[] = [];
  const checked: string[] = [];
  const sender: ConversionSender = {
    async submit(e) {
      submitted.push(e);
      return { kind: "accepted", requestId: `req-${submitted.length}`, warnings: 0 };
    },
    async status(id) {
      checked.push(id);
      return { kind: "success" };
    },
  };
  return { sender, submitted, checked };
}

/** 広告クリック（識別子を指定）→ 結びつけ → 予約希望。送れる時刻（6時間後）までは進めない。 */
async function adInquiry(h: Harness, n: number, ids: Record<string, string>): Promise<string> {
  const click = await h.adClick(ids);
  expect(click.status).toBe(201);
  await h.bind(click.body.ad_ref, sub(n));
  const s = await h.session(sub(n));
  return (await h.inquiry(s.body.session)).inquiryId;
}

const row = async (id: string) =>
  (
    await rows<{ status: string; attempts: number; last_error_code: string | null; next_attempt_at: string | null }>(
      `SELECT status, attempts, last_error_code, next_attempt_at FROM conversion_uploads WHERE inquiry_id = ?1`,
      id,
    )
  )[0];
const diag = async (code: string) =>
  (await rows<{ count: number }>(`SELECT count FROM diag_counters WHERE code = ?1`, code))[0]?.count ?? 0;

describe("実際に取り込ませてよいのは本番だけ（設定の読み取り）", () => {
  it("本番（ENV_NAME=production）で DM_VALIDATE_ONLY=false のときだけ、validateOnly が外れる", () => {
    const c = cfgOf({ ENV_NAME: "production", DM_VALIDATE_ONLY: "false" });
    expect(c.dataManager?.validateOnly).toBe(false);
    expect(c.uploadBlock).toBeNull();
  });

  it("本番でも、DM_VALIDATE_ONLY が true・未設定・空なら確かめるだけ", () => {
    for (const v of ["true", undefined, ""]) {
      const c = cfgOf({ ENV_NAME: "production", DM_VALIDATE_ONLY: v });
      expect(c.dataManager?.validateOnly).toBe(true);
      expect(c.uploadBlock).toBeNull();
    }
  });

  it("本番以外で DM_VALIDATE_ONLY=false にしたら、確かめるだけのまま止める（live_not_allowed）", () => {
    // ENV_NAME の書き間違い・未設定も「本番ではない」として扱う
    for (const name of ["staging", "development", "test", undefined, "", "Production", "prodution", " production-staging"]) {
      const c = cfgOf({ ENV_NAME: name, DM_VALIDATE_ONLY: "false" });
      expect(c.dataManager?.validateOnly, String(name)).toBe(true);
      expect(c.uploadBlock, String(name)).toBe("live_not_allowed");
    }
  });

  it("DM_VALIDATE_ONLY が true / false 以外なら、本番でも止める（validate_only_invalid）", () => {
    for (const v of ["False", "FALSE", "0", "no", " false", "false ", "off"]) {
      const c = cfgOf({ ENV_NAME: "production", DM_VALIDATE_ONLY: v });
      expect(c.dataManager?.validateOnly, v).toBe(true);
      expect(c.uploadBlock, v).toBe("validate_only_invalid");
    }
  });
});

describe("設定の誤りでは、送信の処理が Google に何も出さずに止まる", () => {
  it("ステージングで DM_VALIDATE_ONLY=false: 送らない・確かめない・行は変えない・診断に残す", async () => {
    const h = new Harness(undefined, testConfig({ ENV_NAME: "staging", DM_VALIDATE_ONLY: "false" }));
    const id = await adInquiry(h, 1, { gclid: "Cj0KCQjw-staging_click_ABCDEFGH" });
    // 結果待ちの行（以前に送ったもの）も確かめに行かない
    await env.ATTR_DB.prepare(
      `UPDATE conversion_uploads SET status = 'submitted', request_id = 'req-old', submitted_at = ?2, next_attempt_at = ?2 WHERE inquiry_id = ?1`,
    )
      .bind(id, h.nowIso())
      .run();
    h.advanceHours(6);
    const f = fakeSender();
    const report = await runUploadPass(env.ATTR_DB, h.cfg, f.sender, new Date(h.nowMs));
    expect(report.skipped).toBe("blocked");
    expect(report.blocked).toBe("live_not_allowed");
    expect(f.submitted).toHaveLength(0);
    expect(f.checked).toHaveLength(0);
    expect((await row(id)).status).toBe("submitted");
    expect(await diag("upload_live_not_allowed")).toBe(1);
  });

  it("DM_VALIDATE_ONLY の値が不正なら、本番でも止める", async () => {
    const h = new Harness(undefined, testConfig({ ENV_NAME: "production", DM_VALIDATE_ONLY: "False" }));
    const id = await adInquiry(h, 1, { gclid: "Cj0KCQjw-prod_click_ABCDEFGHIJ" });
    h.advanceHours(6);
    const f = fakeSender();
    const report = await runUploadPass(env.ATTR_DB, h.cfg, f.sender, new Date(h.nowMs));
    expect(report).toMatchObject({ skipped: "blocked", blocked: "validate_only_invalid" });
    expect(f.submitted).toHaveLength(0);
    expect((await row(id)).status).toBe("pending");
    expect(await diag("upload_validate_only_invalid")).toBe(1);
  });

  it("設定を直せば、止まっていた行はそのまま送られる", async () => {
    const h = new Harness(undefined, testConfig({ ENV_NAME: "staging", DM_VALIDATE_ONLY: "false" }));
    const id = await adInquiry(h, 1, { gclid: "Cj0KCQjw-staging_click_ABCDEFGH" });
    h.advanceHours(6);
    const f = fakeSender();
    await runUploadPass(env.ATTR_DB, h.cfg, f.sender, new Date(h.nowMs));
    h.cfg = testConfig({ ENV_NAME: "staging", DM_VALIDATE_ONLY: "true" });
    await runUploadPass(env.ATTR_DB, h.cfg, f.sender, new Date(h.nowMs));
    expect(f.submitted.map((e) => e.orderId)).toEqual([id]);
  });
});

describe("開発・テスト用の偽のクリック識別子", () => {
  it("決まり: 先頭が TEST_ / TEST-（大文字小文字は問わない）。途中の test は対象外", () => {
    for (const id of ["TEST_STG_CLICK_0001", "test-gclid-0001", "Test_x", "TEST-"]) expect(isTestClickId(id), id).toBe(true);
    for (const id of ["Cj0KCQjw-test_gclid_ABCDEFG", "TESTgclid0001ABCD", "EAIaIQobChMI_TEST_x", "xTEST_", "", null, undefined]) {
      expect(isTestClickId(id), String(id)).toBe(false);
    }
  });

  it("偽の識別子の行は送らずに failed（test_click_id）。同じ回の本物の gclid・gbraid・wbraid は送る", async () => {
    const h = new Harness(undefined, testConfig({ ENV_NAME: "production" }));
    const fakeGclid = await adInquiry(h, 1, { gclid: "TEST_STG_CLICK_0001_ABCDEFG" });
    const fakeGbraid = await adInquiry(h, 2, { gbraid: "test-gbraid-0001-ABCDEFG" });
    const realGclid = await adInquiry(h, 3, { gclid: "Cj0KCQjw-test_gclid_real_ABCDEFG" });
    const realGbraid = await adInquiry(h, 4, { gbraid: "0AAAAADr_real_gbraid_ABCDEFG" });
    const realWbraid = await adInquiry(h, 5, { wbraid: "CkQKCQjw_real_wbraid_ABCDEFG" });
    h.advanceHours(6);
    const f = fakeSender();
    const report = await runUploadPass(env.ATTR_DB, h.cfg, f.sender, new Date(h.nowMs));

    expect(f.submitted.map((e) => e.orderId).sort()).toEqual([realGclid, realGbraid, realWbraid].sort());
    expect(report.submitted).toBe(3);
    for (const id of [fakeGclid, fakeGbraid]) {
      expect(await row(id)).toMatchObject({ status: "failed", attempts: 0, last_error_code: "test_click_id", next_attempt_at: null });
    }
    expect(await diag("upload_test_click_blocked")).toBe(2);

    // 次の回も送らない（failed のまま）
    h.advanceHours(1);
    await runUploadPass(env.ATTR_DB, h.cfg, f.sender, new Date(h.nowMs));
    expect(f.submitted).toHaveLength(3);
  });

  it("確かめるだけ（validateOnly）のときも、偽の識別子は送らない", async () => {
    const h = new Harness(undefined, testConfig({ ENV_NAME: "staging", DM_VALIDATE_ONLY: "true" }));
    const id = await adInquiry(h, 1, { gclid: "TEST_STG_CLICK_0002_ABCDEFG" });
    h.advanceHours(6);
    const f = fakeSender();
    await runUploadPass(env.ATTR_DB, h.cfg, f.sender, new Date(h.nowMs));
    expect(f.submitted).toHaveLength(0);
    expect((await row(id)).last_error_code).toBe("test_click_id");
  });
});
