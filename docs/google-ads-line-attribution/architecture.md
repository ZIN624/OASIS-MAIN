# OASIS本店｜Google広告 → LINE予約希望 CV 連携設計（2026-10-18）

## 現状調査の結論
- 公開フォーム：`https://zin624.github.io/OASIS-MAIN/`。GitHub Pagesに配信される静的HTML/JSで、サーバー・DB・テスト基盤はこのリポジトリに存在しない。
- LINEログインチャネル：`2006621786`、LIFF：`2006621786-8K7V4W3M`。本店の公式アカウントとのリンクおよび既存予約・チャット動作は利用者確認済み。
- `js/liff-init.js`：`liff.init()` のみ。識別トークンをサーバーに送らない。
- `js/reservation.js`：`liff.sendMessages()` の成功後、GA4 `booking_inquiry` を記録し、最大800msで画面を閉じる。失敗時は予約をCVにしない。
- `js/ui-init.js`：予約入力画面へ進んだ時にGA4 `booking_form_open`。
- `js/analytics.js`：GA4 ID `G-D9P3LB3Q1C`、既存イベントのみ。広告クリック識別子を収集・保存しない。
- `js/storage.js`：顧客氏名・電話番号などをブラウザのlocalStorageに保存している。広告計測にこの顧客データを転用しない。
- Google広告 265-068-2623 へのGA4リンクは「送信済み・承認待ち」。Ads設定・キャンペーンは兄が管理。Wix本店LPの編集権限も未取得。

## 重要な区別
- `booking_inquiry` は「予約希望メッセージのLINE送信成功」であり、スタッフによる「予約確定」ではない。
- GA4イベントが届いている事実と、そのイベントがGoogle広告クリックにアトリビューションできることは別。
- LINEの友だち追加だけでは匿名の広告クリックと後日のLIFF利用者を自動で結び付けられない。
- 完全照合を保証しない。拒否・未ログイン・ブラウザ差異等では広告CVにならないことがある。

## 推奨実装方式（本番導線の変更は別PR）

### 1. LP / LINEログイン（新規機能）
1. Google広告 → 本店のWix LP。許可・同意条件を満たしたとき `gclid`, `gbraid`, `wbraid`, `utm_*` を取得。値はタグ付きの広告クリック識別情報として扱う。
2. お客様が「LINEで予約」を押す時、バックエンドで短期有効・一回限りの `state` と必要な認証情報を生成し、クリックデータを期限付きで安全に保持。
3. 既存LINEログインチャネルを使用し、Authorization Code FlowでLINEログイン。登録済みリダイレクトURI、state/nonce検証等を適用。友だち追加を案内する場合は `bot_prompt=normal` を検討し、同意を強制しない。
4. LINE側から戻った後、**バックエンド**で認可コードを交換しIDトークン等を検証。確認した `sub`（LINEの利用者識別子）と広告クリック識別情報を限定目的・限定期間で照合可能にする。サーバーログやGA4にLINE ID・トークン・電話番号を出さない。
5. LP → LINE公式アカウント/LIFFへ案内する。既存友だち・ログインしない利用者は従来の予約動線を維持し、広告照合を無理に強制しない。

### 2. LIFF送信成功時（既存コードへの最小追加）
1. `liff.init()` 成功後の認証状態を確認し、必要な場合に限り `liff.getIDToken()` で生のIDトークンを取得。デコードしたユーザーIDや `getProfile()` の値を認証根拠としてサーバーへ送ってはいけない。
2. `liff.sendMessages()` の**成功後だけ**バックエンドへ送信完了イベントを通知。API側でLINEの `POST /oauth2/v2.1/verify` を使い、期待するチャネルID `2006621786` と署名/有効期限を検証する。
3. 照合成功なら重複排除可能な `inquiry_id` を生成し、広告クリック識別子・送信時刻・処理状態を保存する。リクエスト重複によるCV二重計上を防ぐ。
4. API障害時も予約・LINEチャットを止めない。追跡エラーと予約エラーを混同しない。既存GA4 `booking_inquiry`、LIFF画面動作、表示、LINE本文は維持する。
5. GA4・Clarity・ブラウザログ・LINEメッセージ本文にはGCLIDとLINEの認証トークンを載せない。

### 3. Google広告への取り込み（お兄さん承認後）
- 「予約希望送信」に専用のGoogle広告コンバージョンアクションを作る。Google Ads APIによるオフラインクリックCVアップロード（`UPLOAD_CLICKS`）は一候補。利用権限・認証・同意および可用性を検証して採用する。
- 送信するのは検証済み照合に必要な最小情報（クリックID、イベント時刻・タイムゾーン、重複排除ID等）。`order_id` で重複を抑制。
- 最初は**副次的**としてテストし、既存のグループ広告に新しい主要目標を自動適用しない。
- GA4キーイベントをインポートする場合、同じ予約を別のCVアクションから二重に主要計上しないよう、レポート/入札目標を明確に分ける。
- 予約確定のCVは別イベント。今のフォームからは判別できない。

## API/ストレージの暫定責務（バックエンド未確定）
- `/attribution/start`：LPからの開始・state発行。
- `/auth/line/callback`：OAuthの認可コード処理・LINEユーザーとの紐づけ。
- `/attribution/inquiry`：LIFF生トークン検証後に予約希望送信イベントを保存。
- `/jobs/google-ads-upload`：管理認可後、冪等にバッチアップロード。
- DBの候補：`click_sessions`、`line_attributions`、`inquiry_events`、`conversion_exports`。LINE IDは秘密鍵付きHMACなどの仮名化も検討する。秘密情報はSecret管理。
- **Wix Veloバックエンド**か**独立Cloudflare Worker+DB**かは、Wix権限取得後に実運用制約・ドメイン・CORS・OAuthコールバック・料金を検証して最小構成を決定。現時点でサーバー実装済みとは扱わない。
- 保存期間、同意文言、法的適合、ブラウザ識別・クロスドメイン制約は本番公開前のゲート項目。

## 破壊的変更を避ける境界
- `main` と公開フォームは一切変更しない。設計確定→実装PR→テスト→承認→手動公開。
- フォームのHTML/スタイル・顧客入力・LINE送信本文・既存GA4イベント名は原則不変。
- API未設定・LINEログイン拒否・非広告流入の場合、以前と同じ予約導線を維持。
- SalonOSの予約・DB・アカウントとは分離。

## 参照した公式仕様
- LINE Login 友だち追加オプション: https://developers.line.biz/ja/docs/line-login/link-a-bot/
- LIFF IDトークンとサーバー検証: https://developers.line.biz/ja/docs/liff/using-user-profile/
- ID token verify: https://developers.line.biz/en/docs/line-login/verify-id-token/
- Google Ads オフラインCV: https://developers.google.com/google-ads/api/docs/conversions/upload-offline
- Wix URL query: https://dev.wix.com/docs/velo/apis/wix-location-frontend/query
- Wix HTTP CORS: https://dev.wix.com/docs/velo/velo-only-apis/wix-http-functions/options

## 未着手
- LP/Wix側の開発権限確認と導線選択
- Backend/DBデプロイ、OAuth callback登録・実装
- `OASIS-MAIN`側の変更と端末/回帰テスト
- Google広告CV権限・アップロードの有効化と実測
