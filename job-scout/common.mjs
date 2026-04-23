/**
 * 案件スカウト共通ユーティリティ
 * Cookie管理、HTTP、HTMLパース、出力フォーマット
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { matchesKeywords, shouldSkip, shouldSkipByContext } from './config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const TOOLS_DIR = __dirname;
export const CONFIG_DIR = join(TOOLS_DIR, '.config');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ============================================================
// Cookie
// ============================================================

export function loadCookies(platform) {
  const file = join(CONFIG_DIR, `.${platform}-cookies`);
  if (!existsSync(file)) {
    throw new Error(`Cookie なし: .${platform}-cookies が見つかりません`);
  }
  const cookies = readFileSync(file, 'utf-8').trim();
  if (!cookies) throw new Error(`Cookie 空: .${platform}-cookies`);

  const stat = statSync(file);
  const ageDays = Math.floor((Date.now() - stat.mtimeMs) / 86400000);
  if (ageDays >= 14) {
    process.stderr.write(`⚠️  ${platform} Cookie: ${ageDays}日前（期限切れの可能性）\n`);
  }
  return cookies;
}

// ============================================================
// Firebase Token
// ============================================================

export async function loadFirebaseToken(platform, apiKey, opts = {}) {
  const refreshFile = join(CONFIG_DIR, `.${platform}-refresh-token`);
  if (!existsSync(refreshFile)) {
    throw new Error(`Refresh Token なし: .${platform}-refresh-token`);
  }
  const refreshToken = readFileSync(refreshFile, 'utf-8').trim();

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (opts.referer) headers['Referer'] = opts.referer;

  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${apiKey}`,
    {
      method: 'POST',
      headers,
      body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
    }
  );
  const data = await res.json();
  if (!data.id_token) {
    throw new Error(`Token 更新失敗: ${data.error?.message || JSON.stringify(data)}`);
  }

  const tokenFile = join(CONFIG_DIR, `.${platform}-token`);
  writeFileSync(tokenFile, data.id_token, 'utf-8');
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    writeFileSync(refreshFile, data.refresh_token, 'utf-8');
  }
  return data.id_token;
}

// ============================================================
// HTTP
// ============================================================

export async function fetchPage(url, opts = {}) {
  const headers = {
    'User-Agent': UA,
    'Accept': opts.accept || 'text/html,application/xhtml+xml',
    ...opts.headers,
  };
  if (opts.cookies) headers['Cookie'] = opts.cookies;

  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${url}`);
  }
  return res;
}

export async function fetchHTML(url, opts = {}) {
  const res = await fetchPage(url, opts);
  return res.text();
}

export async function fetchJSON(url, opts = {}) {
  const res = await fetchPage(url, { ...opts, accept: 'application/json' });
  return res.json();
}

// ============================================================
// HTML パース
// ============================================================

/** URL パターンからユニーク ID を抽出 */
export function extractIds(html, pattern) {
  return [...new Set((html.match(pattern) || []).map(m => m.match(/\d+/)?.[0]).filter(Boolean))];
}

/** 指定 URL 周辺のテキストを抽出 */
export function extractContext(html, url, range = 2000) {
  const idx = html.indexOf(url);
  if (idx < 0) return '';
  return html.substring(Math.max(0, idx - range), Math.min(html.length, idx + range));
}

/** HTML からテキストノードを抽出（タグ除去） */
export function extractTextFragments(html, minLen = 8) {
  return (html.match(/>([^<]+)</g) || [])
    .map(t => t.replace(/^>|<$/g, '').trim())
    .filter(t => t.length >= minLen);
}

// ============================================================
// フィルタ
// ============================================================

export function filterJobs(jobs, { skipKeywordFilter = false } = {}) {
  return jobs.filter(job => {
    const text = [job.title, job.description, job.category].join(' ');
    if (shouldSkip(text)) return false;
    if (shouldSkipByContext(text)) return false;
    if (job._closed) return false;
    if (!skipKeywordFilter) {
      const matched = matchesKeywords(text);
      if (matched.length === 0) return false;
      job.keywords_matched = matched;
    }
    return true;
  });
}

/**
 * 並列数を制限して非同期タスクを実行
 */
export async function parallelLimit(tasks, limit = 3) {
  const results = [];
  let idx = 0;
  async function next() {
    const i = idx++;
    if (i >= tasks.length) return;
    results[i] = await tasks[i]();
    await next();
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => next()));
  return results;
}

// ============================================================
// 出力
// ============================================================

export function output(platform, jobs, error = null) {
  const result = {
    platform,
    timestamp: new Date().toISOString(),
    total: jobs.length,
    jobs: jobs.map(j => ({
      id: j.id,
      title: j.title || '',
      company: j.company || '',
      url: j.url || '',
      salary: j.salary || '',
      workload: j.workload || '',
      remote: j.remote ?? null,
      category: j.category || '',
      description: j.description || '',
      keywords_matched: j.keywords_matched || [],
    })),
    error,
  };
  console.log(JSON.stringify(result, null, 2));
  process.stderr.write(`📊 ${platform}: ${jobs.length}件\n`);
  return result;
}

export function outputError(platform, error) {
  output(platform, [], error.message || String(error));
  process.exit(1);
}
