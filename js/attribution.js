(function () {
  "use strict";

  // 広告帰属の記録（OASIS本店）。
  // - LINE への送信（liff.sendMessages）と booking_inquiry には一切触れない。
  // - どの関数も例外を投げない。記録に失敗しても予約の送信・画面を閉じる処理は今のまま。
  // - 端末に残すのは「送った予約希望の番号（inquiry_id）と時刻」だけ。届かなかった分を次に開いたときに送り直す。
  //   氏名・電話番号・LINE のID・クリック識別子は残さない。
  const cfg = window.OASIS_ATTRIBUTION_CONFIG || {};
  const ENDPOINT = typeof cfg.endpoint === "string" ? cfg.endpoint.replace(/\/+$/, "") : "";
  const PENDING_KEY = "oasis_attr_pending";
  const MAX_PENDING = 5;
  const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  let sessionPromise = null;

  function enabled() {
    return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(ENDPOINT) && typeof window.fetch === "function";
  }

  function readPending() {
    try {
      const list = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]");
      if (!Array.isArray(list)) return [];
      const now = Date.now();
      return list.filter(
        (e) => e && UUID_V4_RE.test(e.id) && typeof e.at === "string" && now - Date.parse(e.at) < PENDING_TTL_MS
      );
    } catch (_) {
      return [];
    }
  }

  function writePending(list) {
    try {
      if (list.length === 0) localStorage.removeItem(PENDING_KEY);
      else localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-MAX_PENDING)));
    } catch (_) {
      // 端末に保存できなくても、その場の送信は試みる。
    }
  }

  function removePending(id) {
    writePending(readPending().filter((e) => e.id !== id));
  }

  function post(path, body, keepalive) {
    // text/plain にしてプリフライト（事前の問い合わせ）を省き、閉じる前に届きやすくする。
    return window
      .fetch(ENDPOINT + path, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(body),
        keepalive: Boolean(keepalive),
        credentials: "omit",
        mode: "cors",
      })
      .then((res) => res.json().catch(() => ({})).then((data) => ({ status: res.status, data })));
  }

  function currentIdToken() {
    try {
      const liff = window.liff;
      // LINE の外（ブラウザ）ではログインを求めない。送信もできないので記録の対象外。
      if (!liff || typeof liff.isInClient !== "function" || !liff.isInClient()) return null;
      const token = typeof liff.getIDToken === "function" ? liff.getIDToken() : null;
      if (!token) return null;
      const decoded = typeof liff.getDecodedIDToken === "function" ? liff.getDecodedIDToken() : null;
      // IDトークンは発行から1時間で切れる。切れていたら送らない（再ログインで画面を動かさない）。
      if (decoded && typeof decoded.exp === "number" && decoded.exp * 1000 <= Date.now() + 30 * 1000) return null;
      return token;
    } catch (_) {
      return null;
    }
  }

  function startSession() {
    if (sessionPromise) return sessionPromise;
    const ready = window.OasisLiffReady && typeof window.OasisLiffReady.then === "function" ? window.OasisLiffReady : Promise.resolve();
    sessionPromise = ready
      .then(() => {
        const token = currentIdToken();
        if (!token) return null;
        return post("/v1/session", { id_token: token }, false).then((r) =>
          r.status === 200 && r.data && typeof r.data.session === "string" ? r.data.session : null
        );
      })
      .catch(() => null);
    return sessionPromise;
  }

  function sendInquiry(session, entry, resent) {
    return post("/v1/inquiry", { session, inquiry_id: entry.id, submitted_at: entry.at, resent }, true)
      .then((r) => {
        // 受け付けた（200）・形が不正で何度送っても無駄（400）なら端末から消す。
        // 401（印の期限切れ）・429・503・通信失敗は残して、次に開いたときに送り直す。
        if (r.status === 200 || r.status === 400) removePending(entry.id);
      })
      .catch(() => {});
  }

  function newInquiryId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
      if (window.crypto && typeof window.crypto.getRandomValues === "function") {
        const b = window.crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      }
    } catch (_) {
      // 作れなければ記録しないだけ。
    }
    return null;
  }

  /** LINE への送信が成功したあとに呼ぶ。待たない・投げない。 */
  function recordInquiry(inquiryId) {
    try {
      if (!enabled() || typeof inquiryId !== "string" || !UUID_V4_RE.test(inquiryId)) return;
      const pending = readPending();
      let entry = pending.find((e) => e.id === inquiryId);
      if (!entry) {
        entry = { id: inquiryId, at: new Date().toISOString() };
        writePending(pending.concat(entry));
      }
      startSession().then((session) => {
        if (session) sendInquiry(session, entry, false);
      });
    } catch (_) {
      // 記録の失敗は予約に影響させない。
    }
  }

  function resendPending() {
    try {
      if (!enabled()) return;
      const pending = readPending();
      writePending(pending);
      if (pending.length === 0) return;
      startSession().then((session) => {
        if (!session) return;
        pending.forEach((entry) => sendInquiry(session, entry, true));
      });
    } catch (_) {
      // 送り直しに失敗しても次の機会がある。
    }
  }

  window.OasisAttribution = Object.freeze({ newInquiryId, recordInquiry });

  if (enabled()) {
    // フォームを開いた時点で、IDトークン（1時間で切れる）を12時間の印に替えておく。
    startSession();
    resendPending();
  }
})();
