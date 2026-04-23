#!/usr/bin/env node
/**
 * 複業クラウド案件スカウト
 * 公開 API で案件検索し、詳細 API で補完する。
 *
 * 使い方:
 *   node fukugyo-cloud.mjs
 */

import { filterJobs, output, outputError, parallelLimit } from './common.mjs';
import { SEARCH_QUERIES } from './config.mjs';

const PLATFORM = 'fukugyo-cloud';
const API_BASE = 'https://fc-core-api.aw-anotherworks.com/v2';
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
    ? uniqueQueries([...DEFAULT_QUERIES, ...SEARCH_QUERIES, '生成AI', 'AIエージェント', 'PMO', '業務効率化'])
    : DEFAULT_QUERIES;
}

function resolvePages() {
  const pagesArg = Number(getArgValue('--pages') || '0');
  if (pagesArg > 0) return pagesArg;
  const depth = getArgValue('--search-depth') || 'default';
  return depth === 'deep' ? 3 : 1;
}

function firstDefined(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(String(value).replaceAll(',', '').trim());
  return Number.isFinite(num) ? num : null;
}

function formatRange(prefix, min, max, suffix) {
  if (min !== null && max !== null) return `${prefix}${min}〜${max}${suffix}`;
  if (min !== null) return `${prefix}${min}${suffix}〜`;
  if (max !== null) return `${prefix}〜${max}${suffix}`;
  return '';
}

function formatSalary(project, ci) {
  const wageLow = toNumberOrNull(firstDefined(ci, ['wageLow']));
  const wageHigh = toNumberOrNull(firstDefined(ci, ['wageHigh']));
  const contractType = toNumberOrNull(firstDefined(ci, ['contractType']));
  if (wageLow !== null || wageHigh !== null) {
    const prefix = contractType === 1 ? '時給' : '報酬';
    const wage = formatRange(prefix, wageLow, wageHigh, '円');
    if (wage) return wage;
  }

  const monthlyMin = toNumberOrNull(firstDefined(ci, [
    'minMonthlyPrice',
    'minimumMonthlyPrice',
    'monthlyMinPrice',
    'monthlyPriceMin',
  ]));
  const monthlyMax = toNumberOrNull(firstDefined(ci, [
    'maxMonthlyPrice',
    'maximumMonthlyPrice',
    'monthlyMaxPrice',
    'monthlyPriceMax',
  ]));
  const hourlyMin = toNumberOrNull(firstDefined(ci, [
    'minHourlyPrice',
    'minimumHourlyPrice',
    'hourlyMinPrice',
    'hourlyPriceMin',
  ]));
  const hourlyMax = toNumberOrNull(firstDefined(ci, [
    'maxHourlyPrice',
    'maximumHourlyPrice',
    'hourlyMaxPrice',
    'hourlyPriceMax',
  ]));

  const monthly = formatRange('月', monthlyMin, monthlyMax, '万円');
  if (monthly) return monthly;

  const hourly = formatRange('時給', hourlyMin, hourlyMax, '円');
  if (hourly) return hourly;

  const directText = firstDefined(ci, [
    'salary',
    'salaryText',
    'salaryDisplay',
    'reward',
    'rewardText',
    'priceText',
    'budgetText',
    'compensationText',
  ]) || firstDefined(project, [
    'salary',
    'salaryText',
    'reward',
    'rewardText',
    'budgetText',
    'compensationText',
  ]);

  if (typeof directText === 'string' && directText.trim()) {
    return directText.trim();
  }

  const details = [
    project.title,
    project.jobName,
    project.detailJobName,
    project.description,
    project.detail,
  ].filter(Boolean).join(' ');

  const monthlyMatch = details.match(/月\s*([0-9,]+)\s*[-〜~]\s*([0-9,]+)\s*万/);
  if (monthlyMatch) {
    return `月${monthlyMatch[1].replaceAll(',', '')}〜${monthlyMatch[2].replaceAll(',', '')}万円`;
  }

  const hourlyMatch = details.match(/時給\s*([0-9,]+)\s*[-〜~]\s*([0-9,]+)\s*円/);
  if (hourlyMatch) {
    return `時給${hourlyMatch[1].replaceAll(',', '')}〜${hourlyMatch[2].replaceAll(',', '')}円`;
  }

  return '';
}

