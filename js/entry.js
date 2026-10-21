(function () {
  "use strict";

  // 広告から来た人だけが通る入口（LIFF）。
  // ここで何が失敗しても、最後はいつもの LINE 友だち追加リンクへ進む（予約の導線を止めない）。
  const cfg = window.OASIS_ATTRIBUTION_CONFIG || {};
  const ENDPOINT = typeof cfg.endpoint === "string" ? cfg.endpoint.replace(/\/+$/, "") : "";
  const ENTRY_LIFF_ID = typeof cfg.entryLiffId === "string" ? cfg.entryLiffId : "";
  const LINE_URL = "https://line.me/R/ti/p/%40nlx8658m";
  // 画面に出している説明文の版。文を変えたら日付を変える（どの説明に同意したかを残すため）。
  const CONSENT_VERSION = "2026-10-21";
  const BIND_TIMEOUT_MS = 4000;
  const AD_REF_RE = /^[A-Za-z0-9_-]{22}$/;

  const $ = (id) => document.getElementById(id);
  let leaving = false;

  function goLine() {
    if (leaving) return;
    leaving = true;
    window.location.assign(LINE_URL);
  }

  function showFallback(message) {
    const status = $("entryStatus");
    if (status) status.textContent = message || "下のボタンからLINEへお進みください。";
    const consent = $("entryConsent");
    if (consent) consent.hidden = true;
    const link = $("entryFallback");
    if (link) link.hidden = false;
  }

  function adRefFromUrl() {
    try {
      const value = new URLSearchParams(window.location.search).get("ad_ref") || "";
      return AD_REF_RE.test(value) ? value : null;
    } catch (_) {
      return null;
    }
  }

  function bind(adRef) {
    let token = null;
    try {
      token = window.liff.getIDToken();
    } catch (_) {
      token = null;
    }
    if (!token) return Promise.resolve();
    const request = window
      .fetch(ENDPOINT + "/v1/bind", {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ ad_ref: adRef, id_token: token, consent: { ad_data: "granted", version: CONSENT_VERSION } }),
        keepalive: true,
        credentials: "omit",
        mode: "cors",
      })
      .catch(() => {});
    const timeout = new Promise((resolve) => setTimeout(resolve, BIND_TIMEOUT_MS));
    return Promise.race([request, timeout]);
  }

  function showConsent(adRef) {
    const status = $("entryStatus");
    if (status) status.hidden = true;
    const consent = $("entryConsent");
    if (consent) consent.hidden = false;
    // 「同意せずに進む」と同じなので、選択肢が3つに見えないよう隠す。
    const link = $("entryFallback");
    if (link) link.hidden = true;
    const agree = $("entryAgree");
    const decline = $("entryDecline");
    agree?.addEventListener("click", () => {
      if (agree) agree.disabled = true;
      if (decline) decline.disabled = true;
      bind(adRef).then(goLine, goLine);
    });
    decline?.addEventListener("click", goLine);
  }

  function start() {
    const configured = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(ENDPOINT) && /^\d{10}-[A-Za-z0-9]{8}$/.test(ENTRY_LIFF_ID);
    if (!configured || !window.liff || typeof window.fetch !== "function") {
      showFallback();
      return;
    }
    window.liff
      .init({ liffId: ENTRY_LIFF_ID })
      .then(() => {
        const adRef = adRefFromUrl();
        if (!adRef) {
          showFallback();
          return;
        }
        if (!window.liff.isLoggedIn()) {
          // LINE アプリの外（パソコンのブラウザなど）。ログインのあと、このページに戻ってくる。
          window.liff.login({ redirectUri: window.location.href });
          return;
        }
        showConsent(adRef);
      })
      .catch(() => showFallback());
  }

  window.OasisEntry = Object.freeze({ start });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
