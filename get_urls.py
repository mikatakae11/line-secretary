"""
官公庁の機関名からGoogle検索で公式HPのURLを取得し、スプレッドシートのF列に書き込む。
対象シート：資格登録リスト
B・C・D列の空白でない最初の値を機関名として使用する。
"""
import sys
import time
import logging
from google.oauth2.service_account import Credentials
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


def find_official_url(org_name: str) -> str:
    query = f"{org_name} 公式サイト"
    try:
        hits = DDGS().text(query, region="jp-jp", max_results=5)
        urls = [r["href"] for r in hits] if hits else []
    except Exception as e:
        log.warning(f"  検索失敗: {e}")
        return ""

    # 公式ドメインを優先
    for url in urls:
        if any(d in url for d in OFFICIAL_DOMAINS):
            return url

    return urls[0] if urls else ""


def main():
    creds  = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
    client = gspread.authorize(creds)
    ws     = client.open_by_key(SPREADSHEET_ID).worksheet(SHEET_NAME)

    data = ws.get_all_values()
    log.info(f"シート読み込み完了: {len(data)} 行")

    count = 0
    for i, row in enumerate(data):
        if count >= TEST_LIMIT:
            break

        # B・C・D列（インデックス 1・2・3）の空白でない最初の値を使う
        org_name = ""
        for col_idx in [1, 2, 3]:
            if len(row) > col_idx and row[col_idx].strip():
                org_name = row[col_idx].strip()
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
