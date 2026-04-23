import { createServer } from 'http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { google } from 'googleapis';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_DIR = join(homedir(), '.job-scout');
const TOKENS_FILE_NAME = 'tokens.json';
const DEFAULT_REDIRECT_PORT = 3001;
const SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
];
const ENV_CANDIDATE_PATHS = [
  join(__dirname, '.env'),
];

let envLoaded = false;

export function loadScoutEnv() {
  if (envLoaded) return;
  for (const path of ENV_CANDIDATE_PATHS) {
    if (!existsSync(path)) continue;
    dotenv.config({ path });
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

export function getRedirectPort() {
  loadScoutEnv();
  const port = Number(process.env.SCOUT_OAUTH_PORT || DEFAULT_REDIRECT_PORT);
  return Number.isFinite(port) && port > 0 ? Math.trunc(port) : DEFAULT_REDIRECT_PORT;
}

export function getRedirectUri() {
  return `http://localhost:${getRedirectPort()}/oauth2callback`;
}

function getClientCredentials() {
  loadScoutEnv();
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定です。' +
      ' job-scout/.env に設定してください。'
    );
  }
  return { clientId, clientSecret };
}

export function createOAuthClient() {
  const { clientId, clientSecret } = getClientCredentials();
  return new google.auth.OAuth2(clientId, clientSecret, getRedirectUri());
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

function attachAutoRefreshSave(client, baseTokens = {}) {
  client.on('tokens', (newTokens) => {
    const merged = {
      access_token: newTokens.access_token || baseTokens.access_token || '',
      refresh_token: newTokens.refresh_token || baseTokens.refresh_token || '',
      expiry_date: newTokens.expiry_date || baseTokens.expiry_date || 0,
      token_type: newTokens.token_type || baseTokens.token_type || 'Bearer',
      scope: newTokens.scope || baseTokens.scope || SHEETS_SCOPES.join(' '),
    };
    saveStoredTokens(merged);
  });
}

export function getAuthenticatedOAuthClient() {
  const tokens = readStoredTokens();
  if (!tokens?.refresh_token) {
    throw new Error(
      'Google Sheets に未認証です。先に `npm run auth:google` を実行してください。'
    );
  }

  const client = createOAuthClient();
  client.setCredentials(tokens);
  attachAutoRefreshSave(client, tokens);
  return client;
}

export function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuthenticatedOAuthClient() });
}

export function buildAuthUrl() {
  const client = createOAuthClient();
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: SHEETS_SCOPES,
    prompt: 'consent',
  });
  return { client, authUrl };
}

export function waitForOAuthCallback(client) {
  const port = getRedirectPort();
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '', `http://localhost:${port}`);
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');

        if (error) {
          res.writeHead(400);
          res.end(`Authentication failed: ${error}`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400);
          res.end('No authorization code received');
          server.close();
          reject(new Error('No authorization code received'));
          return;
        }

        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);

        const storedTokens = {
          access_token: tokens.access_token || '',
          refresh_token: tokens.refresh_token || '',
          expiry_date: tokens.expiry_date || 0,
          token_type: tokens.token_type || 'Bearer',
          scope: tokens.scope || SHEETS_SCOPES.join(' '),
        };
        saveStoredTokens(storedTokens);
        attachAutoRefreshSave(client, storedTokens);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h1>認証成功</h1><p>このタブを閉じて OK です。</p></body></html>');

        server.close();
        resolve(storedTokens);
      } catch (error) {
        res.writeHead(500);
        res.end('Internal error');
        server.close();
        reject(error);
      }
    });

    server.listen(port, () => {
      process.stderr.write(`🔐 OAuth コールバック待機中: http://localhost:${port}/oauth2callback\n`);
    });

    setTimeout(() => {
      server.close();
      reject(new Error('OAuth 認証がタイムアウトしました（5分）'));
    }, 5 * 60 * 1000);
  });
}
