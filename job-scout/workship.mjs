#!/usr/bin/env node
/**
 * Workship 案件スカウト
 * 公開 portal/search を検索 → 詳細ページで補完 → フィルタ
 *
 * 使い方:
 *   node workship.mjs
 *
 * 認証: 不要（公開情報で取得）
 */

import { fetchHTML, filterJobs, parallelLimit, output, outputError } from './common.mjs';
import { SEARCH_QUERIES } from './config.mjs';

const PLATFORM = 'workship';
const BASE = 'https://goworkship.com';
const DEFAULT_QUERIES = ['AI', 'DX', 'コンサル', 'カスタマーサクセス', 'GAS', '業務改善'];

function getArgValue(name) {
  const arg = process.argv.slice(2).find((a) => a.startsWith(`${name}=`));
  return arg ? arg.split('=')[1] : '';
}

function uniqueQueries(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function resolveQueries() {
  const depth = getArgValue('--search-depth') || 'default';
  const rawExtra = getArgValue('--queries') || '';
  const extraQueries = rawExtra.split('||').map(q => q.trim()).filter(Boolean);
  if (extraQueries.length) {
    return uniqueQueries(extraQueries);
  }
  return depth === 'deep'
    ? uniqueQueries([...DEFAULT_QUERIES, ...SEARCH_QUERIES])
    : DEFAULT_QUERIES;
}

function resolvePages() {
  const explicit = Number(getArgValue('--pages') || '');
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(Math.trunc(explicit), 8);

  const depth = getArgValue('--search-depth') || 'default';
  if (depth === 'wide') return 5;
  if (depth === 'deep') return 3;
  return 2;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimDetailText(text) {
  const markers = [
    'Workshipでできること',
    'トップ 募集を探す',
    '類似のフリーランス案件',
    '都道府県 東京都',
  ];

  let trimmed = String(text || '');
  for (const marker of markers) {
    const idx = trimmed.indexOf(marker);
    if (idx >= 0) {
      trimmed = trimmed.slice(0, idx).trim();
    }
  }
  return trimmed;
}

function formatMonthlyYenRange(min, max) {
  const values = [min, max]
    .filter(Boolean)
    .map((value) => Number(String(value).replaceAll(',', '')))
    .filter(Number.isFinite)
    .map((value) => {
      const amount = value / 10000;
      return Number.isInteger(amount) ? String(amount) : amount.toFixed(1).replace(/\.0$/, '');
    });

  if (values.length === 2) return `月${values[0]}〜${values[1]}万円`;
  if (values.length === 1) return `月${values[0]}万円〜`;
  return '';
}

function inferRemote(text) {
  const normalized = stripHtml(text);
  if (!normalized) return null;
  if (/(?:リモート不可|出社のみ|常駐|フル出社)/.test(normalized)) return false;
  if (/(?:フルリモート|完全在宅|完全リモート|在宅|リモート可|リモートOK|一部リモート)/.test(normalized)) return true;
  return null;
}

function inferWorkload(text) {
  const normalized = stripHtml(text);
  if (!normalized) return '';

  const monthHours = normalized.match(/(?:想定稼働時間[：:\s]*)?月\s*([0-9.]+)\s*(?:時間|h)/i);
  if (monthHours) return `月${monthHours[1]}h`;

  const weekDays = normalized.match(/週\s*([0-9.]+)\s*日/);
  if (weekDays) return `週${weekDays[1]}日`;

  const weekHours = normalized.match(/週\s*([0-9.]+)\s*(?:H|h|時間)/);
  if (weekHours) return `月${Number(weekHours[1]) * 4}h`;

  return '';
}

function inferSalary(text) {
  const normalized = stripHtml(text);
  if (!normalized) return '';

  const monthly = normalized.match(/月額[：:\s]*([0-9,]+)\s*円?\s*[〜~～\-]\s*([0-9,]+)\s*円/);
  if (monthly) {
    return formatMonthlyYenRange(monthly[1], monthly[2]);
  }

  const hourly = normalized.match(/時給[：:\s]*([0-9,]+)(?:\s*[〜~～\-]\s*([0-9,]+))?\s*円/);
  if (hourly) {
    const low = Number(hourly[1].replaceAll(',', '')).toLocaleString();
    const high = hourly[2] ? Number(hourly[2].replaceAll(',', '')).toLocaleString() : '';
    return high ? `時給${low}〜${high}円` : `時給${low}円`;
  }

  const topHourly = normalized.match(/([0-9,]+)\s*円\s*[〜~～]/);
  if (topHourly) {
    return `時給${Number(topHourly[1].replaceAll(',', '')).toLocaleString()}円〜`;
  }

  return '';
}

function inferCompany(text) {
  const normalized = stripHtml(text);
  const explicit = normalized.match(/会社名\s+(.+?)\s+(?:住所|設立|従業員数|トップ|募集を探す)/);
  if (explicit) return explicit[1].trim();

  const corp = normalized.match(/(株式会社[^ ]+|[^ ]+株式会社|合同会社[^ ]+|[^ ]+合同会社)/);
  return corp?.[1] || '';
}

function inferCategory(text) {
  const normalized = stripHtml(text);
  const match = normalized.match(/募集中の職種\s+(.+?)\s+応募する/);
  return match?.[1]?.trim() || '';
}

function mapSearchResult(id, url, title) {
  return {
    id: String(id),
    title: title || '',
    company: '',
    url: `${BASE}${url}`,
    salary: '',
    workload: '',
    remote: inferRemote(title),
    category: '',
    description: title || '',
  };
}

async function fetchSearchResults(query, page) {
  const url = new URL(`${BASE}/portal/search`);
  url.searchParams.set('tags', `keyword-${query}`);
  url.searchParams.set('page', String(page));

  const html = await fetchHTML(url.toString());
  const matches = [...html.matchAll(/href="(\/portal\/[^"]*\/job\/(\d+))"[\s\S]{0,1200}?<h3[^>]*>([\s\S]{0,400}?)<\/h3>/g)];

  return matches.map((match) => ({
    url: match[1],
    id: match[2],
    title: stripHtml(match[3]),
  }));
}

async function fetchJobDetail(job) {
  try {
    const html = await fetchHTML(job.url);
    if (html.includes('お探しのページは見つかりませんでした')) return null;
    if (html.includes('募集を締め切') || html.includes('募集終了') || html.includes('この募集は終了')) return null;

    const text = trimDetailText(stripHtml(html));
    return {
      company: inferCompany(text),
      salary: inferSalary(text),
      workload: inferWorkload(text),
      remote: inferRemote(text),
      category: inferCategory(text),
      description: text,
    };
  } catch {
    return null;
  }
}

async function scout() {
  const queries = resolveQueries();
  const pages = resolvePages();
  const allJobs = new Map();

  for (const query of queries) {
    process.stderr.write(`  🔍 "${query}" 検索中...\n`);
    for (let page = 1; page <= pages; page++) {
      try {
        const results = await fetchSearchResults(query, page);
        for (const result of results) {
          if (!allJobs.has(result.id)) {
            allJobs.set(result.id, mapSearchResult(result.id, result.url, result.title));
          }
        }

        process.stderr.write(`    → page ${page}: ${results.length}件取得（累計 ${allJobs.size}件）\n`);
        if (results.length < 20) break;
      } catch (e) {
        process.stderr.write(`    ⚠️ "${query}" page ${page} エラー: ${e.message}\n`);
        break;
      }
    }
  }

  const jobs = [...allJobs.values()];
  process.stderr.write(`  🔎 ${jobs.length}件の詳細補完中...\n`);

  const tasks = jobs.map((job) => async () => {
    const detail = await fetchJobDetail(job);
    if (!detail) {
      job._closed = true;
      return;
    }

    job.company = detail.company || job.company;
    job.salary = detail.salary || job.salary;
    job.workload = detail.workload || job.workload;
    job.remote = detail.remote ?? job.remote;
    job.category = detail.category || job.category;
    job.description = detail.description || job.description;
  });
  await parallelLimit(tasks, 4);

  const verified = jobs.filter((job) => !job._closed);
  const HAS_CUSTOM_QUERIES = (getArgValue('--queries') || '').trim().length > 0;
  const filtered = filterJobs(verified, { skipKeywordFilter: HAS_CUSTOM_QUERIES });
  output(PLATFORM, filtered);
}

scout().catch((e) => outputError(PLATFORM, e));
