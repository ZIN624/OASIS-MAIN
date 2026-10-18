(function () {
  "use strict";

  // 本店のGA4専用。LINE予約希望は booking_inquiry、予約確定は booking_complete。
  const GA4_ID = "G-D9P3LB3Q1C";
  const EVENTS = Object.freeze({ formOpen: "booking_form_open", inquiry: "booking_inquiry" });
  const WAIT_MS = 800;
  let openTracked = false;
  let inquiryTracked = false;

  function enabled() {
    const loc = window.location;
    if (loc.hostname !== "zin624.github.io") return false;
    if (loc.pathname !== "/OASIS-MAIN/" && loc.pathname !== "/OASIS-MAIN/index.html") return false;
    const query = new URLSearchParams(loc.search);
    if (query.has("preview") || query.has("noc")) return false;
    return typeof window.gtag === "function";
  }

  function trackFormOpen() {
    if (openTracked || !enabled()) return;
    try {
      window.gtag("event", EVENTS.formOpen, { send_to: GA4_ID, mode: "liff" });
      openTracked = true;
    } catch (_) {
      // 計測に失敗しても予約は止めない。
    }
  }

  function trackInquiry(afterTracking) {
    const done = typeof afterTracking === "function" ? afterTracking : function () {};
    if (inquiryTracked || !enabled()) {
      done();
      return;
    }
    let finished = false;
    let timeout = null;
    const finish = function () {
      if (finished) return;
      finished = true;
      if (timeout !== null) clearTimeout(timeout);
      done();
    };
    try {
      // LINE送信成功時にだけ呼ぶ。計測できなくても800ms以内に従来の画面終了へ進む。
      timeout = setTimeout(finish, WAIT_MS);
      window.gtag("event", EVENTS.inquiry, {
        send_to: GA4_ID,
        mode: "liff",
        event_callback: finish,
        event_timeout: WAIT_MS,
      });
      inquiryTracked = true;
    } catch (_) {
      finish();
    }
  }

  window.OasisAnalytics = Object.freeze({ trackFormOpen, trackInquiry });
})();
