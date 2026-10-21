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
conversion_uploads（送信待ち）→ 🚧 送信方式が決まるまで送らない（下の「未実装」）
```

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
「同じ人の広告経由は24時間に1件」・ad_ref の使い回し禁止で行っています。

## 保存するもの・しないもの

| 表 | 中身 | 消す時期 |
|---|---|---|
| `ad_clicks` | ad_ref・gclid/gbraid/wbraid・着地ページ・UTM・受付時刻 | 90日。結ばれないまま24時間たったものはその時点で |
| `line_bindings` | ad_ref・LINE 利用者の HMAC・同意した説明文の版 | 90日 |
| `inquiries` | inquiry_id・区分・クリックからの時間・送信時刻。広告経由のときだけ HMAC と ad_ref | HMAC と ad_ref は90日で消す。行は13か月で消す |
| `conversion_uploads` | 送信の状態・回数・エラーの種類 | 13か月 |
| `rate_limits` / `diag_counters` / `retention_runs` | HMAC(IP)・件数・削除の記録 | 2日 / 400日 / 残す |

**保存しないもの**: 氏名・フリガナ・電話番号・メールアドレス・LINE の生のユーザーID・IDトークン・生のIP・
Google が返した文。HMAC の鍵は `ATTR_ROOT_KEY` から HKDF で用途ごとに作ります。
**HMAC 化した値やクリック識別子も個人に関する情報として扱います**（だから90日で消します）。

## 未実装（判断待ち）

### Google 広告への送信（`src/uploads.ts` の `ConversionSender`）

- 決定④は「Google Ads API」でしたが、公式ページに
  「2026年6月15日以降、過去にオフラインコンバージョンを送ったことのない開発者トークン（現在は Cloud プロジェクト）からの
  `UploadClickConversions` は失敗する。Data Manager API を使うこと」とあります
  （<https://developers.google.com/google-ads/api/docs/conversions/upload-offline>）。
  SalonOS の Cloud プロジェクトも、本店用の新しいプロジェクトも、送ったことがありません。
- 代わりの Data Manager API（`events:ingest`）は別の API で、利用規約も別です。決め直してもらうまで作りません。
- いま実装済みなのは、送信先に依存しない部分だけです:
  どれを送るか・締め切り（クリックから90日、12時間の余裕）・行ごとの結果（部分的な失敗）・
  一時的な障害の再試行（1・3・6・12・24時間、6回で打ち切り）・認証切れで全体を止める・
  返ってこなかった行は order_id（= inquiry_id）で重複を防ぎつつ送り直す。
- 送信方式が決まったら、`ConversionSender` を1つ実装して `src/index.ts` の `SENDER` に入れます。

### 同意の取り方

- Wix の同意設定は初期値が「すべて許可」で、バナーもありません。**これを同意の証拠として扱いません。**
- 入口ページで説明を出し、「同意してLINEへ進む」を押した人だけを結びつけます（`consent_version` を残す）。
- 説明文（`entry.html`）は**弁護士確認が必要**です。

## 導入の順番（すべて承認後）

1. **LINE Developers（オーナー）**: 予約フォームの LIFF（`2006621786-8K7V4W3M`）と**同じ LINE ログインチャネル**に、
   入口ページ用の LIFF を追加する（エンドポイント `https://zin624.github.io/OASIS-MAIN/entry.html`、scope は `openid`、
   友だち追加オプション ON）。予約フォームの LIFF に `openid` が入っているか確認する（入っていなければ、足すと
   **全員に同意画面が出る**ので、足さずに相談）。チャネルの「リンクされたLINE公式アカウント」が @nlx8658m か確認する
2. **Cloudflare（承認後に実施）**: `npx wrangler d1 create oasis-honten-attribution-staging` → `wrangler.jsonc` の
   `database_id` を書き換え → `npx wrangler d1 migrations apply ATTR_DB --remote --env staging`
3. 秘密の値: `openssl rand -base64 48 | npx wrangler secret put ATTR_ROOT_KEY --env staging`、
   同じく `ADMIN_TOKEN`。**リポジトリ・PR・チャットに書かない**
4. `wrangler.jsonc` の `LINE_CHANNEL_IDS` にチャネルID（10桁）を入れる
5. `npx wrangler deploy --env staging`（`AD_ATTR_ENABLED` は `false` のまま）→ 診断APIで動作確認
6. テスト用の LIFF・テスト用の LINE アカウントで、ステージングを通しで確認（下の「確認」）
7. 本番も同じ手順。`AD_ATTR_ENABLED=true` にするのは最後
8. `js/attribution-config.js` に `endpoint` と `entryLiffId` を入れて GitHub Pages に出す
9. Wix のカスタムコード（`wix/honten-ad-entry.html`）を本店の3ページに貼る（**Wix の下書きの別作業が終わってから**）
10. Google 広告の送信は、送信方式を決め直してから別の PR で

## 確認（本番の前に）

- 広告のURL（`?gclid=テスト値`）で本店ページを開く → LINE ボタンが `liff.line.me/…?ad_ref=…` になる
- 入口ページ → 同意 → 友だち追加 → トークのメニューから予約希望を送る → 診断APIで `ad_same_day` が1件
- 広告を通らずにリッチメニューから送る → `none` が1件、送信待ちは増えない
- 停止スイッチ（`AD_ATTR_ENABLED=false`）で、Wix のボタンがいつもの LINE リンクのままになる
- 数日後に送った予約希望が `ad_delayed` になる（**LINE の実機でしか確かめられない**: 同じチャネルでIDが一致すること）

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
npm test        # Workers 実行環境（miniflare）＋ D1 で 55 件
npm run build   # wrangler deploy --dry-run（どこにも送らない）
```