async function fetchProjectDetail(id, headers) {
  const res = await fetch(`${API_BASE}/projects/detail?id=${encodeURIComponent(id)}`, {
    method: 'GET',
    headers,
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error('Token 期限切れ');
    throw new Error(`詳細API ${res.status}`);
  }
  const data = await res.json();
  return data?.data?.project || null;
}

function buildPublicHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

async function fetchProjects(keyword, page, headers) {
  const res = await fetch(`${API_BASE}/projects/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ keyword, page, limit: 30 }),
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error(`API ${res.status}`);
    throw new Error(`API ${res.status}`);
  }
  const data = await res.json();
  return data.data?.projects || data.projects || [];
}

function buildWorkload(ci) {
  const monthHours = ci.monthOfWorkingTimes || '';
  const weekDays = ci.weekOfWorkingDays || '';
  return monthHours ? `月${monthHours}h` : weekDays ? `週${weekDays}日` : '';
}

function buildDescription(project, fallback = '') {
  const genres = (project.projectGenres || []).map((g) => g.name).join(', ');
  const engineerSkills = (project.projectEngineerSkills || []).map((s) => s.name).join(', ');
  const requiredConditions = (project.projectRequiredConditions || []).map((c) => c.name).join(', ');
  const optionalConditions = (project.projectOptionalConditions || []).map((c) => c.name).join(', ');

  return [
    fallback,
    project.title,
    genres,
    project.jobName,
    project.detailJobName,
    engineerSkills,
    requiredConditions,
    optionalConditions,
    project.workDetailText,
    project.projectDetailText,
    project.projectContractInformation?.workingTimesDetailText,
    project.projectContractInformation?.deliverablesDetailText,
    project.projectContractInformation?.incentiveFeeDetailText,
  ].filter(Boolean).join(' ');
}

async function scout() {
  const queries = resolveQueries();
  const pages = resolvePages();
  const headers = buildPublicHeaders();

  const allJobs = new Map();

  for (const keyword of queries) {
    process.stderr.write(`  🔍 "${keyword}" 検索中...\n`);
    for (let page = 1; page <= pages; page++) {
      try {
        const projects = await fetchProjects(keyword, page, headers);

        for (const p of projects) {
          const id = String(p.id);
          if (allJobs.has(id)) continue;

          const ci = p.projectContractInformation || {};
          const ws = p.projectWorkStyle || {};
          const genres = (p.projectGenres || []).map(g => g.name).join(', ');
          const monthHours = ci.monthOfWorkingTimes || '';
          const weekDays = ci.weekOfWorkingDays || '';
          const workload = monthHours ? `月${monthHours}h` : weekDays ? `週${weekDays}日` : '';

          allJobs.set(id, {
            id,
            title: p.title || '',
            company: p.company?.name || '',
            url: `https://talent.aw-anotherworks.com/projects/${id}`,
            salary: formatSalary(p, ci),
            workload,
            remote: ws.canRemoteWork ?? null,
            category: genres,
            description: [p.title, genres, p.jobName, p.detailJobName].filter(Boolean).join(' '),
          });
        }
        process.stderr.write(`    → page ${page}: ${projects.length}件取得（累計 ${allJobs.size}件）\n`);
        if (projects.length < 30) break;
      } catch (e) {
        process.stderr.write(`    ⚠️ "${keyword}" page ${page} エラー: ${e.message}\n`);
      }
    }
  }

  const baseJobs = [...allJobs.values()];
  process.stderr.write(`  🔎 詳細APIで補完中... (${baseJobs.length}件)\n`);
  const tasks = baseJobs.map((job) => async () => {
    try {
      const project = await fetchProjectDetail(job.id, headers);
      if (!project) return;
      const ci = project.projectContractInformation || {};
      const ws = project.projectWorkStyle || {};
      const genres = (project.projectGenres || []).map((g) => g.name).join(', ');
      job.company = project.company?.name || job.company;
      job.salary = formatSalary(project, ci) || job.salary;
      job.workload = buildWorkload(ci) || job.workload;
      job.remote = ws.canRemoteWork ?? job.remote;
      job.category = genres || job.category;
      job.description = buildDescription(project, job.description);
    } catch (e) {
      process.stderr.write(`    ⚠️ detail ${job.id} エラー: ${e.message}\n`);
    }
  });
  await parallelLimit(tasks, 4);

  const HAS_CUSTOM_QUERIES = (getArgValue('--queries') || '').trim().length > 0;
  const filtered = filterJobs(baseJobs, { skipKeywordFilter: HAS_CUSTOM_QUERIES });
  output(PLATFORM, filtered);
}

scout().catch(e => outputError(PLATFORM, e));
