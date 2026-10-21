-- OASIS本店 LINE予約希望の広告帰属（D1）
--
-- 保存しないもの: 氏名・フリガナ・電話番号・メールアドレス・LINEの生のユーザーID・IDトークン。
-- クリック識別子（gclid / gbraid / wbraid）と LINE利用者のHMACも個人に関する情報として扱い、
-- 90日で消す（retention.ts）。

-- 広告クリックの受付（Wix の本店ページから登録）。ad_ref は URL で受け渡す唯一の値。
CREATE TABLE IF NOT EXISTS ad_clicks (
  ad_ref          TEXT PRIMARY KEY,           -- 128ビットの乱数（base64url 22文字）
  store           TEXT NOT NULL,              -- 'honten' 以外は受け付けない（config.ts）
  gclid           TEXT,
  gbraid          TEXT,
  wbraid          TEXT,
  landing_path    TEXT,
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  first_seen_at   TEXT NOT NULL,              -- サーバの受付時刻（UTC ISO）。クリック時刻の近似
  expires_at      TEXT NOT NULL,              -- first_seen_at + 90日
  bind_expires_at TEXT NOT NULL,              -- この時刻を過ぎたら LINE と結びつけない
  bound_at        TEXT,
  CHECK (gclid IS NOT NULL OR gbraid IS NOT NULL OR wbraid IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_ad_clicks_expires ON ad_clicks(expires_at);

-- LINE の利用者（HMAC）と広告クリックの結びつけ。1つの ad_ref に結べる利用者は1人だけ。
CREATE TABLE IF NOT EXISTS line_bindings (
  ad_ref            TEXT PRIMARY KEY REFERENCES ad_clicks(ad_ref) ON DELETE CASCADE,
  line_user_hash    TEXT NOT NULL,            -- HMAC-SHA256(LINEのsub)。元のIDは保存しない
  bound_at          TEXT NOT NULL,
  expires_at        TEXT NOT NULL,            -- ad_clicks.expires_at と同じ
  consent_ad_data   TEXT NOT NULL CHECK (consent_ad_data IN ('granted', 'denied')),
  consent_version   TEXT NOT NULL             -- 入口ページで表示した説明文の版
);
CREATE INDEX IF NOT EXISTS idx_line_bindings_user ON line_bindings(line_user_hash, bound_at);
CREATE INDEX IF NOT EXISTS idx_line_bindings_expires ON line_bindings(expires_at);

-- 予約希望（LINE送信が成功したとフォームが報告したもの）。inquiry_id で重複を防ぐ。
-- 帰属しない問い合わせは line_user_hash / ad_ref を持たない（件数だけ残す）。
CREATE TABLE IF NOT EXISTS inquiries (
  inquiry_id      TEXT PRIMARY KEY,           -- フォームが確認画面で作る UUID v4
  store           TEXT NOT NULL,
  line_user_hash  TEXT,
  ad_ref          TEXT,
  attribution     TEXT NOT NULL CHECK (attribution IN ('none', 'ad_same_day', 'ad_delayed', 'expired')),
  hours_from_click INTEGER,
  submitted_at    TEXT NOT NULL,              -- 予約希望を送った時刻（UTC ISO）
  received_at     TEXT NOT NULL,
  resent          INTEGER NOT NULL DEFAULT 0  -- 次に開いたときの再送で届いたもの
);
CREATE INDEX IF NOT EXISTS idx_inquiries_user ON inquiries(line_user_hash, submitted_at);
CREATE INDEX IF NOT EXISTS idx_inquiries_submitted ON inquiries(submitted_at);

-- Google 広告への送信待ち・結果（Data Manager API・1リクエスト1件）。
-- 送ると request_id が返り、取り込みの成否はあとから（30分〜24時間）requestStatus で確かめる。
CREATE TABLE IF NOT EXISTS conversion_uploads (
  inquiry_id       TEXT PRIMARY KEY REFERENCES inquiries(inquiry_id) ON DELETE CASCADE,
  store            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN (
                     'pending',              -- 送る前
                     'retry',                -- 一時的な失敗のあと、次の時刻に送り直す
                     'submitted',            -- 受け付けられた。取り込みの結果待ち
                     'uploaded',             -- 取り込まれた
                     'duplicate',            -- Google 側ですでに数えられていた（同じ取引ID・同じクリック）
                     'failed',               -- 送っても取り込まれない（理由は last_error_code）
                     'expired',              -- 締め切り（クリックから90日）を過ぎた
                     'blocked_consent',      -- 同意が無い
                     'suppressed_duplicate'  -- 同じ広告クリックの2件目（Google 側でも1件しか数えない）
                   )),
  conversion_at    TEXT NOT NULL,
  deadline_at      TEXT NOT NULL,             -- これを過ぎたら送らない
  attempts         INTEGER NOT NULL DEFAULT 0, -- 送った回数（結果の確認は数えない）
  next_attempt_at  TEXT,                      -- 次に送る・次に結果を確かめる時刻
  request_id       TEXT,                      -- Data Manager API の requestId（個人の情報ではない）
  submitted_at     TEXT,
  status_checks    INTEGER NOT NULL DEFAULT 0,
  last_error_code  TEXT,                      -- 種類だけ。相手の応答文は保存しない
  uploaded_at      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_due ON conversion_uploads(status, next_attempt_at);

-- 回数制限（固定窓）。key は HMAC(IP) か HMAC(利用者) で、生のIPは保存しない。
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket        TEXT NOT NULL,
  key           TEXT NOT NULL,
  window_start  TEXT NOT NULL,
  count         INTEGER NOT NULL,
  PRIMARY KEY (bucket, key, window_start)
);

-- 診断の件数（日ごと・種類ごと）。利用者の情報は持たない。
CREATE TABLE IF NOT EXISTS diag_counters (
  day    TEXT NOT NULL,                       -- JST の日付
  code   TEXT NOT NULL,
  count  INTEGER NOT NULL,
  PRIMARY KEY (day, code)
);

-- 削除処理の記録（監査用）。
CREATE TABLE IF NOT EXISTS retention_runs (
  run_at                TEXT PRIMARY KEY,
  clicks_deleted        INTEGER NOT NULL,
  bindings_deleted      INTEGER NOT NULL,
  inquiries_scrubbed    INTEGER NOT NULL,
  inquiries_deleted     INTEGER NOT NULL,
  uploads_expired       INTEGER NOT NULL,
  uploads_deleted       INTEGER NOT NULL,
  rate_limits_deleted   INTEGER NOT NULL
);
