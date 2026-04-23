#!/usr/bin/env node
/**
 * YOUTRUST 案件スカウト
 * 公開 API (/api/public/recruitment_posts) を使って Cookie なしで取得。
 */

import { fetchJSON, filterJobs, parallelLimit, output, outputError } from './common.mjs';
import { SEARCH_QUERIES, WIDE_SEARCH_QUERIES } from './config.mjs';

const PLATFORM = 'youtrust';
const BASE = 'https://youtrust.jp';
const DEFAULT_QUERIES = ['AI', '生成AI', 'AIエージェント', 'GAS', '業務改善', 'DX', 'BizOps', 'カスタマーサクセス'];

const STRONG_POSITIVE_PATTERNS = [
  /AI|生成AI|ChatGPT|LLM|AIエージェント|チャットボット/,
  /GAS|Google Apps Script|API|Webhook|Zapier|Make|Dify/,
  /DX|業務改善|業務効率化|業務設計|運用設計|要件定義|自動化/,
  /BizOps|CS Ops|Sales Ops|Revenue Ops|導入支援|オンボーディング/,
  /SaaS|CRM|Salesforce|HubSpot/,
];

const WEAK_POSITIVE_PATTERNS = [
  /PMO|PM|プロジェクト推進|事業推進|事業開発/,
  /カスタマーサクセス|オペレーション構築|Ops|BPR/,
  /データ整理|データ分析|可視化|仕組み化/,
  /法人営業|BizDev|営業企画/,
];

const ROLE_FIT_PATTERNS = [
  /GAS|Google Apps Script|API|Webhook|Zapier|Make|Dify/,
  /DX|業務改善|業務効率化|業務設計|運用設計|要件定義|自動化/,
  /BizOps|CS Ops|Sales Ops|Revenue Ops|導入支援|オンボーディング/,
  /カスタマーサクセス|オペレーション構築|PMO|PM|プロジェクトマネジメント/,
  /事業推進|事業開発|BizDev|営業企画|BPR/,
];

const NEGATIVE_PATTERNS = [
  /人事|採用|採用人事|採用広報|リクルーター/,
  /マーケティング|広告運用|SNS運用|広報|PR/,
  /デザイナー|UI\/UX|動画編集|ライター|SEO/,
  /フロントエンド|バックエンド|ネイティブアプリ|SRE|QA/,
  /インターン|新卒|中途採用|正社員/,
];

const HARD_NEGATIVE_PATTERNS = [
  /一人目HR|人事責任者|採用戦略|組織づくり/,
  /マーケ責任者|広告運用担当|SNSアカウント運用/,
  /エンジニア採用|採用候補者|採用広報/,
  /デザイン制作|動画制作|記事作成/,
  /心理カウンセラー|臨床心理士|公認心理師|助産師|看護師|医師/,
  /モバイルアプリエンジニア|アプリエンジニア|フルスタックエンジニア/,
  /新規開拓営業|新規顧客獲得営業|営業メンバー募集中/,
];

function getArgValue(name) {
  const arg = process.argv.slice(2).find((value) => value.startsWith(`${name}=`));
  return arg ? arg.split('=')[1] : '';
}

const RELAXED_SEARCH = ['1', 'true', 'yes'].includes((getArgValue('--relaxed') || '').toLowerCase());
const HAS_CUSTOM_QUERIES = (getArgValue('--queries') || '').trim().length > 0;

