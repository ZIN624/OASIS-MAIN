// 環境変数の読み取り。値が足りないときは「止まる」側に倒す（予約は Worker と無関係に動く）。

export interface Env {
  ATTR_DB: D1Database;
  /** "true" のときだけ受付を動かす（停止スイッチ）。 */
  AD_ATTR_ENABLED?: string;
  /** "true" のときだけ Google 広告へ送る。送信方式が決まるまで "false" のまま。 */
  UPLOAD_ENABLED?: string;
  /** 'honten' 固定。他の店舗のデータを混ぜない。 */
  STORE_ID?: string;
  /** "development" | "staging" | "production" */
  ENV_NAME?: string;
  /** Wix（広告クリックの登録元）。カンマ区切りの Origin。 */
  AD_CLICK_ORIGINS?: string;
  /** 予約フォーム・入口ページ（GitHub Pages）。カンマ区切りの Origin。 */
  FORM_ORIGINS?: string;
  /** 本店のページだけ受け付ける（カンマ区切り。デコード後の pathname）。 */
  LANDING_PATHS?: string;
  /** IDトークンの aud として認める LINE ログインのチャネルID（カンマ区切り）。 */
  LINE_CHANNEL_IDS?: string;
  /** 広告クリックから LINE と結びつけてよい時間（時間）。 */
  BIND_WINDOW_HOURS?: string;
  /** 秘密（wrangler secret）。HKDF の元鍵。base64 で32バイト以上。 */
  ATTR_ROOT_KEY?: string;
  /** 秘密（wrangler secret）。診断APIの Bearer。 */
  ADMIN_TOKEN?: string;
  /** Data Manager API: 本店の Google 広告アカウントID（ハイフンなし10桁）。 */
  DM_OPERATING_ACCOUNT_ID?: string;
  /** Data Manager API: 管理アカウント経由で送るときだけ（ハイフンなし10桁）。 */
  DM_LOGIN_ACCOUNT_ID?: string;
  /** Data Manager API: 新しく作るコンバージョンアクション（UPLOAD_CLICKS）のID。 */
  DM_CONVERSION_ACTION_ID?: string;
  /** "false" のときだけ実際に取り込ませる。既定は validateOnly（確かめるだけで取り込まない）。 */
  DM_VALIDATE_ONLY?: string;
  /** 秘密（wrangler secret）。サービスアカウントの鍵（JSON）。 */
  GOOGLE_SA_KEY_JSON?: string;
}

export interface Config {
  enabled: boolean;
  uploadEnabled: boolean;
  store: string;
  envName: string;
  adClickOrigins: string[];
  formOrigins: string[];
  landingPaths: string[];
  lineChannelIds: string[];
  bindWindowHours: number;
  rootKey: string | null;
  adminToken: string | null;
  dataManager: DataManagerConfig | null;
}

export interface DataManagerConfig {
  operatingAccountId: string;
  loginAccountId: string | null;
  conversionActionId: string;
  validateOnly: boolean;
}

/** クリックを保存する日数（オーナー決定③）。 */
export const CLICK_RETENTION_DAYS = 90;
/** 問い合わせの件数を残す期間（月）。識別子は90日で消す。 */
export const INQUIRY_RETENTION_MONTHS = 13;
/** クリックから最初に Google へ送るまでの時間。直後は「まだ処理中」で弾かれるため（Google 広告ヘルプ）。 */
export const FIRST_UPLOAD_AFTER_CLICK_HOURS = 6;
/** フォームのセッション（IDトークンを検証した印）の有効時間。 */
export const SESSION_TTL_HOURS = 12;
/** 次に開いたときの再送で受け付ける、送信時刻の古さの上限。 */
export const RESEND_MAX_AGE_DAYS = 7;
/** 受け付ける本文の上限（バイト）。 */
export const MAX_BODY_BYTES = 4096;

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function normalizePath(path: string): string {
  const decoded = decodePath(path).normalize("NFC");
  return decoded.length > 1 ? decoded.replace(/\/+$/, "") : decoded;
}

export function readConfig(env: Env): Config {
  const store = (env.STORE_ID ?? "").trim();
  const bindWindow = Number(env.BIND_WINDOW_HOURS ?? "24");
  const rootKey = (env.ATTR_ROOT_KEY ?? "").trim();
  const adminToken = (env.ADMIN_TOKEN ?? "").trim();
  return {
    // 店舗IDと秘密鍵がそろわない限り、スイッチが true でも動かさない。
    enabled: env.AD_ATTR_ENABLED === "true" && store === "honten" && rootKey.length >= 32,
    uploadEnabled: env.UPLOAD_ENABLED === "true",
    store,
    envName: (env.ENV_NAME ?? "development").trim(),
    adClickOrigins: list(env.AD_CLICK_ORIGINS),
    formOrigins: list(env.FORM_ORIGINS),
    landingPaths: list(env.LANDING_PATHS).map(normalizePath),
    lineChannelIds: list(env.LINE_CHANNEL_IDS).filter((id) => /^\d{10}$/.test(id)),
    bindWindowHours: Number.isFinite(bindWindow) && bindWindow > 0 && bindWindow <= 72 ? bindWindow : 24,
    rootKey: rootKey.length >= 32 ? rootKey : null,
    adminToken: adminToken.length >= 32 ? adminToken : null,
    dataManager: readDataManagerConfig(env),
  };
}

/** 3つの値がすべて正しい形のときだけ送信先として使う。1つでも欠けたら送らない。 */
function readDataManagerConfig(env: Env): DataManagerConfig | null {
  const operating = (env.DM_OPERATING_ACCOUNT_ID ?? "").trim();
  const login = (env.DM_LOGIN_ACCOUNT_ID ?? "").trim();
  const action = (env.DM_CONVERSION_ACTION_ID ?? "").trim();
  if (!/^\d{10}$/.test(operating) || !/^\d{1,20}$/.test(action)) return null;
  if (login && !/^\d{10}$/.test(login)) return null;
  return {
    operatingAccountId: operating,
    loginAccountId: login || null,
    conversionActionId: action,
    validateOnly: env.DM_VALIDATE_ONLY !== "false",
  };
}
