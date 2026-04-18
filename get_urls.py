"""
官公庁の機関名からGoogle検索で公式HPのURLを取得し、スプレッドシートのF列に書き込む。
対象シート：資格登録リスト  のコピー
B・C・D列の薄黄色セルのみを対象にする（includeGridData で背景色を判定）。
"""
import re
import sys
import time
import logging
from urllib.parse import urlparse
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
import gspread
from ddgs import DDGS

sys.stdout.reconfigure(encoding="utf-8")

SPREADSHEET_ID   = "1-VUFFVlKmmxEnBbkfzXcTNaFESqcYTNAJQQOCh5qApc"
SHEET_NAME       = "資格登録リスト  のコピー"
CREDENTIALS_FILE = "hp-research-account.json"
SCOPES           = ["https://www.googleapis.com/auth/spreadsheets"]
INTERVAL         = 2.0

# 優先順に並べた公式ドメイン
OFFICIAL_DOMAINS = [
    ".go.jp", ".mod.go.jp", ".lg.jp", ".ed.jp", ".ac.jp", ".or.jp",
]

# 除外するドメイン（信頼性の低いサイト）
NG_DOMAINS = [
    "wikipedia.org", "wikimedia.org", "grokipedia.com",
    "crammbon.com", "yahoo.co.jp", "google.com",
    "amazon.co.jp", "rakuten.co.jp", "twitter.com", "x.com",
    "facebook.com", "instagram.com", "youtube.com",
]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)


def normalize_org_name(name: str) -> str:
    """括弧内の略称と親機関名を除去し、末尾の機関名だけを返す"""
    name = re.sub(r"[（(][A-Z]+[）)]", "", name)
    parts = name.split()
    return parts[-1] if parts else name.strip()


def is_light_yellow(bg: dict) -> bool:
    """背景色が薄黄色かどうかを判定する（白・無色は除外）"""
    r = bg.get("red", 1.0)
    g = bg.get("green", 1.0)
    b = bg.get("blue", 1.0)
    return r >= 0.9 and g >= 0.85 and b < 0.95


def is_ng(url: str) -> bool:
    return any(ng in url for ng in NG_DOMAINS)


def is_official(url: str) -> bool:
    return any(d in url for d in OFFICIAL_DOMAINS)


def find_official_url(org_name: str) -> str:
    query_name = normalize_org_name(org_name)
    query = f"{query_name} 公式サイト"
    log.info(f"  検索: {query}")

    try:
        hits = DDGS().text(query, region="jp-jp", max_results=10)
        urls = [r["href"] for r in hits] if hits else []
    except Exception as e:
        log.warning(f"  検索失敗: {e}")
        return ""

    # NGドメインを除外
    urls = [u for u in urls if not is_ng(u)]

    # 1. 公式ドメインを優先順に探す
    for domain in OFFICIAL_DOMAINS:
        for url in urls:
            if domain in url:
                parsed = urlparse(url)
                return f"{parsed.scheme}://{parsed.netloc}/"

    # 2. 公式ドメインが見つからなければ空欄
    return ""


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
        log.info(f"[{count + 1}] 行{row_num} | {org_name}")

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
