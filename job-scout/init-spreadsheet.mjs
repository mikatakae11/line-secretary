#!/usr/bin/env node

import { getSheetsClient, loadScoutEnv } from './google-sheets-auth.mjs';

const SETTINGS_SHEET = '設定';
const LIST_SHEET = '案件一覧';

const SETTINGS_ROWS = [
  ['項目', '値', '説明'],
  ['取得件数', '5', 'この件数だけ探索して案件一覧に保存'],
  ['指示', '', '探したい案件のキーワード（例: 広報、マーケティング、AI）。空欄ならAI・DX系をデフォルトで探索'],
  ['除外条件', 'SEO、デザイナー、ライター', '省きたい案件キーワード'],
  ['最低報酬', '50万円', '月額の最低ライン'],
  ['最大稼働量', '週2日', '希望する最大稼働'],
  ['リモート希望', 'はい', 'はい / いいえ / どちらでも'],
  ['対象プラットフォーム', '利用', '使うものだけ「はい」'],
  ['複業クラウド', 'いいえ', ''],
  ['Wantedly', 'いいえ', ''],
  ['SOKUDAN', 'いいえ', ''],
  ['Workship', 'いいえ', ''],
  ['ココナラ', 'いいえ', ''],
  ['ランサーズ', 'いいえ', ''],
  ['CrowdWorks', 'いいえ', ''],
  ['YOUTRUST', 'いいえ', ''],
];

const JOB_LIST_HEADER = [[
  '取得日時',
  'おすすめ度',
  'おすすめ理由',
  '案件名',
  '会社名',
  'プラットフォーム',
  '報酬',
  '稼働',
  'リモート',
  'URL',
  'ステータス',
  '応募文メモ',
]];

function getArgValue(name) {
  const arg = process.argv.slice(2).find((value) => value.startsWith(`${name}=`));
  return arg ? arg.split('=')[1] : '';
}

async function getSpreadsheetMeta(sheets, spreadsheetId) {
  const res = await sheets.spreadsheets.get({ spreadsheetId });
  return res.data.sheets || [];
}

async function ensureSheetsExist(sheets, spreadsheetId) {
  const sheetNames = (await getSpreadsheetMeta(sheets, spreadsheetId))
    .map((sheet) => sheet.properties?.title)
    .filter(Boolean);

  const requests = [];
  if (!sheetNames.includes(SETTINGS_SHEET)) {
    requests.push({ addSheet: { properties: { title: SETTINGS_SHEET } } });
  }
  if (!sheetNames.includes(LIST_SHEET)) {
    requests.push({ addSheet: { properties: { title: LIST_SHEET } } });
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }
}

async function isRangeEmpty(sheets, spreadsheetId, range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = res.data.values || [];
  return values.length === 0 || values.every((row) => row.every((cell) => !String(cell || '').trim()));
}

async function writeIfEmpty(sheets, spreadsheetId, range, values) {
  if (!(await isRangeEmpty(sheets, spreadsheetId, range))) return false;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
  return true;
}

async function main() {
  loadScoutEnv();
  const spreadsheetId = getArgValue('--spreadsheet') || process.env.SPREADSHEET_ID || '';
  if (!spreadsheetId) {
    throw new Error(
      '.env に SPREADSHEET_ID を設定してください'
    );
  }

  const sheets = getSheetsClient();
  await ensureSheetsExist(sheets, spreadsheetId);

  const settingsWritten = await writeIfEmpty(sheets, spreadsheetId, `'${SETTINGS_SHEET}'!A1:C${SETTINGS_ROWS.length}`, SETTINGS_ROWS);
  const headerWritten = await writeIfEmpty(sheets, spreadsheetId, `'${LIST_SHEET}'!A1:L1`, JOB_LIST_HEADER);

  console.log(JSON.stringify({
    success: true,
    spreadsheetId,
    settingsWritten,
    headerWritten,
    message: '設定シートと案件一覧ヘッダーを初期化しました',
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
