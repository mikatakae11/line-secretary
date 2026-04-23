#!/usr/bin/env node
/**
 * SOKUDAN 案件スカウト
 * 公開 API (/api/v2/top/projects) で案件検索 → 詳細ページで補完 → フィルタ
 *
 * 使い方:
 *   node sokudan.mjs
 *
 * 認証: 不要（公開情報で取得）
 */

import { fetchHTML, filterJobs, parallelLimit, output, outputError } from './common.mjs';
import { SEARCH_QUERIES } from './config.mjs';

const PLATFORM = 'sokudan';
const BASE = 'https://sokudan.work';
const API_BASE = `${BASE}/api/v2/top/projects`;
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

function buildApiHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': `${BASE}/top/projects`,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

function parseTotalPages(pageUrlList = []) {
  const pageNumbers = pageUrlList
    .map((entry) => Number(entry?.name))
    .filter((value) => Number.isFinite(value) && value > 0);
  return pageNumbers.length ? Math.max(...pageNumbers) : null;
}

function joinLabels(values = []) {
  return values
    .map((value) => value?.label || value?.name || '')
    .filter(Boolean)
    .join(', ');
}

function normalizeCompanyName(name) {
  const normalized = String(name || '').trim();
  if (!normalized) return '';
  if (/^[＊*]+$/.test(normalized)) return '非公開';
  return normalized;
}

function formatBudgetRange(minLabel, maxLabel) {
  const min = String(minLabel || '').replace(/\s+/g, '').replace(/万円/g, '万');
  const max = String(maxLabel || '').replace(/\s+/g, '').replace(/万円/g, '万');
  if (!min && !max) return '';

  if ((min || max).includes('万')) {
    const low = min.replace(/万$/, '');
    const high = max.replace(/万$/, '');
    if (low && high) return `月${low}〜${high}万円`;
    if (low) return `月${low}万円〜`;
    return `月〜${high}万円`;
  }

  if ((min || max).includes('円')) {
    if (min && max) return `報酬${min}〜${max}`;
    if (min) return `報酬${min}〜`;
    return `報酬〜${max}`;
  }

  return [min, max].filter(Boolean).join('〜');
}

function formatSalary(project) {
  const budget = formatBudgetRange(project.minBudget?.label, project.maxBudget?.label);
  if (budget) return budget;

  if (project.minMonthlyPrice && project.maxMonthlyPrice) {
    return `月${project.minMonthlyPrice}〜${project.maxMonthlyPrice}万円`;
  }
  if (project.minHourlyPrice && project.maxHourlyPrice) {
    return `時給${project.minHourlyPrice}〜${project.maxHourlyPrice}円`;
  }
  return project.salary || '';
}

function formatWorkload(project) {
  const availableTime = String(project.projectAvailableTime?.label || '').trim();
  if (availableTime) {
    const weekDays = availableTime.match(/週\s*([0-9.]+)\s*日/);
    if (weekDays) return availableTime;
  }

  const weeklyHours = String(project.minWorkingHoursLabel || '').trim();
  const weekHoursMatch = weeklyHours.match(/週\s*([0-9.]+)\s*h/i);
  if (weekHoursMatch) {
    return `月${Number(weekHoursMatch[1]) * 4}h`;
  }

  return availableTime || weeklyHours || project.workDay || '';
}

function inferRemote(project) {
  const label = String(project.remoteType?.label || '').trim();
  if (/リモート不可|出社のみ|常駐/.test(label)) return false;
  if (/リモート/.test(label)) return true;
  if (label) return false;
  if (project.isRemote === true || project.isRemotable === true) return true;
  if (project.isRemote === false || project.isRemotable === false) return false;
  return null;
}

function buildCategory(project) {
  return [joinLabels(project.professions), joinLabels(project.tags)]
    .filter(Boolean)
    .join(', ');
}

function buildDescription(project, fallback = '') {
  return [
    fallback,
    project.detail,
    joinLabels(project.requiredSkills),
    joinLabels(project.professions),
    joinLabels(project.tags),
    project.corporation?.detail,
  ]
    .filter(Boolean)
    .join(' ');
}

