#!/usr/bin/env node

import open from 'open';
import {
  buildAuthUrl,
  getRedirectUri,
  getScoutTokensPath,
  waitForOAuthCallback,
} from './google-sheets-auth.mjs';

async function main() {
  const { client, authUrl } = buildAuthUrl();

  process.stderr.write('Google Sheets OAuth 認証を開始します。\n');
  process.stderr.write(`リダイレクトURI: ${getRedirectUri()}\n`);
  process.stderr.write(`トークン保存先: ${getScoutTokensPath()}\n\n`);
  process.stderr.write(`認証URL:\n${authUrl}\n\n`);

  try {
    await open(authUrl);
    process.stderr.write('🌐 ブラウザを開きました。開けない場合は上記URLを手動で開いてください。\n');
  } catch {
    process.stderr.write('⚠️ ブラウザ自動起動に失敗しました。上記URLを手動で開いてください。\n');
  }

  await waitForOAuthCallback(client);
  process.stderr.write(`✅ 認証が完了しました。トークンを保存しました: ${getScoutTokensPath()}\n`);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
