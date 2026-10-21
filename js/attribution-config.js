// 広告帰属の設定（OASIS本店）。
// endpoint と entryLiffId が空のあいだは、予約フォームも入口ページも何もしない（いまの動作のまま）。
// 値を入れるのはオーナーの承認後（Worker のデプロイと LIFF の追加が済んでから）。
window.OASIS_ATTRIBUTION_CONFIG = Object.freeze({
  // 例: "https://oasis-honten-attribution.<account>.workers.dev"（末尾の / なし）
  endpoint: "",
  // 入口ページ（entry.html）用の LIFF ID。予約フォームと同じ LINE ログインチャネルに追加する。
  entryLiffId: "",
});
