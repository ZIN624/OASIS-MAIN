# OASIS本店 LINE予約希望の広告帰属（Cloudflare Worker + D1）

広告から来たお客様の「LINE予約希望」を数えるための、本店専用の小さな受付サーバです。
SalonOS とは別の Worker・別の D1 です。**予約の受付（LINE への送信）はこの Worker を通りません。**
ここが止まっても、予約は今までどおり届きます。

> 🚨 まだどこにもデプロイしていません。Google 広告にも何も送っていません。
> 動かす手順（下の「導入の順番」）は、すべてオーナーの承認後に行います。

## 流れ

```
Google 広告 → Wix 本店ページ（gclid 付き）
  │ wix/honten-ad-entry.html: gclid があるときだけ POST /v1/ad-click → 乱数の ad_ref を受け取る
  │ 本店の LINE ボタンの行き先を liff.line.me/<入口LIFF>?ad_ref=… に変える（gclid は URL に載せない）
  ▼
入口ページ entry.html（LIFF）
  │ LINE ログイン → 説明を読んで「同意してLINEへ進む」→ POST /v1/bind（IDトークン + ad_ref）
  │ 失敗しても・同意しなくても、いつもの友だち追加リンクへ進む
  ▼
LINE トーク → リッチメニュー → 予約フォーム index.html（その場ですぐ／数日後）
  │ 開いたとき: POST /v1/session（IDトークンを検証し、12時間の印を返す）
  │ liff.sendMessages 成功 → booking_inquiry（変更なし）→ POST /v1/inquiry（keepalive・待たない）
  ▼
Worker: 同じ LINE 利用者の、問い合わせより前の最も新しいクリック（90日以内）を探して区分を決める
  │ none / ad_same_day（24時間以内）/ ad_delayed（〜90日）/ expired
  ▼
conversion_uploads（送信待ち）
  │ 毎時5分の定期実行（クリックの6時間後から）。1リクエスト1件で Data Manager API へ
  ▼
Google 広告「OASIS本店｜LINE予約希望（オフライン）」（副次）
```

> 🚧 送信のコードはありますが、**止めた状態**です。`UPLOAD_ENABLED=false`、送信先（`DM_*`）は空、鍵（`GOOGLE_SA_KEY_JSON`）なし、
> さらに `DM_VALIDATE_ONLY=true`（Google に確かめさせるだけで取り込ませない）が既定です。

## API

| パス | 呼ぶ場所 | 認証・確認 |
|---|---|---|
| `POST /v1/ad-click` | Wix 本店ページ | Origin（Wix）・本店のページだけ・クリック識別子の形・IPごとの回数制限 |
| `POST /v1/bind` | 入口ページ | Origin（GitHub Pages）・LINE IDトークンをサーバで検証（iss・aud・exp・sub）・明示の同意・1つの ad_ref に1人だけ・クリックから24時間以内 |
| `POST /v1/session` | 予約フォーム | Origin・LINE IDトークンをサーバで検証 |
| `POST /v1/inquiry` | 予約フォーム | Origin・セッションの署名（HMAC）と期限・UUID v4・送信時刻の範囲・利用者ごとの回数制限 |
| `GET /v1/admin/diagnostics` | 運営 | `Authorization: Bearer <ADMIN_TOKEN>`。件数だけを返す |

設計書にあった `/v1/export` は、Google Ads API 方式に変えたため作っていません（存在しないパスは 404）。

**CORS は認証ではありません。** Origin は偽装できるので、守りは IDトークンの検証・セッションの署名・回数制限・
「同じ広告クリックから送るのは1件だけ」・ad_ref の使い回し禁止で行っています。

## 保存するもの・しないもの

| 表 | 中身 | 消す時期 |
|---|---|---|
| `ad_clicks` | ad_ref・gclid/gbraid/wbraid・着地ページ・UTM・受付時刻 | 90日。結ばれないまま24時間たったものはその時点で |
| `line_bindings` | ad_ref・LINE 利用者の HMAC・同意した説明文の版 | 90日 |
| `inquiries` | inquiry_id・区分・クリックからの時間・送信時刻。広告経由のときだけ HMAC と ad_ref | HMAC と ad_ref は90日で消す。行は13か月で消す |
| `conversion_uploads` | 送信の状態・回数・エラーの種類・Data Manager の requestId | 13か月 |
| `rate_limits` / `diag_counters` / `retention_runs` | HMAC(IP)・件数・削除の記録 | 2日 / 400日 / 残す |

**保存しないもの**: 氏名・フリガナ・電話番号・メールアドレス・LINE の生のユーザーID・IDトークン・生のIP・
Google が返した文。HMAC の鍵は `ATTR_ROOT_KEY` から HKDF で用途ごとに作ります。
**HMAC 化した値やクリック識別子も個人に関する情報として扱います**（だから90日で消します）。

