"""
官公庁HP巡回・案件抽出スクリプト
スプレッドシートからURL読み込み → 各サイトをスクレイピング → フィルタ → 書き込み
"""
import sys
import time
import re
import logging
import warnings
from datetime import date
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
import gspread

sys.stdout.reconfigure(encoding="utf-8")
warnings.filterwarnings("ignore")  # SSL警告抑制

# ─── 設定 ───────────────────────────────────────────────────────────────────
SPREADSHEET_ID    = "1-VUFFVlKmmxEnBbkfzXcTNaFESqcYTNAJQQOCh5qApc"
SOURCE_SHEET      = "穴場発注者 のコピー"
SHIKAKU_SHEET     = "資格登録リスト  のコピー"
TARGET_SHEET      = "下書き"
CREDENTIALS_FILE  = "hp-research-account.json"
SCOPES            = ["https://www.googleapis.com/auth/spreadsheets"]
REQUEST_INTERVAL  = 2.0   # 秒（サーバー負荷軽減）
FETCH_TIMEOUT     = 20    # 秒

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ja,en;q=0.9",
}

# ─── フィルタ用キーワード ──────────────────────────────────────────────────
KINKI_KW    = ["近畿", "大阪", "京都", "兵庫", "奈良", "和歌山", "滋賀",
               "関西", "阪神", "摂津", "播磨", "紀伊", "丹波", "大和",
               "舞鶴", "豊岡", "神戸", "堺", "姫路", "尼崎", "西宮"]
KENSETSU_KW = ["建築一式", "建築工事"]
DENKI_KW    = ["電気工事", "電気設備工事", "電気設備", "電気"]
SEISO_KW    = ["清掃", "クリーニング", "除草", "草刈り", "草刈"]
SHIKKI_KW   = ["什器", "移設", "搬入搬出", "引越し", "家具移動"]
KOJI_YAKUMU_KW = [
    "修繕", "メンテナンス", "保守点検", "保守管理", "維持管理",
    "改修工事", "補修", "設備管理", "空調管理", "設備保守",
    "点検整備", "保全", "改修", "整備", "工事管理",
]
BUSSHI_NG_KW = [
    "物品購入", "物品調達", "消耗品", "備品購入", "物品売買",
    "購入（物品", "物品の購入", "物品の調達", "物品購買",
    "物品の購買", "購買（物品",
]
CONSUL_NG_KW = ["建設コンサルタント", "測量業務", "設計業務", "地質調査"]
# カテゴリページ・案内ページとして除外するリンクテキスト（部分一致）
CATEGORY_NG = [
    "入札公告（物品", "物品、役務等", "入札公告一覧", "入札情報一覧",
    "調達情報一覧", "入札公告等一覧", "入札・調達情報",
    "発注見通し", "発注の見通し", "入札説明書・説明書（共通事項",
    "積算関係資料", "指名停止等措置", "閲覧方法", "見積競争について",
    "今後の新たな取組", "手続き", "改善と今後",
    # ナビゲーションメニュー系
    "工事・業務・物品・役務", "物品・役務の一般競争", "建設工事及び建設コンサルタ",
    "公共調達の適正化に基づく情報の公表", "成績評定通知書", "成績評定点通知書",
    "落札率の推移", "受注業者ごとの当初契約金額", "各年度毎の受注業者",
    "各年度ごとの受注業者", "電子調達システムの導入",
    "入札及び契約の過程に並びに", "工事検索(入札結果)",
    "本局・その他事務所", "近畿地方整備局本局",
    "企画競争（役務）", "物品・役務の一般競争",
    "会場整備参加・運営参加", "会場整備・交通アクセス情報",
    "ICT化",
]
# この年より前の日付を持つ案件は除外（古い案件フィルタ）
CUTOFF_YEAR = 2025
# 終了済み案件を示すキーワード（タイトルに含まれたら除外）
CLOSED_KW = [
    "落札者決定", "落札者の決定", "見積採用事業者決定", "最優秀提案事業者決定",
    "契約締結", "結果の公表", "中止", "取消", "廃止",
]
SECTION_SKIP = ["機関名", "チェック必須", "電気", "防水", "什器", "清掃", "草"]

TODAY = date.today()


def contains_any(text: str, kw_list: list[str]) -> bool:
    return any(kw in text for kw in kw_list)


def is_org_kinki(org_name: str) -> bool:
    """機関名が近畿系なら True（履行場所が明示されていない案件も近畿扱い）"""
    return contains_any(org_name, KINKI_KW)


