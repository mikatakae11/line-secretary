"""
官公庁の機関名からGoogle検索で公式HPのURLを取得し、スプレッドシートのF列に書き込む。
対象シート：資格登録リスト  のコピー
B・C・D列の薄黄色セルのみを対象にする（includeGridData で背景色を判定）。
"""
import sys
import time
import logging
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
import gspread
from ddgs import DDGS

sys.stdout.reconfigure(encoding="utf-8")

SPREADSHEET_ID   = "1-VUFFVlKmmxEnBbkfzXcTNaFESqcYTNAJQQOCh5qApc"
SHEET_NAME       = "資格登録リスト  のコピー"
CREDENTIALS_FILE = "hp-research-account.json"
SCOPES           = ["https://www.googleapis.com/auth/spreadsheets"]
TEST_LIMIT       = 10
INTERVAL         = 2.0

# 公式ドメインと判定するパターン（優先順）
OFFICIAL_DOMAINS = [".go.jp", ".lg.jp", ".ed.jp", ".ac.jp", ".or.jp", ".ne.jp"]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)


def is_light_yellow(bg: dict) -> bool:
    """背景色が薄黄色かどうかを判定する（白・無色は除外）"""
    r = bg.get("red", 1.0)
    g = bg.get("green", 1.0)
    b = bg.get("blue", 1.0)
    return r >= 0.9 and g >= 0.85 and b < 0.95


def find_official_url(org_name: str) -> str:
    query = f"{org_name} 公式サイト"
    try:
        hits = DDGS().text(query, region="jp-jp", max_results=5)
        urls = [r["href"] for r in hits] if hits else []
    except Exception as e:
        log.warning(f"  検索失敗: {e}")
        return ""

    for url in urls:
        if any(d in url for d in OFFICIAL_DOMAINS):
            return url

    return urls[0] if urls else ""


def main():
    creds   = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
    service = build("sheets", "v4", credentials=creds)

    # includeGridData で書式（背景色）ごと取得
    result = service.spreadsheets().get(
        spreadsheetId=SPREADSHEET_ID,
        ranges=[f"'{SHEET_NAME}'!B1:D600"],
        includeGridData=True,
    ).execute()

    rows = result["sheets"][0]["data"][0].get("rowData", [])
    log.info(f"シート読み込み完了: {len(rows)} 行")

    # gspread クライアントはF列書き込み用
    client = gspread.authorize(creds)
    ws     = client.open_by_key(SPREADSHEET_ID).worksheet(SHEET_NAME)

    count = 0
    for i, row in enumerate(rows):
        if count >= TEST_LIMIT:
            break

        cells = row.get("values", [])  # B, C, D の順（インデックス 0, 1, 2）

        # B・C・D列のうち薄黄色で空白でない最初のセルを機関名として使う
        org_name = ""
        for cell in cells:
            bg  = cell.get("effectiveFormat", {}).get("backgroundColor", {})
            val = cell.get("formattedValue", "").strip().strip("\u3000")  # 全角スペース除去
            if val and is_light_yellow(bg):
                org_name = val
                break

        if not org_name:
            continue

        row_num = i + 1  # スプレッドシートは1始まり
        log.info(f"[{count + 1}/{TEST_LIMIT}] 行{row_num} | {org_name}")

        url = find_official_url(org_name)

        if url:
            ws.update_cell(row_num, 6, url)  # F列 = 6
            log.info(f"  → {url}")
        else:
            log.info(f"  → URLが見つかりませんでした")

        count += 1
        time.sleep(INTERVAL)

    log.info(f"\n完了: {count} 件処理しました")


if __name__ == "__main__":
    main()