## Google 広告への送信（Data Manager API）

決定④は 2026-10-21 に「Google Ads API」から「Data Manager API」に変わりました（オーナー承認）。
Google Ads API の `UploadClickConversions` は、2026-06-15 以降、過去に送った実績のないプロジェクトからは失敗するためです
（[公式](https://developers.google.com/google-ads/api/docs/conversions/upload-offline)）。

### 公式仕様で確かめたこと（2026-10-21）

| 項目 | 内容 | 出典 |
|---|---|---|
| 送り先 | `POST https://datamanager.googleapis.com/v1/events:ingest` | [リファレンス](https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest)・discovery 文書 revision 20261016 |
| 結果の確認 | `GET https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=…` | [リファレンス](https://developers.google.com/data-manager/api/reference/rest/v1/requestStatus/retrieve) |
| スコープ | `https://www.googleapis.com/auth/datamanager` | 同上 |
| 認証 | Cloud プロジェクトで API を有効化。ユーザーかサービスアカウントを Google 広告アカウントに追加 | [Set up API access](https://developers.google.com/data-manager/api/get-started/set-up-access) |
| 識別子 | `adIdentifiers.gclid` / `gbraid` / `wbraid`。`eventTimestamp`・`eventSource` は必須、`transactionId` は重複防止 | [Send events](https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/send-events) |
| 送信先 | `operatingAccount`（GOOGLE_ADS・ID）＋ `productDestinationId`（種類 UPLOAD_CLICKS のコンバージョンアクション） | 同上 |
| 失敗の型 | 1件でも不正ならリクエスト全体が失敗（fast-fail）。成功時は `requestId` だけが返る | 同上 |
| 取り込みの結果 | 30分待ってから確認。最大24時間。結果は「理由ごとの件数」で、どの行かは返らない | [Diagnostics](https://developers.google.com/data-manager/api/devguides/diagnostics) |
| 再試行 | 一時的な障害（5xx・分単位の 429）だけ間隔をあけて送り直す。400 などは直すまで送らない | [Understand API errors](https://developers.google.com/data-manager/api/devguides/concepts/understand-errors) |
| 上限 | 1リクエスト2,000件・10送信先、1日100,000リクエスト・毎分300 | [Limits](https://developers.google.com/data-manager/api/devguides/limits) |
| 期限 | gclid は90日しか保持されない（それより古いクリックは取り込めない） | [Google 広告ヘルプ](https://support.google.com/google-ads/answer/10029210) |
| クリック直後 | 「まだ処理中なので12時間後に」と返ることがある | 同上 |
| 規約 | Google APIs 利用規約と、広告のポリシー（Customer Match・顧客データのポリシー等） | [Terms](https://developers.google.com/data-manager/api/devguides/terms) |

### このコードの決めごと

- **1リクエスト1件で送る**。結果が理由ごとの件数でしか返らないため、行ごとの成否を確実に知るには1件ずつが確実です。
  本店の件数（1日数件）なら上限に遠く届きません
- 送る中身は `gclid`（無ければ `gbraid`、それも無ければ `wbraid`）・`eventTimestamp`（日本時間の RFC 3339）・
  `transactionId`（= inquiry_id）・`eventSource: WEB`・`consent.adUserData: CONSENT_GRANTED` だけ。
  **氏名・電話番号・メール（`userData`）は送りません**。金額（`conversionValue`）も送りません（アクションの既定値が使われる）
- 状態: `pending` → 送る → `submitted`（requestId を保存）→ 30分後から確認 → `uploaded` / `duplicate` / `failed`
  - 処理中なら確認の間隔を 1→2→4→8 時間と広げ、26時間たっても終わらなければ同じ transactionId で送り直す
  - 重複（`DUPLICATE_TRANSACTION_ID` / `DUPLICATE_GCLID`）は「Google がもう数えている」として `duplicate`
  - あとで送り直す理由（`TOO_RECENT_CLICK` 12時間・`DESTINATION_TOO_RECENTLY_CREATED` 24時間・`INTERNAL_ERROR` 6時間）は `retry`
  - それ以外（クリックが見つからない・期限切れ・同意なし など）は `failed`
- 送った回数は最大6回。届いたか分からないときは同じ transactionId で送り直す（Google 側で重複として弾かれる）
- **認証の失敗（401・403・鍵の失効）と送信先の設定の誤り（`destinations` の 400・404）は、行のせいではないので回数を数えずに全体を止めます**
- 1回の実行で送るのは10件・確認は20件まで（外への通信の数を決めておく）
- クリックから6時間たつまでは送りません（直後は Google がまだクリックを処理していないため）
- 認証はサービスアカウントの鍵（`GOOGLE_SA_KEY_JSON`）で JWT を署名してトークンを取ります。
  鍵・JWT・トークンはログ・DB・エラー文に出しません。鍵に別のトークン発行先が書かれていたら使いません
- `DM_VALIDATE_ONLY=true`（既定）のあいだは `validateOnly` で送り、取り込ませません

### 同じ広告クリックにつき1件（もとは「同じ人は24時間に1件」）

| | inquiry_id（取引ID）の一意 | 同じ広告クリックにつき1件 |
|---|---|---|
| 防ぐもの | **同じ1件**が二重に記録・送信されること（二重タップ・再送・送り直し） | **別々の予約希望**が、同じ1回の広告クリックの成果として何件も送られること |
| 例 | 送信ボタンを2回押した／閉じて次に開いたときの再送 | 同じ日に自分の分と家族の分を送った／数日後にまた送った |
| 記録 | 1件だけ | すべて記録する（`suppressed_duplicate`）。送らないだけ |

「同じ人は24時間に1件」だと、**別の日に別の広告から来た人の予約希望は送れる**一方で、
**同じ日に別の広告クリックから2回来た人の2件目**を落としていました（少なく数える）。
逆に、**1回のクリックのあと数日おきに何度も送る**と、日ごとに送ってしまっていました（多く数える）。

いまは「同じ広告クリック（同じ ad_ref、または同じ gclid / gbraid / wbraid）から送るのは1件」です。
これは Google 広告の「カウント: 1回」と同じ考え方です。

- ⚠️ `gbraid` / `wbraid` は「1回」のコンバージョンアクションでは受け付けられない可能性があります
  （エラー理由に `ONE_PER_CLICK_CONVERSION_ACTION_NOT_PERMITTED_WITH_BRAID` がある。**名前からの推定で未確認**）。
  その場合はアクションを「すべて」にし、1クリック1件はこのコードで守ります
- 別の広告クリックから来た2件目は送ります。同じ人でも、新しく広告をクリックしたのは事実だからです

### LINE への到達の確かめ方（いまの方式と、将来の Webhook 方式）

| | いま（フォームが報告） | 将来の案（Webhook で照合） |
|---|---|---|
| 仕組み | `liff.sendMessages` が成功したあと、フォームが `/v1/inquiry` を呼ぶ | LINE 公式アカウントに届いたメッセージを、Messaging API の Webhook で Worker が受け取り、照合する |
| 分かること | 本人（IDトークンで確認）のフォームが「送れた」と報告したこと | **公式アカウントに実際に届いたこと** |
| 弱点 | 悪意のある人が送らずに `/v1/inquiry` だけ呼べる（同じクリックにつき1件なので、水増しは広告クリック1回につき1件まで） | 公式アカウントの Webhook 設定を変える必要がある。チャットの運用（応答モード）に影響しないか確認が要る。Messaging API のチャネルが同じプロバイダーでないと ID が一致しない |
| 予約への影響 | なし | なし（受け取るだけ） |
| 必要な作業 | なし | Webhook URL の登録・署名の検証・照合のコード・メッセージ本文を保存しない設計 |

今回は Webhook を使いません。主要コンバージョン（入札に使う）に上げる前に検討する拡張として残します。
照合に使う場合も、**本文（氏名・電話番号が入っている）は保存せず、「予約希望メッセージ」の形をしているか・受信時刻だけを見る**設計にします。

### 同意・規約・保存期間の再点検（2026-10-21）

- 同意: 入口ページで「同意してLINEへ進む」を押した人の結びつけだけが `pending` になり、`adUserData: CONSENT_GRANTED` を付けて送ります。
  同意していない・Wix の初期値（すべて許可）だけの人は送りません。`adPersonalization` は聞いていないので送りません
- 規約: Data Manager API は Google APIs 利用規約と広告のポリシーに従う必要があります。
  **クリック識別子だけの送信が「顧客データ」に当たるか、顧客データのポリシーへの同意が要るかは未確認**（弁護士確認の項目に追加）
- 保存: Data Manager の requestId は個人の情報ではないので13か月残します。送信中（`submitted`）の行はクリックが90日で消えても結果を確かめられます
- プライバシーポリシーの文案は「Data Manager API」を前提に更新済み（別のドキュメント）

## 導入の順番（すべて承認後）

1. **LINE Developers（オーナー）**: 予約フォームの LIFF（`2006621786-8K7V4W3M`）と**同じ LINE ログインチャネル**に、
   入口ページ用の LIFF を追加する（エンドポイント `https://zin624.github.io/OASIS-MAIN/entry.html`、scope は `openid`、
   友だち追加オプション ON）。予約フォームの LIFF に `openid` が入っているか確認する（入っていなければ、足すと
   **全員に同意画面が出る**ので、足さずに相談）。チャネルの「リンクされたLINE公式アカウント」が @nlx8658m か確認する
2. **Cloudflare（承認後に実施）**: `npx wrangler d1 create oasis-honten-attribution-staging` → `wrangler.jsonc` の
   `database_id` を書き換え → `npx wrangler d1 migrations apply ATTR_DB --remote --env staging`
3. 秘密の値: `openssl rand -base64 48 | npx wrangler secret put ATTR_ROOT_KEY --env staging`、
   同じく `ADMIN_TOKEN`。**リポジトリ・PR・チャットに書かない**
3b. **Google（オーナー・承認後）**: 本店用の Google Cloud プロジェクトで Data Manager API を有効化 →
   サービスアカウントを作って鍵（JSON）を発行 → Google 広告 265-068-2623 の「管理 → アクセスとセキュリティ」に
   そのサービスアカウントのメールを追加 → 新しいコンバージョンアクション「OASIS本店｜LINE予約希望（オフライン）」を
   **種類: クリックからのインポート・副次**で作る（カウントは上の「同じ広告クリックにつき1件」を参照）。
   鍵は `npx wrangler secret put GOOGLE_SA_KEY_JSON --env staging` で入れ、手元から消す
4. `wrangler.jsonc` の `LINE_CHANNEL_IDS` にチャネルID（10桁）を入れる
5. `npx wrangler deploy --env staging`（`AD_ATTR_ENABLED` は `false` のまま）→ 診断APIで動作確認
6. テスト用の LIFF・テスト用の LINE アカウントで、ステージングを通しで確認（下の「確認」）
7. 本番も同じ手順。`AD_ATTR_ENABLED=true` にするのは最後
8. `js/attribution-config.js` に `endpoint` と `entryLiffId` を入れて GitHub Pages に出す
9. Wix のカスタムコード（`wix/honten-ad-entry.html`）を本店の3ページに貼る（**Wix の下書きの別作業が終わってから**）
10. Google 広告への送信: `DM_OPERATING_ACCOUNT_ID`（ハイフンなし）・`DM_CONVERSION_ACTION_ID` を入れ、
    `DM_VALIDATE_ONLY=true` のまま `UPLOAD_ENABLED=true` → 診断APIで `validated_only` を確認 →
    承認を得てから `DM_VALIDATE_ONLY=false`（**ここで初めて実データが取り込まれる**）

## 確認（本番の前に）

- 広告のURL（`?gclid=テスト値`）で本店ページを開く → LINE ボタンが `liff.line.me/…?ad_ref=…` になる
- 入口ページ → 同意 → 友だち追加 → トークのメニューから予約希望を送る → 診断APIで `ad_same_day` が1件
- 広告を通らずにリッチメニューから送る → `none` が1件、送信待ちは増えない
- 停止スイッチ（`AD_ATTR_ENABLED=false`）で、Wix のボタンがいつもの LINE リンクのままになる
- 数日後に送った予約希望が `ad_delayed` になる（**LINE の実機でしか確かめられない**: 同じチャネルでIDが一致すること）
- validateOnly で送信先の設定が正しいこと（`upload_config_error` が出ない）。実データの取り込みは承認後

## 止め方・戻し方

| 段階 | やること | 結果 |
|---|---|---|
| 1 | `AD_ATTR_ENABLED` を `false` にしてデプロイ | すべての受付が 503。Wix はいつもの LINE リンクのまま。予約フォームは記録を送らない（届かない分は端末に控えが残り7日で消える） |
| 2 | Wix のカスタムコードを OFF | 導線が完全に元に戻る |
| 3 | `js/attribution-config.js` の `endpoint` を空に戻す | 予約フォーム・入口ページが何もしなくなる |
| 4 | OASIS-MAIN の PR を revert | `booking_inquiry` と `liff.sendMessages` は最初から変えていない |
| 5 | `UPLOAD_ENABLED=false` | Google 広告への送信だけ止まる |
| 6 | `npx wrangler d1 execute ATTR_DB --remote --env production --command "DELETE FROM ad_clicks; DELETE FROM line_bindings; …"` または D1 ごと削除 | データが消える（氏名・電話番号は最初から無い） |

## 費用の目安

- 同じ Cloudflare アカウント（Workers 有料プラン・月5ドル）の込みの範囲に収まる見込み（予約フォームを開くたびに1〜2回・
  広告クリックごとに1〜2回の呼び出し。D1 は数MB）。**追加はほぼ0円**
- 定期実行は1本（毎時5分）。Cron の本数の上限がアカウント単位か Worker 単位かは**未確認**
  （この作業環境から Cloudflare の公式ページを開けなかった）。デプロイの前に
  developers.cloudflare.com/workers/platform/limits/ で確かめ、SalonOS の3本と合わせて上限を超えないことを見ること

## 開発

```bash
npm ci
npm run typecheck
npm test        # Workers 実行環境（miniflare）＋ D1 で 78 件
npm run build   # wrangler deploy --dry-run（どこにも送らない）
```