function mapProjectToJob(project) {
  return {
    id: String(project.id),
    title: project.title || '',
    company: normalizeCompanyName(project.corporation?.name || project.company?.name || project.companyName || ''),
    url: `${BASE}/top/projects/${project.id}`,
    salary: formatSalary(project),
    workload: formatWorkload(project),
    remote: inferRemote(project),
    category: buildCategory(project),
    description: buildDescription(project, project.title || ''),
    _closed: project.state === 'closed' || project.status === 'closed' || project.isClosed === true,
  };
}

async function fetchProjectDetail(id) {
  try {
    const res = await fetch(`${BASE}/top/projects/${id}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      redirect: 'follow',
    });
    if (res.status === 404) return false;
    if (!res.ok) return null;
    const html = await res.text();
    if (html.includes('お探しのページが見つかりません')) return null;
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/);
    if (m) {
      try {
        const data = JSON.parse(m[1]);
        const project = data.props?.pageProps?.staticProject;
        const state = project?.state;
        if (!project) return null;
        if (state && state !== 'opened') return null;
        return project;
      } catch {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchProjects(query, page) {
  const url = new URL(API_BASE);
  url.searchParams.set('page', String(page));
  url.searchParams.set('search_project[exclude_closed_projects]', '1');
  if (query) url.searchParams.set('search_project[free_word]', query);

  const res = await fetch(url, { headers: buildApiHeaders() });
  if (!res.ok) {
    throw new Error(`API ${res.status}`);
  }

  const data = await res.json();
  return {
    projects: data.projectList || [],
    totalPages: parseTotalPages(data.pageUrlList),
  };
}

async function scout() {
  const queries = resolveQueries();
  const pages = resolvePages();
  const jobsById = new Map();

  for (const query of queries) {
    process.stderr.write(`  🔍 "${query}" 検索中...\n`);
    let totalPages = pages;
    let lastPageFirstId = null;

    for (let page = 1; page <= totalPages; page++) {
      try {
        const result = await fetchProjects(query, page);
        const projects = result.projects || [];
        const firstId = projects[0]?.id ?? null;

        for (const project of projects) {
          const job = mapProjectToJob(project);
          if (!jobsById.has(job.id)) jobsById.set(job.id, job);
        }

        process.stderr.write(`    → page ${page}: ${projects.length}件取得（累計 ${jobsById.size}件）\n`);

        if (result.totalPages) {
          totalPages = Math.min(totalPages, result.totalPages);
        }

        if (!projects.length) break;
        if (projects.length < 40) break;
        if (firstId && firstId === lastPageFirstId) break;
        lastPageFirstId = firstId;
      } catch (e) {
        process.stderr.write(`    ⚠️ "${query}" page ${page} エラー: ${e.message}\n`);
        break;
      }
    }
  }

  const jobs = [...jobsById.values()];
  process.stderr.write(`  📦 候補 ${jobs.length}件取得\n`);

  // キーワードマッチする案件だけ詳細取得して補完
  const HAS_CUSTOM_QUERIES = (getArgValue('--queries') || '').trim().length > 0;
  const candidates = filterJobs(jobs.filter(j => !j._closed), { skipKeywordFilter: HAS_CUSTOM_QUERIES });
  process.stderr.write(`  🔎 ${candidates.length}件の詳細確認中...\n`);

  const tasks = candidates.map(job => async () => {
    const detail = await fetchProjectDetail(job.id);
    if (!detail) {
      job._closed = true;
      return;
    }

    const enriched = mapProjectToJob(detail);
    job.company = enriched.company || job.company;
    job.salary = enriched.salary || job.salary;
    job.workload = enriched.workload || job.workload;
    job.remote = enriched.remote ?? job.remote;
    job.category = enriched.category || job.category;
    job.description = buildDescription(detail, job.description);
  });
  await parallelLimit(tasks, 3);

  const verified = candidates.filter(j => !j._closed);
  const removedCount = candidates.length - verified.length;
  if (removedCount > 0) process.stderr.write(`    → ${removedCount}件が募集終了/404\n`);

  output(PLATFORM, verified);
}

scout().catch(e => outputError(PLATFORM, e));
