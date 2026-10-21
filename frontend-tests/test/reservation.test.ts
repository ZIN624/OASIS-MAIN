import { describe, expect, it } from "vitest";
import { ENDPOINT, fakeFetch, fakeLiff, fillAndConfirm, loadPage, pressSend, returningCustomerStorage, wait } from "./page";

const expectedMessage = (date: string) =>
  [
    "予約希望メッセージ",
    "予約者名: オアシス太郎",
    "フリガナ: オアシスタロウ",
    "性別: 男性",
    "ステータス: 再来",
    "電話番号: 09012345678",
    "メニュー: カット",
    "担当スタイリスト: 店長",
    `第1希望: ${date} 9:00`,
    "備考: なし",
    "",
    "ご予約希望ありがとうございます。",
    "確認いたしますのでお待ちください。",
  ].join("\n");

const inquiryEvents = (calls: unknown[][]) => calls.filter((c) => c[0] === "event" && c[1] === "booking_inquiry");

// このブロックは、変更前（main）のコードでもそのまま通ること（FORM_ROOT=… で確かめる）。
describe("いまの予約の動き（変えていないこと）", () => {
  it("送信が成功したら、同じ文面を1回送り、booking_inquiry を1回送り、画面を閉じる", async () => {
    const liff = fakeLiff();
    const { doc, w, gtagCalls } = await loadPage({ liff, storage: returningCustomerStorage() });
    const date = fillAndConfirm(doc);
    pressSend(doc);
    await wait(50);
    expect(liff.sendMessages).toHaveBeenCalledTimes(1);
    expect(liff.sendMessages).toHaveBeenCalledWith([{ type: "text", text: expectedMessage(date) }]);
    expect(w.alert).toHaveBeenCalledWith("予約内容を送信しました。");
    const events = inquiryEvents(gtagCalls);
    expect(events).toHaveLength(1);
    expect(events[0][2]).toMatchObject({ send_to: "G-D9P3LB3Q1C", mode: "liff" });
    expect(liff.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("送信に失敗したら、エラーを出し、booking_inquiry も画面を閉じる処理もしない", async () => {
    const liff = fakeLiff({ send: () => Promise.reject(new Error("403")) });
    const { doc, w, gtagCalls } = await loadPage({ liff, storage: returningCustomerStorage() });
    fillAndConfirm(doc);
    pressSend(doc);
    await wait(50);
    expect(w.alert).toHaveBeenCalledWith("送信エラー: 403");
    expect(inquiryEvents(gtagCalls)).toHaveLength(0);
    expect(liff.closeWindow).not.toHaveBeenCalled();
  });

  it("同意にチェックが無ければ送らない", async () => {
    const liff = fakeLiff();
    const { doc } = await loadPage({ liff, storage: returningCustomerStorage() });
    fillAndConfirm(doc);
    (doc.getElementById("agreeCheckbox") as HTMLInputElement).checked = false;
    pressSend(doc);
    await wait(20);
    expect(liff.sendMessages).not.toHaveBeenCalled();
  });

  it("booking_inquiry はフォーム1回につき1回だけ（二重タップでも）", async () => {
    const liff = fakeLiff();
    const { doc, gtagCalls } = await loadPage({ liff, storage: returningCustomerStorage() });
    fillAndConfirm(doc);
    pressSend(doc);
    pressSend(doc);
    await wait(50);
    expect(inquiryEvents(gtagCalls)).toHaveLength(1);
  });
});

describe("広告帰属の記録（追加したもの）", () => {
  it("設定が空のあいだは、外への通信を一切しない（いまの本番と同じ）", async () => {
    const fetch = fakeFetch(async () => ({ status: 200 }));
    const liff = fakeLiff();
    const { doc } = await loadPage({ liff, fetch, storage: returningCustomerStorage() });
    fillAndConfirm(doc);
    pressSend(doc);
    await wait(50);
    expect(fetch).not.toHaveBeenCalled();
    expect(liff.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("フォームを開いたら印をもらい、送信が成功したあとに inquiry_id を送る", async () => {
    const calls: { url: string; body: any; keepalive: boolean }[] = [];
    const fetch = fakeFetch(async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)), keepalive: Boolean(init.keepalive) });
      if (url.endsWith("/v1/session")) return { status: 200, body: { ok: true, session: "sess" } };
      return { status: 200, body: { ok: true } };
    });
    const liff = fakeLiff();
    const { doc, w } = await loadPage({ liff, fetch, configured: true, storage: returningCustomerStorage() });
    await wait(10);
    expect(calls.map((c) => c.url)).toEqual([`${ENDPOINT}/v1/session`]);
    expect(calls[0].body).toEqual({ id_token: "header.payload.sig" });
    fillAndConfirm(doc);
    pressSend(doc);
    await wait(50);
    const inquiry = calls.find((c) => c.url.endsWith("/v1/inquiry"));
    expect(inquiry?.keepalive).toBe(true);
    expect(inquiry?.body).toMatchObject({ session: "sess", resent: false });
    expect(inquiry?.body.inquiry_id).toMatch(/^[0-9a-f-]{36}$/);
    // 氏名・電話番号・メニューは送らない。
    const sent = JSON.stringify(calls);
    expect(sent).not.toContain("オアシス太郎");
    expect(sent).not.toContain("09012345678");
    expect(sent).not.toContain("カット");
    // 受け付けられたら端末の控えは消える。
    expect(w.localStorage.getItem("oasis_attr_pending")).toBeNull();
    expect(liff.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("LINE への送信が失敗したら、帰属の記録は送らない", async () => {
    const fetch = fakeFetch(async (url) => (url.endsWith("/v1/session") ? { status: 200, body: { session: "s" } } : { status: 200 }));
    const liff = fakeLiff({ send: () => Promise.reject(new Error("x")) });
    const { doc } = await loadPage({ liff, fetch, configured: true, storage: returningCustomerStorage() });
    fillAndConfirm(doc);
    pressSend(doc);
    await wait(50);
    expect(fetch.mock.calls.map((c) => c[0])).not.toContain(`${ENDPOINT}/v1/inquiry`);
  });

  it("Worker が止まっていても（通信エラー）、送信・計測・画面を閉じる処理は変わらない", async () => {
    const fetch = fakeFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const liff = fakeLiff();
    const { doc, w, gtagCalls } = await loadPage({ liff, fetch, configured: true, storage: returningCustomerStorage() });
    fillAndConfirm(doc);
    pressSend(doc);
    await wait(50);
    expect(liff.sendMessages).toHaveBeenCalledTimes(1);
    expect(inquiryEvents(gtagCalls)).toHaveLength(1);
    expect(liff.closeWindow).toHaveBeenCalledTimes(1);
    expect(w.alert).not.toHaveBeenCalledWith(expect.stringContaining("送信エラー"));
    // 届かなかった分は端末に控えとして残る（番号と時刻だけ）。
    const pending = JSON.parse(w.localStorage.getItem("oasis_attr_pending") ?? "[]");
    expect(pending).toHaveLength(1);
    expect(Object.keys(pending[0]).sort()).toEqual(["at", "id"]);
  });

  it("帰属の記録が例外を投げても、予約は成功のまま", async () => {
    const liff = fakeLiff();
    const { doc, w } = await loadPage({ liff, configured: true, storage: returningCustomerStorage() });
    Object.defineProperty(w, "OasisAttribution", {
      value: {
        newInquiryId: () => "11111111-1111-4111-8111-111111111111",
        recordInquiry: () => {
          throw new Error("boom");
        },
      },
    });
    fillAndConfirm(doc);
    pressSend(doc);
    await wait(50);
    expect(w.alert).toHaveBeenCalledWith("予約内容を送信しました。");
    expect(w.alert).not.toHaveBeenCalledWith(expect.stringContaining("送信エラー"));
    expect(liff.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("二重タップ・同じ確認画面での再送信では同じ inquiry_id、確認画面をやり直すと別の inquiry_id", async () => {
    const ids: string[] = [];
    const fetch = fakeFetch(async (url, init) => {
      if (url.endsWith("/v1/session")) return { status: 200, body: { session: "s" } };
      ids.push(JSON.parse(String(init.body)).inquiry_id);
      return { status: 503 };
    });
    let fail = true;
    const liff = fakeLiff({ send: () => (fail ? Promise.reject(new Error("x")) : Promise.resolve()) });
    const { doc } = await loadPage({ liff, fetch, configured: true, storage: returningCustomerStorage() });
    fillAndConfirm(doc);
    pressSend(doc);
    await wait(20);
    fail = false;
    pressSend(doc);
    pressSend(doc);
    await wait(50);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    (doc.getElementById("editReservation") as HTMLButtonElement).click();
    (doc.getElementById("submitReservation") as HTMLButtonElement).click();
    pressSend(doc);
    await wait(50);
    expect(new Set(ids).size).toBe(2);
  });

  it("送ったあとすぐ閉じて届かなかった分は、次に開いたときに元の時刻のまま送り直す", async () => {
    const pending = [{ id: "22222222-2222-4222-8222-222222222222", at: new Date(Date.now() - 3_600_000).toISOString() }];
    const bodies: any[] = [];
    const fetch = fakeFetch(async (url, init) => {
      if (url.endsWith("/v1/session")) return { status: 200, body: { session: "s2" } };
      bodies.push(JSON.parse(String(init.body)));
      return { status: 200 };
    });
    const { w } = await loadPage({
      liff: fakeLiff(),
      fetch,
      configured: true,
      storage: returningCustomerStorage({ oasis_attr_pending: JSON.stringify(pending) }),
    });
    await wait(30);
    expect(bodies).toEqual([{ session: "s2", inquiry_id: pending[0].id, submitted_at: pending[0].at, resent: true }]);
    expect(w.localStorage.getItem("oasis_attr_pending")).toBeNull();
  });

  it("7日を過ぎた控え・壊れた控えは送らずに捨てる", async () => {
    const old = [
      { id: "33333333-3333-4333-8333-333333333333", at: new Date(Date.now() - 8 * 86_400_000).toISOString() },
      { id: "not-a-uuid", at: new Date().toISOString() },
    ];
    const fetch = fakeFetch(async (url) => (url.endsWith("/v1/session") ? { status: 200, body: { session: "s" } } : { status: 200 }));
    const { w } = await loadPage({
      liff: fakeLiff(),
      fetch,
      configured: true,
      storage: returningCustomerStorage({ oasis_attr_pending: JSON.stringify(old) }),
    });
    await wait(30);
    expect(fetch.mock.calls.map((c) => c[0])).not.toContain(`${ENDPOINT}/v1/inquiry`);
    expect(w.localStorage.getItem("oasis_attr_pending")).toBeNull();
  });

  it("LINE の外で開いた・IDトークンが無い・期限切れなら、印をもらわない", async () => {
    for (const liff of [
      fakeLiff({ inClient: false }),
      fakeLiff({ idToken: null }),
      fakeLiff({ expSec: Math.floor(Date.now() / 1000) - 10 }),
    ]) {
      const fetch = fakeFetch(async () => ({ status: 200 }));
      await loadPage({ liff, fetch, configured: true, storage: returningCustomerStorage() });
      await wait(10);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("LIFF の初期化に失敗しても、いまと同じ案内を出すだけで、記録は試みない", async () => {
    const fetch = fakeFetch(async () => ({ status: 200 }));
    const liff = fakeLiff({ initFails: true, idToken: null });
    const { w } = await loadPage({ liff, fetch, configured: true, storage: returningCustomerStorage() });
    await wait(10);
    expect(w.alert).toHaveBeenCalledWith("LIFFの初期化に失敗しました。通信環境やLINEアプリ内表示をご確認ください。");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("印の期限切れ（401）・混雑（429）は控えを残し、形の不正（400）は捨てる", async () => {
    for (const [status, kept] of [
      [401, true],
      [429, true],
      [400, false],
    ] as const) {
      const fetch = fakeFetch(async (url) => (url.endsWith("/v1/session") ? { status: 200, body: { session: "s" } } : { status }));
      const { doc, w } = await loadPage({ liff: fakeLiff(), fetch, configured: true, storage: returningCustomerStorage() });
      fillAndConfirm(doc);
      pressSend(doc);
      await wait(50);
      expect(w.localStorage.getItem("oasis_attr_pending") !== null).toBe(kept);
    }
  });
});
