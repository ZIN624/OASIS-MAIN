(function () {
  "use strict";

  // SalonOS へ「この方が予約の希望を送った」とだけ知らせる。
  // ・送るのは LINE の本人確認の印（ID トークン）と店舗の記号だけ。予約の中身（日時・メニュー・お名前・電話）は送らない
  // ・SalonOS は、広告から SalonOS の LINE 入口を通った方のときだけ記録する（それ以外の方は何も残らない）
  // ・返事は読まない（別のドメインへ no-cors で送る）。失敗しても予約の送信と画面の終了は止めない
  // ・keepalive で送るので、すぐ画面を閉じても届く
  const ENDPOINT = "https://app.salon-os.jp/api/public/line-booking-request";
  const SALON = "oasis-honten";
  let sent = false;

  function enabled() {
    const loc = window.location;
    if (loc.hostname !== "zin624.github.io") return false;
    if (loc.pathname !== "/OASIS-MAIN/" && loc.pathname !== "/OASIS-MAIN/index.html") return false;
    const query = new URLSearchParams(loc.search);
    if (query.has("preview") || query.has("noc")) return false;
    return typeof window.fetch === "function";
  }

  function notifyBookingRequest() {
    if (sent || !enabled()) return;
    try {
      if (!window.liff || typeof liff.getIDToken !== "function") return;
      const idToken = liff.getIDToken();
      if (!idToken) return;
      sent = true;
      window
        .fetch(ENDPOINT, {
          method: "POST",
          mode: "no-cors",
          keepalive: true,
          credentials: "omit",
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: JSON.stringify({ id_token: idToken, salon: SALON }),
        })
        .catch(function () {
          // 届かなくても予約は止めない
        });
    } catch (_) {
      // 届かなくても予約は止めない
    }
  }

  window.OasisSalonOs = Object.freeze({ notifyBookingRequest });
})();