function uniqueValues(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function resolveQueries() {
  const depth = getArgValue('--search-depth') || 'default';
  const rawExtra = getArgValue('--queries') || '';
  const extraQueries = rawExtra.split('||').map(q => q.trim()).filter(Boolean);
  if (extraQueries.length) {
    return uniqueValues(extraQueries).slice(0, depth === 'wide' ? 30 : depth === 'deep' ? 18 : 10);
  }
  const baseQueries = depth === 'wide'
    ? [...DEFAULT_QUERIES, ...SEARCH_QUERIES, ...WIDE_SEARCH_QUERIES]
    : depth === 'deep'
      ? [...DEFAULT_QUERIES, ...SEARCH_QUERIES]
      : DEFAULT_QUERIES;
  return uniqueValues(baseQueries).slice(0, depth === 'wide' ? 30 : depth === 'deep' ? 18 : 10);
}

function resolveIdsPerQuery() {
  const explicit = Number(getArgValue('--ids-per-query') || '');
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(Math.trunc(explicit), 120);

  const depth = getArgValue('--search-depth') || 'default';
  if (depth === 'wide') return 60;
  if (depth === 'deep') return 40;
  return 24;
}

function buildHeaders() {
  return {
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  };
}

function cleanText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pickUpperNumber(a, b) {
  return Math.max(Number(a || 0), Number(b || 0));
}

function inferRemote(text) {
  const normalized = cleanText(text);
  if (!normalized) return null;
  if (/(出社必須|原則出社|フル出社|出社中心|常駐|オンサイト|オフィス勤務)/i.test(normalized)) return false;
  if (/(フルリモート|完全リモート|原則リモート|基本リモート|在宅勤務|リモート可|全国どこでも)/i.test(normalized)) return true;
  return null;
}

function inferWorkload(text) {
  const normalized = cleanText(text);
  if (!normalized) return '';

  const monthHours = normalized.match(/月\s*([0-9.]+)(?:\s*[〜~\-]\s*([0-9.]+))?\s*(?:時間|h)/i);
  if (monthHours) return `月${pickUpperNumber(monthHours[1], monthHours[2])}h`;

  const weekDays = normalized.match(/週\s*([0-9.]+)(?:\s*[〜~\-]\s*([0-9.]+))?\s*(?:日|回)/i);
  if (weekDays) return `週${pickUpperNumber(weekDays[1], weekDays[2])}日`;

  const weekHours = normalized.match(/週\s*([0-9.]+)(?:\s*[〜~\-]\s*([0-9.]+))?\s*(?:時間|h)/i);
  if (weekHours) {
    return `月${Math.ceil(pickUpperNumber(weekHours[1], weekHours[2]) * 4)}h`;
  }

  const dayHours = normalized.match(/1日\s*([0-9.]+)(?:\s*[〜~\-]\s*([0-9.]+))?\s*時間/i);
  if (dayHours) return `1日${pickUpperNumber(dayHours[1], dayHours[2])}h`;

  return '';
}

function inferSalary(text) {
  const normalized = cleanText(text);
  if (!normalized) return '';

  const hourly = normalized.match(/時給\s*([0-9,]+)(?:\s*[〜~\-]\s*([0-9,]+))?\s*円/i);
  if (hourly) {
    const low = Number(hourly[1].replaceAll(',', ''));
    const high = hourly[2] ? Number(hourly[2].replaceAll(',', '')) : null;
    return high ? `時給${low.toLocaleString()}〜${high.toLocaleString()}円` : `時給${low.toLocaleString()}円`;
  }

  const monthly = normalized.match(/(?:月額|月給|報酬|給与|想定報酬)[^0-9]{0,12}([0-9.]+)\s*万円(?:\s*[〜~\-]\s*([0-9.]+)\s*万円)?/i);
  if (monthly) {
    return monthly[2] ? `月${monthly[1]}〜${monthly[2]}万円` : `月${monthly[1]}万円`;
  }

  const fixed = normalized.match(/(?:報酬|予算|金額)[^0-9]{0,12}([0-9,]+)\s*円(?:\s*[〜~\-]\s*([0-9,]+)\s*円)?/i);
  if (fixed) {
    const low = Number(fixed[1].replaceAll(',', ''));
    const high = fixed[2] ? Number(fixed[2].replaceAll(',', '')) : null;
    return high ? `${low.toLocaleString()}〜${high.toLocaleString()}円` : `${low.toLocaleString()}円`;
  }

  return '';
}

function buildSearchUrl(query) {
  const url = new URL('/api/public/recruitment_posts', BASE);
  url.searchParams.set('search_words', query);
  url.searchParams.set('employment_contract_types', 'employment_contract_type_side_job');
  if (!RELAXED_SEARCH) {
    url.searchParams.set('recruitment_type', 'recruitment_type_members_wanted');
  }
  return url.toString();
}

async function fetchSearchIds(query, headers) {
  const data = await fetchJSON(buildSearchUrl(query), { headers });
  return Array.isArray(data.all_recruitment_post_ids) ? data.all_recruitment_post_ids.map(String) : [];
}

async function fetchRecruitmentPosts(ids, headers) {
  if (ids.length === 0) return [];
  const url = new URL(`/api/public/recruitment_posts/${ids.join(',')}`, BASE);
  const data = await fetchJSON(url.toString(), { headers });
  return Array.isArray(data.recruitment_posts) ? data.recruitment_posts : [];
}

function buildJob(post) {
  const tags = Array.isArray(post.tags) ? post.tags.map((tag) => tag?.name).filter(Boolean) : [];
  const description = cleanText(post.content || '');
  const category = [post.v3_job_category?.name, ...tags].filter(Boolean).join(' / ');

  return {
    id: String(post.id),
    title: cleanText(post.title || ''),
    company: cleanText(post.company?.name || ''),
    url: `${BASE}/recruitment_posts/${post.id}`,
    salary: inferSalary(`${post.title || ''}\n${description}`),
    workload: inferWorkload(description),
    remote: inferRemote(description),
    category,
    description,
    _employmentType: post.employment_contract_type || '',
    _recruitmentType: post.recruitment_type || '',
  };
}

function isRelevantJob(job) {
  const text = [job.title, job.company, job.category, job.description].filter(Boolean).join(' ');
  if (job._employmentType !== 'employment_contract_type_side_job') return false;

  if (HAS_CUSTOM_QUERIES) return true;

  if (HARD_NEGATIVE_PATTERNS.some((pattern) => pattern.test(text))) return false;

  const strongMatches = STRONG_POSITIVE_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const weakMatches = WEAK_POSITIVE_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const hasPositive = strongMatches > 0 || weakMatches > 0;
  const hasNegative = NEGATIVE_PATTERNS.some((pattern) => pattern.test(text));
  const hasRoleFit = ROLE_FIT_PATTERNS.some((pattern) => pattern.test(text));

  if (hasNegative && !hasPositive) return false;
  if (!RELAXED_SEARCH && !hasRoleFit) return false;
  if (!RELAXED_SEARCH && strongMatches === 0) return false;
  if (RELAXED_SEARCH && !hasPositive) return false;
  return true;
}

async function scout() {
  const headers = buildHeaders();
  const queries = resolveQueries();
  const idsPerQuery = resolveIdsPerQuery();
  const seenIds = new Set();
  const collectedIds = [];

  for (const query of queries) {
    try {
      const ids = await fetchSearchIds(query, headers);
      let added = 0;
      for (const id of ids) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        collectedIds.push(id);
        added += 1;
        if (added >= idsPerQuery) break;
      }
      process.stderr.write(`  🔍 "${query}" 検索中... ${ids.length}件ヒット（新規 ${added}件 / 累計 ${collectedIds.length}件）\n`);
    } catch (e) {
      process.stderr.write(`  ⚠️ "${query}" エラー: ${e.message}\n`);
    }
  }

  const chunkSize = 20;
  const chunks = [];
  for (let i = 0; i < collectedIds.length; i += chunkSize) {
    chunks.push(collectedIds.slice(i, i + chunkSize));
  }

  const posts = (await parallelLimit(
    chunks.map((chunk) => async () => fetchRecruitmentPosts(chunk, headers)),
    3
  )).flat();

  const jobs = posts.map(buildJob).filter(isRelevantJob);
  const filtered = filterJobs(jobs, { skipKeywordFilter: HAS_CUSTOM_QUERIES });
  output(PLATFORM, filtered);
}

scout().catch((e) => outputError(PLATFORM, e));