def is_category_page(text: str) -> bool:
    """カテゴリ・案内ページ的なリンクテキストなら True"""
    return contains_any(text, CATEGORY_NG)


def classify(text: str, org_name: str) -> tuple[bool, str, str]:
    """
    (include, エリア, 入札資格) を返す。
    include=False のとき他2つは空文字。
    """
    full = text + " " + org_name

    # 物品購入・カテゴリページ・終了済み案件・コンサル系は除外
    if contains_any(full, BUSSHI_NG_KW):
        return False, "", ""
    if contains_any(full, CONSUL_NG_KW):
        return False, "", ""
    if is_category_page(text):
        return False, "", ""
    if contains_any(text, CLOSED_KW):
        return False, "", ""

    area_flag = is_org_kinki(org_name) or contains_any(text, KINKI_KW)
    area      = "近畿" if area_flag else "全国"

    quals = []

    # 条件①: 近畿 + 建築一式 or 電気
    if area_flag:
        if contains_any(full, KENSETSU_KW):
            quals.append("建築一式")
        if contains_any(full, DENKI_KW):
            quals.append("電気工事")
        if quals:
            return True, area, "・".join(quals)

    # 条件②: 電気工事（全国）
    if contains_any(full, DENKI_KW):
        return True, area, "電気工事"

    # 条件③: 役務（工事系・清掃・什器移設）
    yakumu_quals = []
    if contains_any(full, KOJI_YAKUMU_KW):
        yakumu_quals.append("工事系役務")
    if contains_any(full, SEISO_KW):
        yakumu_quals.append("清掃役務")
    if contains_any(full, SHIKKI_KW):
        yakumu_quals.append("什器移設役務")

    if yakumu_quals:
        return True, area, "・".join(yakumu_quals)

    return False, "", ""


# ─── 日付パース・フィルタ ──────────────────────────────────────────────────
_DATE_PATTERNS = [
    re.compile(r"令和\s*(\d+)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日"),
    re.compile(r"R(\d+)[\.年/](\d{1,2})[\.月/](\d{1,2})日?"),
    re.compile(r"(\d{4})[年/\-](\d{1,2})[月/\-](\d{1,2})日?"),
    re.compile(r"(\d{2})\s*[年/\.]\s*(\d{1,2})\s*[月/\.]\s*(\d{1,2})日?"),
]
_REIWA_BASE = 2018  # 令和元年 = 2019 → offset 2018

def extract_deadline(text: str) -> str:
    for p in _DATE_PATTERNS:
        m = p.search(text)
        if m:
            return m.group(0)
    return ""


def deadline_year(text: str) -> int | None:
    """締切テキストから西暦年を返す。取得できなければ None。"""
    m = re.search(r"令和\s*(\d+)", text)
    if m:
        return _REIWA_BASE + int(m.group(1))
    m = re.search(r"R(\d+)", text)
    if m:
        return _REIWA_BASE + int(m.group(1))
    m = re.search(r"(20\d{2})", text)
    if m:
        return int(m.group(1))
    # YY.MM.DD 形式
    m = re.search(r"^(\d{2})\.", text.strip())
    if m:
        yy = int(m.group(1))
        return 2000 + yy
    return None


def is_too_old(deadline_str: str) -> bool:
    """締切日が CUTOFF_YEAR より前なら True（日付なしは除外しない）"""
    if not deadline_str:
        return False
    year = deadline_year(deadline_str)
    if year is None:
        return False
    return year < CUTOFF_YEAR


