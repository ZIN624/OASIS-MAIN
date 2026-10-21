(function () {
  if (!window.liff) return;

  // 広告帰属（attribution.js）が初期化の完了を待てるように、同じ Promise を置いておく。動作は変えない。
  window.OasisLiffReady = liff
    .init({
      liffId: "2006621786-8K7V4W3M",
    })
    .then(() => {
      console.log("LIFF initialized");
    })
    .catch((error) => {
      console.error("LIFF init error:", error);
      alert("LIFFの初期化に失敗しました。通信環境やLINEアプリ内表示をご確認ください。");
    });
})();

