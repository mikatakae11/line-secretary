import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_DIR = join(homedir(), '.job-scout');
const TOKENS_FILE_NAME = 'tokens.json';
const ENV_CANDIDATE_PATHS = [join(__dirname, '.env')];

// dotenvを使わずに.envファイルを直接パース
function loadEnvFile(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {}
}

let envLoaded = false;

export function loadScoutEnv() {
  if (envLoaded) return;
  for (const path of ENV_CANDIDATE_PATHS) {
    if (existsSync(path)) loadEnvFile(path);
  }
  envLoaded = true;
}

export function getScoutConfigDir() {
  loadScoutEnv();
  return process.env.SCOUT_CONFIG_DIR || DEFAULT_CONFIG_DIR;
}

export function getScoutTokensPath() {
  return join(getScoutConfigDir(), TOKENS_FILE_NAME);
}

export function readStoredTokens() {
  // Render環境: 環境変数からトークンを読む
  if (process.env.JOB_SCOUT_TOKENS_JSON) {
    return JSON.parse(process.env.JOB_SCOUT_TOKENS_JSON);
  }
  const tokenPath = getScoutTokensPath();
  if (!existsSync(tokenPath)) return null;
  return JSON.parse(readFileSync(tokenPath, 'utf-8'));
}

export function saveStoredTokens(tokens) {
  const configDir = getScoutConfigDir();
  mkdirSync(configDir, { recursive: true });
  writeFileSync(getScoutTokensPath(), JSON.stringify(tokens, null, 2), 'utf-8');
}

// OAuth2トークンをリフレッシュ
async function refreshAccessToken(tokens) {
  loadScoutEnv();
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定です。');
  }
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  return {
    ...tokens,
    access_token: data.access_token,
    expiry_date: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

// 有効なアクセストークンを取得（期限切れなら自動リフレッシュ）
let cachedTokens = null;

async function getAccessToken() {
  if (!cachedTokens) {
    cachedTokens = readStoredTokens();
    if (!cachedTokens?.refresh_token) {
      throw new Error('Google Sheets に未認証です。先に `node auth-google.mjs` を実行してください。');
    }
  }
  const isExpired = !cachedTokens.expiry_date || Date.now() >= cachedTokens.expiry_date - 60000;
  if (isExpired || !cachedTokens.access_token) {
    cachedTokens = await refreshAccessToken(cachedTokens);
    // ローカル環境なら保存する（Renderは環境変数なので保存不要）
    if (!process.env.JOB_SCOUT_TOKENS_JSON) saveStoredTokens(cachedTokens);
  }
  return cachedTokens.access_token;
}

// Google Sheets APIをfetchで直接呼ぶシンプルなクライアント
function createSheetsClient() {
  const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

  async function apiFetch(url, options = {}) {
    const token = await getAccessToken();
    const resp = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(`Sheets API error: ${JSON.stringify(json)}`);
    return json;
  }

  return {
    spreadsheets: {
      values: {
        async get({ spreadsheetId, range }) {
          const url = `${BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`;
          const data = await apiFetch(url);
          return { data };
        },
        async update({ spreadsheetId, range, valueInputOption, requestBody }) {
          const url = `${BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=${valueInputOption}`;
          const data = await apiFetch(url, { method: 'PUT', body: JSON.stringify(requestBody) });
          return { data };
        },
        async append({ spreadsheetId, range, valueInputOption, insertDataOption, requestBody }) {
          const params = new URLSearchParams({ valueInputOption, insertDataOption: insertDataOption || 'INSERT_ROWS' });
          const url = `${BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}:append?${params}`;
          const data = await apiFetch(url, { method: 'POST', body: JSON.stringify(requestBody) });
          return { data };
        },
      },
    },
  };
}

export function getSheetsClient() {
  return createSheetsClient();
}
