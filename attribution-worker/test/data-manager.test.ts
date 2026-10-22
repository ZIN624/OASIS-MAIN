import { describe, expect, it } from "vitest";
import { toBase64Url, fromBase64Url } from "../src/crypto";
import {
  DATA_MANAGER_BASE,
  buildIngestRequest,
  classifyIngestResponse,
  classifyStatusResponse,
  createDataManagerSender,
} from "../src/data-manager";
import { DATA_MANAGER_SCOPE, GOOGLE_TOKEN_URL, parseServiceAccountKey } from "../src/google-auth";
import { readConfig, type DataManagerConfig } from "../src/config";
import type { ConversionEvent } from "../src/uploads";

const CFG: DataManagerConfig = {
  operatingAccountId: "1234567890",
  loginAccountId: null,
  conversionActionId: "987654321",
  validateOnly: false,
};

const EVENT: ConversionEvent = {
  orderId: "0b7f2a7e-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
  gclid: "Cj0KCQjw-test_gclid_ABCDEFGHIJKLMNOP",
  gbraid: null,
  wbraid: null,
  conversionAt: "2026-11-01T03:00:00.000Z",
  conversionAtRfc3339: "2026-11-01T12:00:00+09:00",
};

describe("リクエストの中身（events:ingest・1件）", () => {
  it("送信先・クリック識別子・時刻・取引ID・同意だけを入れる", () => {
    expect(buildIngestRequest(CFG, EVENT)).toEqual({
      destinations: [
        { operatingAccount: { accountType: "GOOGLE_ADS", accountId: "1234567890" }, productDestinationId: "987654321" },
      ],
      events: [
        {
          adIdentifiers: { gclid: EVENT.gclid },
          eventTimestamp: "2026-11-01T12:00:00+09:00",
          transactionId: EVENT.orderId,
          eventSource: "WEB",
          consent: { adUserData: "CONSENT_GRANTED" },
        },
      ],
      validateOnly: false,
    });
  });

  it("識別子は1つだけ: gclid が最優先（braid を足さない）、無ければ gbraid、それも無ければ wbraid", () => {
    const ids = (e: Partial<ConversionEvent>) =>
      (buildIngestRequest(CFG, { ...EVENT, ...e }).events as { adIdentifiers: unknown }[])[0].adIdentifiers;
    expect(ids({ gbraid: "gb_123456789012345678", wbraid: "wb_123456789012345678" })).toEqual({ gclid: EVENT.gclid });
    expect(ids({ gclid: null, gbraid: "gb_123456789012345678", wbraid: "wb_123456789012345678" })).toEqual({ gbraid: "gb_123456789012345678" });
    expect(ids({ gclid: null, wbraid: "wb_123456789012345678" })).toEqual({ wbraid: "wb_123456789012345678" });
  });

  it("管理アカウント経由なら loginAccount を足す。validateOnly はそのまま渡す", () => {
    const body = buildIngestRequest({ ...CFG, loginAccountId: "1112223333", validateOnly: true }, EVENT);
    expect((body.destinations as Record<string, unknown>[])[0].loginAccount).toEqual({ accountType: "GOOGLE_ADS", accountId: "1112223333" });
    expect(body.validateOnly).toBe(true);
  });

  it("氏名・電話番号・メール（userData）や値・通貨は入れない", () => {
    const text = JSON.stringify(buildIngestRequest(CFG, EVENT));
    expect(text).not.toMatch(/userData|emailAddress|phoneNumber|conversionValue|currency/);
  });
});

