// 広告の週次レポート（GA4 → Discord）
//
// 毎週月曜の朝に GitHub Actions から動かす（.github/workflows/ads-weekly-report.yml）。
// 本店予約フォームの GA4 から「先週（月〜日・日本時間）」の数を取り、Discord の Webhook に送る。
//
// 🔒 送るのは集計した数だけ。お客様の名前など個人の情報は GA4 にも入れていないし、ここでも扱わない。
//
// 必要な Secrets（リポジトリの Settings › Secrets and variables › Actions）
//   GA4_PROPERTY_ID         … GA4 のプロパティID（数字。G-XXXX の測定IDとは別）
//   GA4_SERVICE_ACCOUNT_JSON … GA4 に「閲覧者」で追加したサービスアカウントの鍵（JSON 全文）
//   DISCORD_WEBHOOK_URL     … 送り先の Discord の Webhook URL
//
// 手元で試すとき: 上の3つを環境変数に入れて `node scripts/ads-weekly-report.mjs --dry-run`
// （--dry-run は Discord に送らず本文を表示するだけ）

import { createSign } from "node:crypto";

const EVENTS = { formOpen: "booking_form_open", inquiry: "booking_inquiry" };
const PAID = { source: "google", medium: "cpc" };

function env(name) {
  const v = (process.env[name] ?? "").trim();
  if (!v) throw new Error(`環境変数 ${name} がありません`);
  return v;
}

// ── 期間（日本時間の先週 月〜日。比較用に前の週も） ──────────────
function ymd(d) {
  return d.toISOString().slice(0, 10);
}
export function lastWeek(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 3600_000);
  const dow = (jst.getUTCDay() + 6) % 7; // 月=0
  const thisMon = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() - dow));
  const add = (d, n) => new Date(d.getTime() + n * 86_400_000);
  return {
    current: { startDate: ymd(add(thisMon, -7)), endDate: ymd(add(thisMon, -1)) },
    previous: { startDate: ymd(add(thisMon, -14)), endDate: ymd(add(thisMon, -8)) },
  };
}

// ── サービスアカウントでアクセストークンを取る（依存パッケージなし） ──
async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "RS256", typ: "JWT" });
  const claim = b64({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  });
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${claim}`);
  const jwt = `${head}.${claim}.${signer.sign(sa.private_key).toString("base64url")}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Google の認証に失敗しました（${res.status}）`);
  return (await res.json()).access_token;
}

async function runReport(token, propertyId, body) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GA4 の取得に失敗しました（${res.status}）: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const paidFilter = {
  andGroup: {
    expressions: [
      { filter: { fieldName: "sessionSource", stringFilter: { value: PAID.source, matchType: "EXACT" } } },
      { filter: { fieldName: "sessionMedium", stringFilter: { value: PAID.medium, matchType: "EXACT" } } },
    ],
  },
};

/** 行（dateRange つき）を { date_range_0: {...}, date_range_1: {...} } にまとめる */
function byRange(report, keyIndex) {
  const out = { date_range_0: {}, date_range_1: {} };
  for (const row of report.rows ?? []) {
    const dims = row.dimensionValues.map((d) => d.value);
    const range = dims[dims.length - 1];
    const key = keyIndex === null ? "total" : dims[keyIndex];
    out[range] ??= {};
    out[range][key] = row.metricValues.map((m) => Number(m.value) || 0);
  }
  return out;
}

export async function collect({ token, propertyId, week }) {
  const dateRanges = [week.current, week.previous];
  // 1) 広告から来た人数（ユーザー・セッション）
  const visits = await runReport(token, propertyId, {
    dateRanges,
    metrics: [{ name: "totalUsers" }, { name: "sessions" }],
    dimensionFilter: paidFilter,
  });
  // 2) 広告から来た方のフォームを開いた・予約希望を送った回数
  const events = await runReport(token, propertyId, {
    dateRanges,
    dimensions: [{ name: "eventName" }],
    metrics: [{ name: "eventCount" }],
    dimensionFilter: {
      andGroup: {
        expressions: [
          ...paidFilter.andGroup.expressions,
          { filter: { fieldName: "eventName", inListFilter: { values: Object.values(EVENTS) } } },
        ],
      },
    },
  });
  // 3) 参考: 広告以外も含めた全体の予約希望
  const allInquiries = await runReport(token, propertyId, {
    dateRanges,
    metrics: [{ name: "eventCount" }],
    dimensionFilter: { filter: { fieldName: "eventName", stringFilter: { value: EVENTS.inquiry, matchType: "EXACT" } } },
  });

  // dateRange が 2 つのとき、GA4 は最後のディメンションに dateRange を付けて返す
  const v = byRange(visits, null);
  const e = byRange(events, 0);
  const a = byRange(allInquiries, null);
  const pick = (r) => ({
    users: v[r].total?.[0] ?? 0,
    sessions: v[r].total?.[1] ?? 0,
    formOpens: e[r][EVENTS.formOpen]?.[0] ?? 0,
    inquiries: e[r][EVENTS.inquiry]?.[0] ?? 0,
    allInquiries: a[r].total?.[0] ?? 0,
  });
  return { current: pick("date_range_0"), previous: pick("date_range_1") };
}

function delta(cur, prev, unit) {
  const d = cur - prev;
  if (d === 0) return `（前週比 ±0${unit}）`;
  return `（前週比 ${d > 0 ? "+" : "−"}${Math.abs(d).toLocaleString()}${unit}）`;
}

function label(s) {
  const d = new Date(`${s}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${"日月火水木金土"[d.getUTCDay()]}）`;
}

export function buildMessage({ title, week, current: c, previous: p }) {
  const line = (name, cur, prev, unit) => `・${name} ${cur.toLocaleString()}${unit}${delta(cur, prev, unit)}`;
  return [
    `**${title}｜広告の週次レポート**`,
    `${label(week.current.startDate)} 〜 ${label(week.current.endDate)}`,
    "",
    "**Google 広告から来た方**",
    line("閲覧した人", c.users, p.users, "人"),
    line("予約フォームを開いた", c.formOpens, p.formOpens, "回"),
    line("LINEで予約の希望を送った", c.inquiries, p.inquiries, "件"),
    "",
    `参考: 広告以外も含めた予約の希望 ${c.allInquiries.toLocaleString()}件${delta(c.allInquiries, p.allInquiries, "件")}`,
    "",
    "※「予約の希望」はLINEで送られた数で、予約の確定・来店の数ではありません。",
    "※ GA4 の数字は数日あとに少し変わることがあります。",
  ].join("\n");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const propertyId = env("GA4_PROPERTY_ID");
  if (!/^\d+$/.test(propertyId)) throw new Error("GA4_PROPERTY_ID は数字のプロパティIDを入れてください（G-XXXX の測定IDではありません）");
  const sa = JSON.parse(env("GA4_SERVICE_ACCOUNT_JSON"));
  const week = lastWeek();
  const token = await accessToken(sa);
  const numbers = await collect({ token, propertyId, week });
  const text = buildMessage({ title: process.env.REPORT_TITLE?.trim() || "OASIS 本店", week, ...numbers });
  if (dryRun) {
    console.log(text);
    return;
  }
  const res = await fetch(env("DISCORD_WEBHOOK_URL"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) throw new Error(`Discord に送れませんでした（${res.status}）`);
  console.log("送りました");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
