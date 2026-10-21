// ステージング（LINE 実機テスト）用の、予約フォームと入口ページの「写し」を作る。
// 本番のファイル（リポジトリ直下の index.html・js/ など）は書き換えない。写しの中だけを変える。
//
//   node scripts/build-staging-site.mjs --out dist-staging-site \
//     --form-liff <STG-フォームの LIFF ID> --entry-liff <STG-入口の LIFF ID> --endpoint <ステージングの Worker の URL>
//
// 写しで変えるもの（docs/line-device-test.md の 3-2）:
//   1. js/liff-init.js の LIFF ID → STG-フォーム
//   2. js/attribution-config.js の endpoint・entryLiffId
//   3. index.html から GA4・Clarity のタグを消す（本番の解析に混ぜない）
//   4. <title> の先頭に「【テスト】」、検索に出さない（noindex）

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROD_FORM_LIFF = "2006621786-8K7V4W3M";
const LIFF_RE = /^\d{10}-[A-Za-z0-9]{8}$/;
const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function fail(message) {
  console.error(`build-staging-site: ${message}`);
  process.exit(1);
}

const out = resolve(arg("out") ?? "dist-staging-site");
const formLiff = arg("form-liff") ?? "";
const entryLiff = arg("entry-liff") ?? "";
const endpoint = (arg("endpoint") ?? "").replace(/\/+$/, "");

if (!LIFF_RE.test(formLiff) || !LIFF_RE.test(entryLiff)) fail("--form-liff と --entry-liff は LIFF ID の形（10桁-8文字）で指定してください");
if (formLiff === PROD_FORM_LIFF || entryLiff === PROD_FORM_LIFF) fail("本番の予約フォームの LIFF ID は使えません（テスト用に新しく作った LIFF を指定）");
if (formLiff === entryLiff) fail("STG-フォームと STG-入口は別の LIFF にしてください");
if (!/^https:\/\/[a-z0-9.-]+$/i.test(endpoint)) fail("--endpoint は https:// で始まる Worker の URL（パスなし）で指定してください");
if (!/staging/i.test(endpoint)) fail("--endpoint にステージングの Worker 以外が指定されています（URL に staging が入っていない）");
if (out === SITE_ROOT || out.startsWith(join(SITE_ROOT, "js")) || out.startsWith(join(SITE_ROOT, "css"))) fail("--out に本番のファイルの場所は指定できません");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const item of ["index.html", "entry.html", "css", "js", "img"]) {
  const from = join(SITE_ROOT, item);
  if (!existsSync(from)) fail(`${item} が見つかりません`);
  cpSync(from, join(out, item), { recursive: true });
}

const edit = (path, fn) => writeFileSync(join(out, path), fn(readFileSync(join(out, path), "utf8")));
const replaceOnce = (text, from, to, label) => {
  if (!text.includes(from)) fail(`${label} の置き換え元が見つかりません（本番のファイルが変わった可能性）`);
  return text.replace(from, to);
};

// 1. 予約フォームの LIFF ID
edit("js/liff-init.js", (t) => replaceOnce(t, `liffId: "${PROD_FORM_LIFF}"`, `liffId: "${formLiff}"`, "liff-init.js"));

// 2. 広告帰属の設定
edit("js/attribution-config.js", (t) =>
  replaceOnce(replaceOnce(t, 'endpoint: ""', `endpoint: "${endpoint}"`, "endpoint"), 'entryLiffId: ""', `entryLiffId: "${entryLiff}"`, "entryLiffId"),
);

// 3・4. 解析タグを消し、テストと分かるようにする
edit("index.html", (t) => {
  let s = t.replace(/\s*<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js[^"]*"><\/script>/, "");
  s = s.replace(/\s*<script>\s*window\.dataLayer[\s\S]*?<\/script>/, "");
  s = s.replace(/\s*<script type="text\/javascript">\s*\(function \(c, l, a, r, i, t, y\)[\s\S]*?<\/script>/, "");
  s = s.replace(/<title>/, '<meta name="robots" content="noindex" />\n    <title>【テスト】');
  return s;
});
edit("entry.html", (t) => t.replace(/<title>/, "<title>【テスト】"));

// 仕上がりの確認: 本番の LIFF ID・解析タグが残っていないこと
const all = ["index.html", "entry.html", "js/liff-init.js", "js/attribution-config.js"].map((p) => readFileSync(join(out, p), "utf8")).join("\n");
for (const [needle, label] of [
  [PROD_FORM_LIFF, "本番の LIFF ID"],
  ["googletagmanager.com", "GA4 のタグ"],
  ["G-D9P3LB3Q1C", "GA4 の測定ID"],
  ["clarity.ms", "Clarity のタグ"],
]) {
  if (all.includes(needle)) fail(`写しに${label}が残っています`);
}
if (!all.includes(formLiff) || !all.includes(entryLiff) || !all.includes(endpoint)) fail("写しに設定が入っていません");

console.log(`build-staging-site: ${out} に写しを作りました（本番のファイルは変えていません）`);