describe("events:ingest の応答の分類", () => {
  it("200 + requestId は受付。validateOnly のときは「確かめただけ」", () => {
    expect(classifyIngestResponse(200, { requestId: "126365e1-16d0" }, false)).toEqual({ kind: "accepted", requestId: "126365e1-16d0", warnings: 0 });
    expect(classifyIngestResponse(200, {}, true)).toEqual({ kind: "validated", warnings: 0 });
    expect(classifyIngestResponse(200, { requestId: "r", fieldWarnings: [{ fieldPath: "events[0].event_source", reason: "x" }] }, false)).toEqual({
      kind: "accepted",
      requestId: "r",
      warnings: 1,
    });
    expect(classifyIngestResponse(200, {}, false).kind).toBe("transient");
  });

  it("401・403 は認証、429・5xx は一時的", () => {
    expect(classifyIngestResponse(401, { error: { status: "UNAUTHENTICATED" } }, false)).toEqual({ kind: "auth_error", code: "UNAUTHENTICATED" });
    expect(classifyIngestResponse(403, { error: { status: "PERMISSION_DENIED" } }, false).kind).toBe("auth_error");
    expect(classifyIngestResponse(429, { error: { status: "RESOURCE_EXHAUSTED" } }, false).kind).toBe("transient");
    expect(classifyIngestResponse(503, null, false)).toEqual({ kind: "transient", code: "http_503" });
  });

  it("400 は、送信先の誤りなら全体を止め、行の中身の誤りならその行だけ failed", () => {
    const err = (field: string) => ({
      error: {
        status: "INVALID_ARGUMENT",
        details: [{ "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ field, reason: "INVALID_FORMAT", description: "gclid Cj0K... bad" }] }],
      },
    });
    expect(classifyIngestResponse(400, err("destinations[0].productDestinationId"), false)).toEqual({
      kind: "config_error",
      code: "destination:INVALID_FORMAT",
    });
    expect(classifyIngestResponse(400, err("events[0].ad_identifiers.gclid"), false)).toEqual({ kind: "rejected", code: "INVALID_FORMAT" });
    expect(classifyIngestResponse(404, { error: { status: "NOT_FOUND" } }, false).kind).toBe("config_error");
  });

  it("相手の説明文はコードに入らない", () => {
    const r = classifyIngestResponse(400, { error: { status: "INVALID ARGUMENT with gclid Cj0K" } }, false);
    expect(JSON.stringify(r)).not.toContain("Cj0K");
  });
});

describe("requestStatus:retrieve の応答の分類", () => {
  const st = (requestStatus: string, reason?: string) => ({
    requestStatusPerDestination: [
      { requestStatus, ...(reason ? { errorInfo: { errorCounts: [{ recordCount: "1", reason }] } } : {}) },
    ],
  });
  it("処理中・成功・重複・あとで・失敗", () => {
    expect(classifyStatusResponse(200, st("PROCESSING")).kind).toBe("processing");
    expect(classifyStatusResponse(200, st("REQUEST_STATUS_UNKNOWN")).kind).toBe("processing");
    expect(classifyStatusResponse(200, st("SUCCESS")).kind).toBe("success");
    expect(classifyStatusResponse(200, st("FAILED", "PROCESSING_ERROR_REASON_DUPLICATE_TRANSACTION_ID")).kind).toBe("duplicate");
    expect(classifyStatusResponse(200, st("FAILED", "PROCESSING_ERROR_REASON_DUPLICATE_GCLID")).kind).toBe("duplicate");
    expect(classifyStatusResponse(200, st("FAILED", "PROCESSING_ERROR_REASON_TOO_RECENT_CLICK"))).toEqual({
      kind: "retry_later",
      code: "PROCESSING_ERROR_REASON_TOO_RECENT_CLICK",
      hours: 12,
    });
    expect(classifyStatusResponse(200, st("FAILED", "PROCESSING_ERROR_REASON_EXPIRED_CLICK"))).toEqual({
      kind: "failed",
      code: "PROCESSING_ERROR_REASON_EXPIRED_CLICK",
    });
    expect(classifyStatusResponse(200, st("FAILED", "PROCESSING_ERROR_REASON_NO_CONSENT")).kind).toBe("failed");
    expect(classifyStatusResponse(200, st("PARTIAL_SUCCESS", "PROCESSING_ERROR_REASON_INVALID_GCLID")).kind).toBe("failed");
  });
  it("認証・見つからない・一時的", () => {
    expect(classifyStatusResponse(401, null).kind).toBe("auth_error");
    expect(classifyStatusResponse(404, null).kind).toBe("unknown");
    expect(classifyStatusResponse(500, null).kind).toBe("transient");
    expect(classifyStatusResponse(200, {}).kind).toBe("transient");
  });
});

async function makeServiceAccount() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
  const json = JSON.stringify({
    type: "service_account",
    client_email: "oasis-attr@example-project.iam.gserviceaccount.com",
    private_key: pem,
    private_key_id: "kid-1",
    token_uri: GOOGLE_TOKEN_URL,
  });
  return { json, publicKey: pair.publicKey };
}

/** Google のトークン発行と Data Manager API の代わり。JWT の署名と中身を本当に確かめる。 */
function fakeGoogle(publicKey: CryptoKey, opts: { ingest?: () => Response; status?: () => Response; tokenStatus?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url === GOOGLE_TOKEN_URL) {
      if (opts.tokenStatus) return Response.json({ error: "invalid_grant", error_description: "secret detail" }, { status: opts.tokenStatus });
      const assertion = new URLSearchParams(String(init.body)).get("assertion")!;
      const [h, c, s] = assertion.split(".");
      const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, fromBase64Url(s)!, new TextEncoder().encode(`${h}.${c}`));
      const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(c)!));
      if (!ok || claims.aud !== GOOGLE_TOKEN_URL || claims.scope !== DATA_MANAGER_SCOPE) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({ access_token: "ya29.test-token", expires_in: 3599, token_type: "Bearer" });
    }
    if (url === `${DATA_MANAGER_BASE}/events:ingest`) return opts.ingest ? opts.ingest() : Response.json({ requestId: "req-abc" });
    if (url.startsWith(`${DATA_MANAGER_BASE}/requestStatus:retrieve`)) {
      return opts.status ? opts.status() : Response.json({ requestStatusPerDestination: [{ requestStatus: "SUCCESS" }] });
    }
    return new Response("not found", { status: 404 });
  };
  return { calls, fetchImpl };
}

