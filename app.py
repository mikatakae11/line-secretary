"""
LINE Bot + Flask サーバー
・「リサーチ」→ scrape_procurement.py を実行してプッシュ通知
・それ以外 → 使い方を案内
"""
import os
import sys
import threading
import subprocess
import logging
from flask import Flask, request, abort
from linebot.v3 import WebhookHandler
from linebot.v3.messaging import (
    Configuration, ApiClient, MessagingApi,
    ReplyMessageRequest, PushMessageRequest, TextMessage,
)
from linebot.v3.webhooks import MessageEvent, TextMessageContent
from linebot.v3.exceptions import InvalidSignatureError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

app = Flask(__name__)

# ─── LINE ────────────────────────────────────────────────────────────────────
handler     = WebhookHandler(os.environ["LINE_CHANNEL_SECRET"])
line_config = Configuration(access_token=os.environ["LINE_CHANNEL_ACCESS_TOKEN"])

# ─── Google認証ファイルの生成（Render用）────────────────────────────────────
def setup_google_credentials():
    """
    Render の環境変数 GOOGLE_CREDENTIALS_JSON に
    hp-research-account.json の中身を貼り付けておくと自動生成される。
    """
    raw = os.environ.get("GOOGLE_CREDENTIALS_JSON", "")
    if not raw:
        return
    cred_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hp-research-account.json")
    if not os.path.exists(cred_path):
        with open(cred_path, "w", encoding="utf-8") as f:
            f.write(raw)
        log.info("Google credentials file created.")

setup_google_credentials()


# ─── ヘルパー：プッシュ通知 ──────────────────────────────────────────────────
def push_message(user_id: str, text: str) -> None:
    with ApiClient(line_config) as api_client:
        MessagingApi(api_client).push_message(
            PushMessageRequest(to=user_id, messages=[TextMessage(text=text)])
        )


# ─── バックグラウンド: 案件スカウト実行 ──────────────────────────────────────
def run_job_scout(user_id: str) -> None:
    job_scout_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "job-scout")
    script = os.path.join(job_scout_dir, "run-from-sheet.mjs")
    try:
        spreadsheet_id = os.environ.get("JOB_SCOUT_SPREADSHEET_ID", "")
        cmd = ["node", script]
        if spreadsheet_id:
            cmd.append(f"--spreadsheet={spreadsheet_id}")
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600,
            cwd=job_scout_dir,
            env={**os.environ},
        )
        if result.returncode == 0:
            push_message(user_id, "✅ 案件取得が完了しました。\nスプレッドシートの「案件一覧」をご確認ください。")
        else:
            err = (result.stderr or result.stdout or "").strip()[:400] or "（詳細不明）"
            log.error(f"job-scout failed:\n{err}")
            push_message(user_id, f"⚠️ 案件取得でエラーが発生しました。\n{err}")
    except subprocess.TimeoutExpired:
        push_message(user_id, "⚠️ タイムアウトしました（10分超過）。")
    except Exception as e:
        log.exception("run_job_scout error")
        push_message(user_id, f"⚠️ 予期しないエラー: {e}")


# ─── バックグラウンド: スクレイピング実行 ────────────────────────────────────
def run_scrape(user_id: str) -> None:
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scrape_procurement.py")
    try:
        result = subprocess.run(
            [sys.executable, script],
            capture_output=True,
            text=True,
            timeout=1200,         # 最大20分
            cwd=os.path.dirname(os.path.abspath(__file__)),
        )
        if result.returncode == 0:
            push_message(user_id, "✅ リサーチ完了しました。\nスプレッドシートの「下書き」シートをご確認ください。")
        else:
            err = result.stderr.strip()[-300:] if result.stderr else "（詳細不明）"
            log.error(f"scrape failed:\n{err}")
            push_message(user_id, f"⚠️ 実行中にエラーが発生しました。\n{err}")
    except subprocess.TimeoutExpired:
        push_message(user_id, "⚠️ タイムアウトしました（20分超過）。")
    except Exception as e:
        log.exception("run_scrape error")
        push_message(user_id, f"⚠️ 予期しないエラー: {e}")


# ─── Webhook エンドポイント ───────────────────────────────────────────────────
@app.route("/callback", methods=["POST"])
def callback():
    signature = request.headers.get("X-Line-Signature", "")
    body = request.get_data(as_text=True)
    try:
        handler.handle(body, signature)
    except InvalidSignatureError:
        log.warning("Invalid signature")
        abort(400)
    return "OK"


# ─── メッセージハンドラ ───────────────────────────────────────────────────────
@handler.add(MessageEvent, message=TextMessageContent)
def handle_message(event: MessageEvent) -> None:
    user_id = event.source.user_id
    text    = event.message.text.strip()

    with ApiClient(line_config) as api_client:
        api = MessagingApi(api_client)

        # ── リサーチコマンド ──────────────────────────────────────────────
        if text == "リサーチ":
            api.reply_message(ReplyMessageRequest(
                reply_token=event.reply_token,
                messages=[TextMessage(
                    text="🔍 巡回を開始します。\n完了までしばらくお待ちください（目安：約5分）。"
                )],
            ))
            threading.Thread(target=run_scrape, args=(user_id,), daemon=True).start()

        # ── 案件取得コマンド ──────────────────────────────────────────────
        elif "案件取得" in text:
            api.reply_message(ReplyMessageRequest(
                reply_token=event.reply_token,
                messages=[TextMessage(
                    text="🔍 案件取得を開始します。\n完了までしばらくお待ちください（目安：約3分）。"
                )],
            ))
            threading.Thread(target=run_job_scout, args=(user_id,), daemon=True).start()

        # ── その他 ───────────────────────────────────────────────────────
        else:
            api.reply_message(ReplyMessageRequest(
                reply_token=event.reply_token,
                messages=[TextMessage(text="「リサーチ」→ 官公庁案件調査\n「案件取得」→ フリーランス案件取得")],
            ))


# ─── ヘルスチェック ───────────────────────────────────────────────────────────
@app.route("/", methods=["GET"])
def health():
    return "OK", 200


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
