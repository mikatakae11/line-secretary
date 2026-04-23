#!/usr/bin/env node
/**
 * ランサーズ案件スカウト
 * 公開の仕事一覧ページを巡回 → 詳細ページで補完 → フィルタ
 *
 * 使い方:
 *   node lancers.mjs
 *
 * 認証: 不要（公開情報で取得）
 */

import { fetchHTML, filterJobs, parallelLimit, output, outputError } from './common.mjs';

const PLATFORM = 'lancers';
const BASE = 'https://www.lancers.jp';
const DEFAULT_LIST_SOURCES = [
  { label: '新着全体', path: '/work/search' },
  { label: 'コンサル', path: '/work/search/business/consultant' },
  { label: 'VBA', path: '/work/search/system/vba' },
];

const STRONG_POSITIVE_PATTERNS = [
  /AI|生成AI|AIエージェント|ChatGPT|LLM/,
  /GAS|Google Apps Script|API|Dify|ノーコード|ローコード/,
  /DX|業務改善|業務効率化|業務設計|要件定義|運用設計|BPR/,
  /VBA|Excel.*自動化|スクレイピング|自動化/,
  /SaaS導入|導入支援|PMO|BizOps|CS Ops|Salesforce|HubSpot/,
];

const WEAK_POSITIVE_PATTERNS = [
  /コンサル|伴走|壁打ち/,
  /Excel|データ整理|資料整理|業務整理/,
  /SaaS|KPI|オンボーディング/,
];

const NEGATIVE_PATTERNS = [
  /テレアポ|営業代行|架電|アポ取り|インサイドセールス/,
  /BUYMA|出品代行|梱包|発送|ポスティング/,
  /アンケート|モニター|口コミ|レビュー|感想/,
  /LP制作|バナー|ロゴ|デザイン|イラスト|動画編集|動画制作/,
  /SEO|記事作成|ライティング|文字起こし|SNS運用/,
  /オンラインアシスタント|秘書|事務代行|データ入力/,
];

const HARD_NEGATIVE_PATTERNS = [
  /Canva|スライド資料作成|HTMLコーディング|HTMLコーティング/,
  /占い講師|電話占い|チャット占い|占い/,
  /SNSマーケター|SNSマーケティング|インフルエンサー/,
];

function getArgValue(name) {
  const arg = process.argv.slice(2).find((value) => value.startsWith(`${name}=`));
  return arg ? arg.split('=')[1] : '';
}

const RELAXED_SEARCH = ['1', 'true', 'yes'].includes((getArgValue('--relaxed') || '').toLowerCase());
const HAS_CUSTOM_QUERIES = (getArgValue('--queries') || '').trim().length > 0;
const LIST_SOURCES = HAS_CUSTOM_QUERIES
  ? [{ label: '新着全体', path: '/work/search' }]
  : DEFAULT_LIST_SOURCES;