describe("Data Manager API の送り手（サービスアカウント）", () => {
  it("設定か鍵が欠けていたら作らない（送らない）", async () => {
    const sa = await makeServiceAccount();
    expect(createDataManagerSender(null, sa.json, fetch, () => 0)).toBeNull();
    expect(createDataManagerSender(CFG, undefined, fetch, () => 0)).toBeNull();
    expect(createDataManagerSender(CFG, "{}", fetch, () => 0)).toBeNull();
    // 別のトークン発行先が書かれた鍵は受け付けない（署名を外へ送らない）
    const evil = JSON.stringify({ ...JSON.parse(sa.json), token_uri: "https://evil.example/token" });
    expect(parseServiceAccountKey(evil)).toBeNull();
  });

  it("署名した JWT でトークンを取り、Bearer をつけて送る。トークンは使い回す", async () => {
    const sa = await makeServiceAccount();
    const g = fakeGoogle(sa.publicKey);
    const sender = createDataManagerSender(CFG, sa.json, g.fetchImpl, () => 1_800_000_000)!;
    expect(await sender.submit(EVENT)).toEqual({ kind: "accepted", requestId: "req-abc", warnings: 0 });
    expect(await sender.status("req-abc")).toEqual({ kind: "success" });
    expect(g.calls.map((c) => c.url)).toEqual([
      GOOGLE_TOKEN_URL,
      `${DATA_MANAGER_BASE}/events:ingest`,
      `${DATA_MANAGER_BASE}/requestStatus:retrieve?requestId=req-abc`,
    ]);
    const ingest = g.calls[1];
    expect((ingest.init.headers as Record<string, string>).authorization).toBe("Bearer ya29.test-token");
    expect(JSON.parse(String(ingest.init.body))).toEqual(buildIngestRequest(CFG, EVENT));
  });

  it("トークンが取れない（鍵の失効など）は認証エラー。説明文は持ち帰らない", async () => {
    const sa = await makeServiceAccount();
    const g = fakeGoogle(sa.publicKey, { tokenStatus: 400 });
    const sender = createDataManagerSender(CFG, sa.json, g.fetchImpl, () => 1_800_000_000)!;
    const r = await sender.submit(EVENT);
    expect(r).toEqual({ kind: "auth_error", code: "token_invalid_grant" });
    expect(JSON.stringify(r)).not.toContain("secret detail");
    expect(g.calls).toHaveLength(1);
  });

  it("通信が落ちたら一時的な失敗", async () => {
    const sa = await makeServiceAccount();
    const g = fakeGoogle(sa.publicKey, {
      ingest: () => {
        throw new TypeError("network");
      },
    });
    const sender = createDataManagerSender(CFG, sa.json, g.fetchImpl, () => 1_800_000_000)!;
    expect(await sender.submit(EVENT)).toEqual({ kind: "transient", code: "network" });
  });

  it("validateOnly の設定なら、200 でも取り込み扱いにしない", async () => {
    const sa = await makeServiceAccount();
    const g = fakeGoogle(sa.publicKey);
    const sender = createDataManagerSender({ ...CFG, validateOnly: true }, sa.json, g.fetchImpl, () => 1_800_000_000)!;
    expect(await sender.submit(EVENT)).toEqual({ kind: "validated", warnings: 0 });
    expect(JSON.parse(String(g.calls[1].init.body)).validateOnly).toBe(true);
  });

  it("base64url の補助（テスト用の確認）", () => {
    expect(toBase64Url(new Uint8Array([255, 254]))).toBe("__4");
  });
});

