import sys
import gspread
from google.oauth2.service_account import Credentials

sys.stdout.reconfigure(encoding="utf-8")

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
SPREADSHEET_ID = "13Ydq5HLlymAzP8hwBPYPkv8Fq3Q_3_i9tXZtzaGzJOY"
SHEET_NAME = "穴場発注者"
CREDENTIALS_FILE = "hp-research-account.json"

creds = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
client = gspread.authorize(creds)

sheet = client.open_by_key(SPREADSHEET_ID).worksheet(SHEET_NAME)

col_a = sheet.col_values(1)
col_b = sheet.col_values(2)

max_rows = max(len(col_a), len(col_b))

print(f"{'A列':<30} {'B列'}")
print("-" * 60)
for i in range(max_rows):
    a = col_a[i] if i < len(col_a) else ""
    b = col_b[i] if i < len(col_b) else ""
    print(f"{a:<30} {b}")