function resolvePages() {
  const explicit = Number(getArgValue('--pages') || '');
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(Math.trunc(explicit), 8);

  const depth = getArgValue('--search-depth') || 'default';
  if (depth === 'wide') return 5;
  if (depth === 'deep') return 3;
  return 2;
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripHtml(html) {
  return decodeHtmlEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanText(text) {
  return stripHtml(text).replace(/\s+/g, ' ').trim();
}

function extractMeta(html, attr, name) {
  const pattern = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]+content=["']([\\s\\S]*?)["']`, 'i');
  return decodeHtmlEntities(html.match(pattern)?.[1] || '').trim();
}

function extractDefinitionMap(html) {
  const defs = new Map();
  const matches = [...html.matchAll(/<dl class="c-definition-list"[\s\S]*?<dt[^>]*>([\s\S]*?)<\/dt>[\s\S]*?<dd[^>]*>([\s\S]*?)<\/dd>[\s\S]*?<\/dl>/g)];
  for (const match of matches) {
    const key = cleanText(match[1]);
    const value = stripHtml(match[2]);
    if (key && value) defs.set(key, value);
  }
  return defs;
}

function buildListUrl(sourcePath, page) {
  const url = new URL(`${BASE}${sourcePath}`);
  url.searchParams.set('open', '1');
  url.searchParams.set('show_description', '1');
  url.searchParams.set('sort', 'started');
  url.searchParams.set('type[]', 'project');
  url.searchParams.set('type[]', 'job');
  url.searchParams.set('page', String(page));
  return url.toString();
}

function mapSearchResult(id, title) {
  return {
    id: String(id),
    title: title || '',
    company: '',
    url: `${BASE}/work/detail/${id}`,
    salary: '',
    workload: '',
    remote: null,
    category: '',
    description: title || '',
  };
}

async function fetchSearchResults(source, page) {
  const html = await fetchHTML(buildListUrl(source.path, page));
  const matches = [...html.matchAll(/href="\/work\/detail\/(\d+)"[^>]*>\s*([\s\S]{0,400}?)\s*<\/a>/g)];

  return matches.map((match) => ({
    id: match[1],
    title: cleanText(match[2]),
  }));
}

function extractTitle(html) {
  const og = extractMeta(html, 'property', 'og:title');
  if (og) return og;
  return cleanText(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '');
}

function extractDescription(html, defs) {
  const detail = defs.get('依頼概要');
  if (detail) return detail;
  const og = extractMeta(html, 'property', 'og:description');
  if (og) return og;
  return '';
}

function extractServiceCategory(html) {
  const pageTitle = cleanText(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '');
  return pageTitle.match(/\|\s*(.+?)の求人・案件なら/)?.[1]?.trim() || '';
}

function extractBudget(text) {
  const normalized = cleanText(text);
  if (!normalized) return '';

  const range = normalized.match(/([0-9,]+)\s*円\s*[~〜～\-]\s*([0-9,]+)\s*円/);
  if (range) {
    return `${Number(range[1].replaceAll(',', '')).toLocaleString()}〜${Number(range[2].replaceAll(',', '')).toLocaleString()}円`;
  }

  const single = normalized.match(/([0-9,]+)\s*円/);
  if (single) {
    return `${Number(single[1].replaceAll(',', '')).toLocaleString()}円`;
  }

  return normalized;
}

function inferSalary(defs, description) {
  const budget = defs.get('提示した予算');
  if (budget) return extractBudget(budget);

  const rewardRule = description.match(/報酬規定[:：]?\s*([\s\S]{0,120}?円[\s\S]{0,40})/);
  if (rewardRule) return extractBudget(rewardRule[1]);

  return '';
}

function inferWorkload(defs, description) {
  const value = cleanText(defs.get('稼働時間の目安') || '');
  if (value) {
    const monthHours = value.match(/月\s*([0-9.]+)\s*(?:時間|h)/i);
    if (monthHours) return `月${monthHours[1]}h`;

    const weekDays = value.match(/週\s*([0-9.]+)\s*日/);
    if (weekDays) return `週${weekDays[1]}日`;

    if (/^[0-9.]+$/.test(value)) return `${value}h目安`;
    return value;
  }

  const inDescription = description.match(/(?:月\s*([0-9.]+)\s*(?:時間|h)|週\s*([0-9.]+)\s*日)/i);
  if (inDescription?.[1]) return `月${inDescription[1]}h`;
  if (inDescription?.[2]) return `週${inDescription[2]}日`;

  return cleanText(defs.get('依頼期間') || '');
}

function inferRemote(text) {
  const normalized = cleanText(text);
  if (!normalized) return null;
  if (/(出社必須|常駐|現地対応|対面必須|出勤可能な方)/.test(normalized)) return false;
  if (/(フルリモート|完全在宅|在宅|リモート|オンライン完結)/.test(normalized)) return true;
  return null;
}

function inferCategory(html, defs) {
  const serviceCategory = extractServiceCategory(html);
  const industry = cleanText(defs.get('依頼主の業種') || '');
  return [serviceCategory, industry].filter(Boolean).join(' / ');
}

function isRelevantJob(job) {
  const text = [job.title, job.category, job.description].filter(Boolean).join(' ');

  if (HAS_CUSTOM_QUERIES) {
    if (HARD_NEGATIVE_PATTERNS.some((pattern) => pattern.test(text))) return false;
    return true;
  }

  if (HARD_NEGATIVE_PATTERNS.some((pattern) => pattern.test(text))) return false;
  if (/レスポンシブサイト制作|Webサイト制作・デザイン|キャリア・人材コンサルティング/.test(job.category)) return false;

  const strongMatches = STRONG_POSITIVE_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const weakMatches = WEAK_POSITIVE_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const hasPositive = strongMatches > 0 || weakMatches > 0;
  const hasNegative = NEGATIVE_PATTERNS.some((pattern) => pattern.test(text));
  if (hasNegative && !hasPositive) return false;

  if (!RELAXED_SEARCH && strongMatches === 0) {
    return false;
  }

  if (RELAXED_SEARCH && !hasPositive) {
    return false;
  }

  const salaryMatch = String(job.salary || '').match(/([0-9,]+)(?:〜([0-9,]+))?円/);
  if (salaryMatch) {
    const low = Number(salaryMatch[1].replaceAll(',', ''));
    const high = salaryMatch[2] ? Number(salaryMatch[2].replaceAll(',', '')) : low;
    if (Math.max(low, high) <= 5000 && !hasPositive) return false;
  }

  if (/営業・テレアポ代行|秘書・オンラインアシスタント|モニター・アンケート・質問/.test(job.category) && !hasPositive) {
    return false;
  }

  return hasPositive;
}

async function fetchJobDetail(job) {
  try {
    const html = await fetchHTML(job.url);
    if (html.includes('お探しのページは見つかりませんでした')) return null;

    const defs = extractDefinitionMap(html);
    const title = extractTitle(html);
    const description = extractDescription(html, defs);
    return {
      title,
      company: '',
      salary: inferSalary(defs, description),
      workload: inferWorkload(defs, description),
      remote: inferRemote(`${title}\n${description}`),
      category: inferCategory(html, defs),
      description,
    };
  } catch {
    return null;
  }
}

async function scout() {
  const pages = resolvePages();
  const allJobs = new Map();

  for (const source of LIST_SOURCES) {
    process.stderr.write(`  🔍 ${source.label} を巡回中...\n`);
    for (let page = 1; page <= pages; page++) {
      try {
        const results = await fetchSearchResults(source, page);
        for (const result of results) {
          if (!allJobs.has(result.id)) {
            allJobs.set(result.id, mapSearchResult(result.id, result.title));
          }
        }
        process.stderr.write(`    → page ${page}: ${results.length}件取得（累計 ${allJobs.size}件）\n`);
        if (results.length === 0) break;
      } catch (e) {
        process.stderr.write(`    ⚠️ ${source.label} page ${page} エラー: ${e.message}\n`);
        break;
      }
    }
  }

  const jobs = [...allJobs.values()];
  process.stderr.write(`  🔎 詳細確認対象: ${jobs.length}件\n`);

  const tasks = jobs.map((job) => async () => {
    const detail = await fetchJobDetail(job);
    if (!detail) {
      job._closed = true;
      return;
    }

    job.title = detail.title || job.title;
    job.company = detail.company || job.company;
    job.salary = detail.salary || job.salary;
    job.workload = detail.workload || job.workload;
    job.remote = detail.remote ?? job.remote;
    job.category = detail.category || job.category;
    job.description = detail.description || job.description;
  });
  await parallelLimit(tasks, 4);

  const verified = jobs.filter((job) => !job._closed);
  const filtered = filterJobs(verified, { skipKeywordFilter: HAS_CUSTOM_QUERIES }).filter(isRelevantJob);
  output(PLATFORM, filtered);
}

scout().catch((e) => outputError(PLATFORM, e));
