#!/usr/bin/env python3
"""Aivis Cloud TTS hook for Claude Code.

Reads a Claude Code hook event from stdin and speaks an appropriate
message using the Aivis Cloud text-to-speech API.

- Stop event        -> speaks Claude's last reply (the completion report)
- Notification event -> speaks that confirmation / input is required

Configuration (looked up in this order):
  1. Environment variables  AIVIS_API_KEY / AIVIS_MODEL_UUID
  2. Local file  .claude/aivis_config.json  ({"api_key": "...", "model_uuid": "..."})

The script never blocks Claude Code on failure: any error results in a
silent exit(0). Run it manually to test:

  echo '{"hook_event_name":"Stop"}' | python3 .claude/hooks/aivis_speak.py
  python3 .claude/hooks/aivis_speak.py --say "テストです"
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

API_URL = "https://api.aivis-project.com/v1/tts/synthesize"
# Aivis Cloud limits text length; keep spoken reports short.
MAX_CHARS = 220
HTTP_TIMEOUT = 30


def load_config():
    """Return (api_key, model_uuid) from env vars or the local config file."""
    api_key = os.environ.get("AIVIS_API_KEY")
    model_uuid = os.environ.get("AIVIS_MODEL_UUID")

    if not api_key or not model_uuid:
        cfg_path = os.path.join(os.path.dirname(__file__), "..", "aivis_config.json")
        if os.path.exists(cfg_path):
            try:
                with open(cfg_path, encoding="utf-8") as f:
                    cfg = json.load(f)
                api_key = api_key or cfg.get("api_key")
                model_uuid = model_uuid or cfg.get("model_uuid")
            except (OSError, ValueError):
                pass

    return api_key, model_uuid


def clean_text(text):
    """Strip markdown/code so the spoken text is natural, then truncate."""
    if not text:
        return ""
    # Drop fenced and inline code.
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    text = re.sub(r"`[^`]*`", "", text)
    # Links / images -> keep the label.
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    # Bare URLs.
    text = re.sub(r"https?://\S+", "", text)
    # Markdown emphasis / headings / list markers / quotes.
    text = re.sub(r"[#>*_~`|]", "", text)
    text = re.sub(r"^\s*[-+]\s+", "", text, flags=re.M)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS].rstrip() + "。"
    return text


def last_assistant_text(transcript_path):
    """Extract the text of the last assistant message from a JSONL transcript."""
    if not transcript_path or not os.path.exists(transcript_path):
        return ""
    found = ""
    try:
        with open(transcript_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if obj.get("type") != "assistant":
                    continue
                content = obj.get("message", {}).get("content", [])
                if isinstance(content, str):
                    parts = [content]
                else:
                    parts = [
                        c.get("text", "")
                        for c in content
                        if isinstance(c, dict) and c.get("type") == "text"
                    ]
                joined = "\n".join(p for p in parts if p).strip()
                if joined:
                    found = joined
    except OSError:
        return ""
    return found


def notification_message(message):
    """Map a Claude Code notification to a short Japanese phrase."""
    m = (message or "").lower()
    if "waiting for your input" in m or "is waiting" in m or "idle" in m:
        return "入力をお待ちしています。"
    if "permission" in m or "approve" in m or "allow" in m:
        return "確認をお願いします。"
    return message or "通知があります。"


def synthesize(text, api_key, model_uuid):
    payload = json.dumps(
        {
            "model_uuid": model_uuid,
            "text": text,
            "output_format": "mp3",
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        API_URL,
        data=payload,
        headers={
            "Authorization": "Bearer " + api_key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return resp.read()


def play(audio_bytes):
    """Write audio to a temp mp3 and play it with whatever player exists."""
    fd, path = tempfile.mkstemp(suffix=".mp3")
    try:
        os.write(fd, audio_bytes)
    finally:
        os.close(fd)

    players = [
        ["afplay", path],                                            # macOS
        ["mpg123", "-q", path],                                      # Linux
        ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", path],
        ["mpv", "--no-video", "--really-quiet", path],
        ["cvlc", "--play-and-exit", "--intf", "dummy", path],
        ["paplay", path],
    ]
    try:
        for cmd in players:
            if shutil.which(cmd[0]):
                try:
                    subprocess.run(
                        cmd,
                        check=True,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    return
                except subprocess.SubprocessError:
                    continue
        if os.name == "nt":
            # Windows fallback via the Windows Media Player COM object.
            ps = (
                "$p=New-Object -ComObject WMPlayer.OCX;"
                "$m=$p.newMedia('%s');$p.currentPlaylist.appendItem($m);"
                "$p.controls.play();Start-Sleep -Seconds 1;"
                "while($p.playState -ne 1){Start-Sleep -Milliseconds 200}" % path
            )
            try:
                subprocess.run(
                    ["powershell", "-NoProfile", "-Command", ps],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except subprocess.SubprocessError:
                pass
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def resolve_text(argv):
    """Figure out what to speak from CLI args or the hook event on stdin."""
    if len(argv) >= 2 and argv[1] == "--say":
        return clean_text(" ".join(argv[2:])) or "テストです。"

    raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    try:
        data = json.loads(raw) if raw else {}
    except ValueError:
        data = {}

    event = data.get("hook_event_name", "")
    if event == "Notification":
        return clean_text(notification_message(data.get("message", "")))

    # Stop / SubagentStop / fallback: speak the completion report.
    text = clean_text(last_assistant_text(data.get("transcript_path")))
    return text or "作業が完了しました。"


def main():
    api_key, model_uuid = load_config()
    if not api_key or not model_uuid:
        # Not configured -> stay silent, never disrupt Claude Code.
        sys.exit(0)

    text = resolve_text(sys.argv)
    if not text:
        sys.exit(0)

    try:
        audio = synthesize(text, api_key, model_uuid)
        play(audio)
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