def parse_date_str(text: str) -> date | None:
    """各種日付フォーマットを date オブジェクトに変換"""
    m = re.search(r"令和\s*(\d+)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", text)
    if m:
        try:
            return date(_REIWA_BASE + int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass
    m = re.search(r"R(\d+)[\.年/](\d{1,2})[\.月/](\d{1,2})", text)
    if m:
        try:
            return date(_REIWA_BASE + int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass
    m = re.search(r"(\d{4})[年/\-](\d{1,2})[月/\-](\d{1,2})", text)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass
    return None


def is_past_deadline(deadline_str: str) -> bool:
    """締切日が今日より前なら True（日付なしは除外しない）"""
    if not deadline_str:
        return False
    d = parse_date_str(deadline_str)
    if d is None:
        return False
    return d < TODAY


_PUB_DATE_KEYWORDS = ["公告日", "公開日", "掲載日", "公示日", "入札公告日", "受付開始日"]

def extract_pub_date(text: str) -> date | None:
    """テキストから公開日・公告日を抽出"""
    for kw in _PUB_DATE_KEYWORDS:
        idx = text.find(kw)
        if idx >= 0:
            d = parse_date_str(text[idx: idx + 40])
            if d:
                return d
    return None


# ─── HTTP取得 ─────────────────────────────────────────────────────────────
def fetch(url: str) -> str | None:
    try:
        r = requests.get(url, headers=HEADERS, timeout=FETCH_TIMEOUT, verify=False)
        r.encoding = r.apparent_encoding or "utf-8"
        return r.text
    except Exception as e:
        log.warning(f"  取得失敗: {url} — {e}")
        return None


# ─── テーブルからの抽出 ────────────────────────────────────────────────────
PROC_HDR_KW = ["件名", "案件", "入札", "工事", "役務", "物品", "調達", "業務", "契約"]

def parse_tables(soup: BeautifulSoup, base_url: str, org_name: str,
                 last_research_date: date | None = None) -> list[dict]:
    results = []
    for table in soup.find_all("table"):
        first_row = table.find("tr")
        if not first_row:
            continue
        hdr_text = first_row.get_text()
        if not contains_any(hdr_text, PROC_HDR_KW):
            continue

        for tr in table.find_all("tr")[1:]:
            tds = tr.find_all(["td", "th"])
            if not tds:
                continue
            row_text = " ".join(td.get_text(" ", strip=True) for td in tds)
            if len(row_text) < 8:
                continue

            link_tag = tr.find("a", href=True)
            item_url  = urljoin(base_url, link_tag["href"]) if link_tag else base_url
            name      = link_tag.get_text(strip=True) if link_tag else tds[0].get_text(strip=True)
            deadline  = extract_deadline(row_text)

            # 条件2: 締切日が今日より前は除外
            if is_past_deadline(deadline):
                continue

            ok, area, qual = classify(row_text + " " + name, org_name)
            if not ok or is_too_old(deadline):
                continue

            # 条件1: 前回リサーチ日より前に公開された案件は除外
            if last_research_date:
                pub_date = extract_pub_date(row_text)
                if pub_date and pub_date < last_research_date:
                    continue

            results.append(dict(name=name, qual=qual, area=area,
                                deadline=deadline, url=item_url))
    return results


# ─── リンクリストからの抽出 ────────────────────────────────────────────────
PROC_LINK_KW = ["工事", "役務", "清掃", "修繕", "電気", "建築", "保守",
                "什器", "移設", "メンテ", "設備", "整備", "改修", "補修"]

def parse_links(soup: BeautifulSoup, base_url: str, org_name: str,
                last_research_date: date | None = None) -> list[dict]:
    results  = []
    seen     = set()
    # メインコンテンツ領域を優先
    main = (soup.find("main")
            or soup.find(id=re.compile(r"content|main|body", re.I))
            or soup.body)
    if not main:
        return results

    for a in main.find_all("a", href=True):
        text = a.get_text(strip=True)
        if len(text) < 6:
            continue
        if not contains_any(text, PROC_LINK_KW):
            continue

        item_url = urljoin(base_url, a["href"])
        if item_url in seen:
            continue
        seen.add(item_url)

        # 親要素のテキストも含めてコンテキスト確保
        ctx = a.parent.get_text(" ", strip=True) if a.parent else text
        deadline = extract_deadline(ctx + " " + text)

        # 条件2: 締切日が今日より前は除外
        if is_past_deadline(deadline):
            continue

        ok, area, qual = classify(text + " " + ctx, org_name)
        if not ok or is_too_old(deadline):
            continue

        # 条件1: 前回リサーチ日より前に公開された案件は除外
        if last_research_date:
            pub_date = extract_pub_date(ctx + " " + text)
            if pub_date and pub_date < last_research_date:
                continue

        results.append(dict(name=text, qual=qual, area=area,
                            deadline=deadline, url=item_url))
    return results


# ─── 1機関スクレイピング ──────────────────────────────────────────────────
def scrape(org_name: str, url: str,
           last_research_date: date | None = None) -> list[dict]:
    log.info(f"巡回中: {org_name}")
    html = fetch(url)
    if not html:
        return []

    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    items = parse_tables(soup, url, org_name, last_research_date)

    seen_urls = {i["url"] for i in items}
    for item in parse_links(soup, url, org_name, last_research_date):
        if item["url"] not in seen_urls:
            items.append(item)
            seen_urls.add(item["url"])

    # 重複案件名の除去
    seen_names = set()
    unique = []
    for i in items:
        key = i["name"][:40]
        if key not in seen_names:
            seen_names.add(key)
            unique.append(i)

    log.info(f"  → {len(unique)} 件ヒット")
    return unique


# ─── メイン ───────────────────────────────────────────────────────────────
def main():
    creds = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)

    # ── ソースシートからURL読み込み ──
    service = build("sheets", "v4", credentials=creds)
    sheet_data = service.spreadsheets().get(
        spreadsheetId=SPREADSHEET_ID,
        ranges=[f"'{SOURCE_SHEET}'!A1:B80"],
        includeGridData=True,
    ).execute()

    rows = sheet_data["sheets"][0]["data"][0].get("rowData", [])
    orgs: list[tuple[str, str, date | None]] = []
    for row in rows:
        vals = row.get("values", [])
        if not vals:
            continue
        cell      = vals[0]
        text      = cell.get("formattedValue", "").strip()
        hyperlink = cell.get("hyperlink", "")
        if not text or not hyperlink:
            continue
        if any(text.startswith(s) for s in SECTION_SKIP):
            continue
        # B列から前回リサーチ日を取得（なければ None）
        last_date = None
        if len(vals) >= 2:
            date_str = vals[1].get("formattedValue", "").strip()
            if date_str:
                last_date = parse_date_str(date_str)
        orgs.append((text, hyperlink, last_date))

    log.info(f"「{SOURCE_SHEET}」から {len(orgs)} 機関読み込み")

    # ── 資格登録リストからURL読み込み（F列） ──
    shikaku_data = service.spreadsheets().get(
        spreadsheetId=SPREADSHEET_ID,
        ranges=[f"'{SHIKAKU_SHEET}'!B1:F600"],
        includeGridData=True,
    ).execute()
    shikaku_rows = shikaku_data["sheets"][0]["data"][0].get("rowData", [])

    existing_urls = {url for _, url, _ in orgs}
    shikaku_count = 0
    for row in shikaku_rows:
        vals = row.get("values", [])  # B, C, D, E, F の順（インデックス 0〜4）
        # B・C・D列のうち空白でない最初の値を機関名として使う
        org_name = ""
        for cell in vals[:3]:
            v = cell.get("formattedValue", "").strip().strip("\u3000")
            if v:
                org_name = v
                break
        if not org_name:
            continue
        # F列はインデックス4
        url = vals[4].get("formattedValue", "").strip() if len(vals) >= 5 else ""
        if not url or url in existing_urls:
            continue
        orgs.append((org_name, url, None))
        existing_urls.add(url)
        shikaku_count += 1

    log.info(f"「{SHIKAKU_SHEET}」から {shikaku_count} 機関追加")
    log.info(f"巡回機関数合計: {len(orgs)}")

    # ── 各サイト巡回 ──
    all_items: list[dict] = []
    for org_name, url, last_date in orgs:
        found = scrape(org_name, url, last_date)
        for item in found:
            all_items.append({"org": org_name, **item})
        time.sleep(REQUEST_INTERVAL)

    log.info(f"\n抽出合計: {len(all_items)} 件")

    # ── 書き込み ──
    client = gspread.authorize(creds)
    ws = client.open_by_key(SPREADSHEET_ID).worksheet(TARGET_SHEET)
    ws.clear()

    header = ["機関名", "案件名", "入札資格", "エリア", "締切日", "URL"]
    rows_out = [header] + [
        [r["org"], r["name"], r["qual"], r["area"], r["deadline"], r["url"]]
        for r in all_items
    ]
    ws.update("A1", rows_out)

    log.info(f"「{TARGET_SHEET}」シートに {len(all_items)} 件書き込み完了")

    # ── コンソール表示 ──
    print("\n" + "=" * 80)
    print(f"{'機関名':<30} {'案件名':<35} {'資格':<15} {'エリア'} {'締切'}")
    print("=" * 80)
    for r in all_items:
        print(f"{r['org'][:28]:<30} {r['name'][:33]:<35} "
              f"{r['qual'][:13]:<15} {r['area']:<6} {r['deadline']}")
    print("=" * 80)
    print(f"合計 {len(all_items)} 件")


if __name__ == "__main__":
    main()