describe("Data Manager API の送り手の止め具", () => {
  it("開発・テスト用の偽の識別子（TEST_ / TEST-）は、トークンも取らずに拒否する（Google へ何も出ない）", async () => {
    const sa = await makeServiceAccount();
    const g = fakeGoogle(sa.publicKey);
    const sender = createDataManagerSender(CFG, sa.json, g.fetchImpl, () => 1_800_000_000)!;
    for (const ids of [
      { gclid: "TEST_STG_CLICK_0001_ABCDEFG", gbraid: null, wbraid: null },
      { gclid: null, gbraid: "test-gbraid-0001-ABCDEFG", wbraid: null },
      { gclid: null, gbraid: null, wbraid: "Test_wbraid_0001_ABCDEFG" },
      // 送る識別子は gclid だけでも、ほかの欄に偽物が混じっていたら行ごと拒否する
      { gclid: "Cj0KCQjw-real_looking_ABCDEFGHIJ", gbraid: "TEST_GBRAID_0001_ABCD", wbraid: null },
    ]) {
      expect(await sender.submit({ ...EVENT, ...ids })).toEqual({ kind: "rejected", code: "test_click_id" });
    }
    expect(g.calls).toHaveLength(0);
  });

  it("本物の識別子は、途中に test が含まれていても止めない", async () => {
    const sa = await makeServiceAccount();
    const g = fakeGoogle(sa.publicKey);
    const sender = createDataManagerSender(CFG, sa.json, g.fetchImpl, () => 1_800_000_000)!;
    expect((await sender.submit({ ...EVENT, gclid: "Cj0KCQjwTEST_ABCDEFGHIJKLMNOP" })).kind).toBe("accepted");
  });

  it("ステージングの設定で DM_VALIDATE_ONLY=false にしても、送る本文は validateOnly: true のまま", async () => {
    const cfg = readConfig({
      ATTR_DB: undefined as unknown as D1Database,
      ENV_NAME: "staging",
      DM_OPERATING_ACCOUNT_ID: "1234567890",
      DM_CONVERSION_ACTION_ID: "987654321",
      DM_VALIDATE_ONLY: "false",
    }).dataManager!;
    const sa = await makeServiceAccount();
    const g = fakeGoogle(sa.publicKey);
    const sender = createDataManagerSender(cfg, sa.json, g.fetchImpl, () => 1_800_000_000)!;
    expect(await sender.submit(EVENT)).toEqual({ kind: "validated", warnings: 0 });
    expect(JSON.parse(String(g.calls[1].init.body)).validateOnly).toBe(true);
  });
});
