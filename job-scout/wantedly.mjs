#!/usr/bin/env node
/**
 * Wantedly 案件スカウト
 * 公開 API (/api/v1/projects) を Cookie なしで利用。
 *
 * 使い方:
 *   node wantedly.mjs
 *
 * 注意: /api/v2/ は ID のみ返却。必ず /api/v1/projects を使う
 */

import { filterJobs, output, outputError } from './common.mjs';
import { SEARCH_QUERIES } from './config.mjs';

const PLATFORM = 'wantedly';
const BASE = 'https://www.wantedly.com';
const DEFAULT_QUERIES = ['AI 業務委託', '生成AI', 'DX コンサル', 'カスタマーサクセス 副業', 'GAS 自動化'];

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

function cleanText(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickUpperNumber(a, b) {
  return Math.max(Number(a || 0), Number(b || 0));
}

function inferRemote(text) {
  const normalized = cleanText(text);
  if (!normalized) return null;

  if (/(?:出社必須|原則出社|フル出社|常駐|客先常駐|オフィス出社|出社が可能)/i.test(normalized)) {
    return false;
  }

  if (/(?:フルリモート|完全リモート|全国どこでもOK|在宅勤務|リモート勤務|原則リモート|基本リモート|フル在宅)/i.test(normalized)) {
    return true;
  }

  return null;
}

function inferWorkload(text) {
  const normalized = cleanText(text);
  if (!normalized) return '';

  const monthHours = normalized.match(/月\s*([0-9.]+)(?:\s*[〜~\-]\s*([0-9.]+))?\s*h/i);
  if (monthHours) {
    return `月${pickUpperNumber(monthHours[1], monthHours[2])}h`;
  }

  const weekDays = normalized.match(/週\s*([0-9.]+)(?:\s*[〜~\-]\s*([0-9.]+))?\s*(?:日|回)/i);
  const dayHours = normalized.match(/1日\s*([0-9.]+)(?:\s*[〜~\-]\s*([0-9.]+))?\s*時間/i);
  if (weekDays && dayHours) {
    const days = pickUpperNumber(weekDays[1], weekDays[2]);
    const hours = pickUpperNumber(dayHours[1], dayHours[2]);
    return `月${Math.ceil(days * hours * 4)}h`;
  }

  if (weekDays) {
    return `週${pickUpperNumber(weekDays[1], weekDays[2])}日`;
  }

  return '';
}

function inferSalary(text) {
  const normalized = cleanText(text);
  if (!normalized) return '';

  const hourly = normalized.match(/時給\s*([0-9,]+)(?:\s*[〜~\-]\s*([0-9,]+))?\s*円/i);
  if (hourly) {
    const low = hourly[1].replaceAll(',', '');
    const high = hourly[2]?.replaceAll(',', '');
    return high ? `時給${Number(low).toLocaleString()}〜${Number(high).toLocaleString()}円` : `時給${Number(low).toLocaleString()}円`;
  }

  const monthly = normalized.match(/(?:月額|月給|報酬|給与|想定報酬)[^0-9]{0,12}([0-9.]+)\s*万円(?:\s*[〜~\-]\s*([0-9.]+)\s*万円)?/i);
  if (monthly) {
    return monthly[2] ? `月${monthly[1]}〜${monthly[2]}万円` : `月${monthly[1]}万円`;
  }

  return '';
}

function buildPublicHeaders() {
  return {
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  };
}

async function fetchProjects(query, page, headers) {
  const url = `${BASE}/api/v1/projects?q=${encodeURIComponent(query)}&page=${page}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`API ${res.status}`);
  }
  const data = await res.json();
  return data.data || data.projects || [];
}

async function scout() {
  const queries = resolveQueries();
  const pages = resolvePages();
  const headers = buildPublicHeaders();

  const allJobs = new Map();

  for (const query of queries) {
    process.stderr.write(`  🔍 "${query}" 検索中...\n`);
    for (let page = 1; page <= pages; page++) {
      try {
        const projects = await fetchProjects(query, page, headers);

        for (const p of projects) {
          const id = String(p.id);
          if (allJobs.has(id)) continue;

          const description = [p.title, p.description, p.what, p.why].filter(Boolean).join(' ');
          const hiring = [p.hiring_type, p.looking_for].filter(Boolean).join(' ');
          const isSideJob = hiring === 'side_job' || /副業|業務委託|フリーランス/i.test(hiring + description);

          allJobs.set(id, {
            id,
            title: p.title || '',
            company: p.company?.name || '',
            url: `${BASE}/projects/${id}`,
            salary: p.salary_display || inferSalary(description),
            workload: p.workload || inferWorkload(description),
            remote: p.is_remote ?? inferRemote(description),
            category: [p.what, p.looking_for].filter(Boolean).join(' / '),
            description,
            _sideJob: isSideJob,
          });
        }

        process.stderr.write(`    → page ${page}: ${projects.length}件取得（累計 ${allJobs.size}件）\n`);
        if (projects.length < 10) break;
      } catch (e) {
        process.stderr.write(`    ⚠️ "${query}" page ${page} エラー: ${e.message}\n`);
      }
    }
  }

  const HAS_CUSTOM_QUERIES = (getArgValue('--queries') || '').trim().length > 0;
  const filtered = filterJobs([...allJobs.values()], { skipKeywordFilter: HAS_CUSTOM_QUERIES });
  output(PLATFORM, filtered);
}

scout().catch(e => outputError(PLATFORM, e));
