# Aivis Cloud で Claude Code に喋らせる設定

[Aivis Cloud](https://aivis-project.com/) の音声合成 API を使って、Claude Code が

- **作業の完了報告**（応答が終わったとき＝`Stop` イベント）
- **確認・入力が必要なとき**（`Notification` イベント）

に音声でしゃべるようにする設定です。

## 構成ファイル

| ファイル | 役割 | Git管理 |
| --- | --- | --- |
| `.claude/settings.json` | `Stop` / `Notification` フックの登録 | コミットする |
| `.claude/hooks/aivis_speak.py` | 読み上げテキストを組み立て、Aivis Cloud で合成→再生 | コミットする |
| `.claude/aivis_config.json` | APIキーとモデルUUID | **gitignore（コミットしない）** |

## 仕組み

1. Claude Code が応答を終える / 確認を求めると、フックがスクリプトを呼びます。
2. スクリプトは
   - `Stop`: トランスクリプトから直近の Claude の返答を取り出し（コードやMarkdownを除去・要約）
   - `Notification`: 「確認をお願いします」「入力をお待ちしています」などの日本語に変換
   して読み上げテキストを作ります。
3. `POST https://api.aivis-project.com/v1/tts/synthesize` で MP3 を取得し、
   端末にある再生コマンド（macOS: `afplay` / Linux: `mpg123`・`ffplay`・`paplay` 等 / Windows: WMP）で再生します。

設定が無い・APIに失敗した場合は **無音で正常終了** し、Claude Code の動作を妨げません。

## セットアップ（別マシンでクローンした場合）

APIキーはセキュリティのためコミットしていません。次のどちらかで設定します。

**A. ローカル設定ファイルを作る**

```bash
cat > .claude/aivis_config.json <<'JSON'
{
  "api_key": "あなたのAivis APIキー",
  "model_uuid": "使いたい音声モデルのUUID"
}
JSON
```

**B. 環境変数で渡す**

```bash
export AIVIS_API_KEY="あなたのAivis APIキー"
export AIVIS_MODEL_UUID="使いたい音声モデルのUUID"
```

> 音声モデルのUUIDは [AivisHub](https://hub.aivis-project.com/) で選べます。

## 動作確認

```bash
# 任意のテキストを喋らせる
python3 .claude/hooks/aivis_speak.py --say "セットアップ完了です"

# 完了報告フックの擬似テスト
echo '{"hook_event_name":"Notification","message":"Claude needs your permission"}' \
  | python3 .claude/hooks/aivis_speak.py
```

Claude Code 上では、設定変更後に `/hooks` で登録状況を確認できます。
（macOS のローカル環境など、音声出力と API への到達が可能な環境で動きます。）

## 全プロジェクトで有効にしたい場合

`.claude/settings.json` の `hooks` ブロックを、ユーザー設定 `~/.claude/settings.json`
にコピーすると、どのプロジェクトでも喋るようになります。
