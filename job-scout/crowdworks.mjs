#!/usr/bin/env node
/**
 * CrowdWorks 案件スカウト
 * 公開一覧の埋め込み JSON を取得 → 詳細ページで補完 → フィルタ
 *
 * 使い方:
 *   node crowdworks.mjs
 *
 * 認証: 不要（公開情報で取得）
 */

import { fetchHTML, filterJobs, parallelLimit, output, outputError } from './common.mjs';
import { SEARCH_QUERIES, WIDE_SEARCH_QUERIES } from './config.mjs';

const PLATFORM = 'crowdworks';
const BASE = 'https://crowdworks.jp';
const GROUP_SOURCES = [
  { label: 'AI機械学習', path: '/public/jobs/group/ai_machine_learning' },
];
const DEFAULT_QUERIES = ['AI', '生成AI', 'ChatGPT', 'AI チャットボット', 'GAS', '業務改善', 'DX'];

const STRONG_POSITIVE_PATTERNS = [
  /AI|生成AI|ChatGPT|LLM|AIエージェント|チャットボット/,
  /GAS|Google Apps Script|API|Webhook|スクレイピング/,
  /DX|業務改善|業務効率化|業務設計|要件定義|運用設計|自動化/,
  /PMO|導入支援|SaaS|BizOps|CS Ops|Salesforce|HubSpot/,
];

const WEAK_POSITIVE_PATTERNS = [
  /コンサル|伴走|壁打ち/,
  /Excel|VBA|データ整理|集計|分析/,
  /オンボーディング|カスタマーサクセス|業務フロー/,
];

const NEGATIVE_PATTERNS = [
  /記事作成|ライター|SEO|リライト|校正/,
  /動画編集|動画制作|YouTube|ショート動画|TikTok/,
  /ロゴ|バナー|イラスト|デザイン制作|LP制作/,
  /データ入力|単純作業|コピペ|リスト作成|アンケート/,
  /テレアポ|架電|営業代行|アポ取得/,
  /出品代行|BUYMA|発送|梱包/,
  /オンライン秘書|秘書|事務アシスタント/,
  /Googleマップ|MEO|口コミ|レビュー/,
];

const HARD_NEGATIVE_PATTERNS = [
  /AI研修サポート.*オンライン秘書/,
  /在宅でスキルアップ.*ライター/,
  /コメント分類.*未経験OK/,
  /インタビュー募集|ディープフェイク技術について教えて/,
  /教材動画動画講義|動画講義|画面収録|スライド作成/,
  /UGC動画|BGM音源作成|画像生成スタッフ|漫画制作/,
  /Instagram投稿構成|AI副業系YouTubeチャンネル|ショート動画編集/,
  /LLMO|AIO対策|AI×SEO/,
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
    return uniqueValues(extraQueries).slice(0, depth === 'wide' ? 30 : 18);
  }
  const baseQueries = depth === 'wide'
    ? [...DEFAULT_QUERIES, ...SEARCH_QUERIES, ...WIDE_SEARCH_QUERIES]
    : depth === 'deep'
      ? [...DEFAULT_QUERIES, ...SEARCH_QUERIES]
      : DEFAULT_QUERIES;
  return uniqueValues(baseQueries).slice(0, depth === 'wide' ? 30 : 18);
}

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
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
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

function decodeContainerJson(html, id) {
  const pattern = new RegExp(`<div id="${id}"[^>]*data="([\\s\\S]*?)"[^>]*>`, 'i');
  const match = html.match(pattern);
  if (!match) return null;
  return JSON.parse(decodeHtmlEntities(match[1]));
}

function formatBudget(min, max) {
  const values = [min, max]
    .filter((value) => value !== null && value !== undefined)
    .map((value) => Number(value))
    .filter(Number.isFinite);
  if (values.length === 0) return '';
  if (values.length === 1) return `${values[0].toLocaleString()}円`;
  return `${values[0].toLocaleString()}〜${values[1].toLocaleString()}円`;
}

function formatHourly(min, max) {
  const values = [min, max]
    .filter((value) => value !== null && value !== undefined)
    .map((value) => Number(value))
    .filter(Number.isFinite);
  if (values.length === 0) return '';
  if (values.length === 1) return `時給${values[0].toLocaleString()}円`;
  return `時給${values[0].toLocaleString()}〜${values[1].toLocaleString()}円`;
}

function inferListSalary(payment) {
  if (payment?.fixed_price_payment) {
    return formatBudget(payment.fixed_price_payment.min_budget, payment.fixed_price_payment.max_budget);
  }
  if (payment?.hourly_payment) {
    return formatHourly(payment.hourly_payment.min_hourly_wage, payment.hourly_payment.max_hourly_wage);
  }
  return '';
}

function inferRemote(text) {
  const normalized = cleanText(text);
  if (!normalized) return null;
  if (/(出社|常駐|オンサイト|現地勤務|現場対応)/.test(normalized)) return false;
  if (/(フルリモート|完全在宅|在宅|リモート|フルフレックス)/.test(normalized)) return true;
  return null;
}

function inferWorkload(text) {
  const normalized = cleanText(text);
  if (!normalized) return '';

  const monthHours = normalized.match(/(?:月|毎月)([0-9.]+)\s*(?:時間|h)/i) || normalized.match(/([0-9.]+)\s*時間程度/);
  if (monthHours) return `月${monthHours[1]}h`;

  const weekDays = normalized.match(/週\s*([0-9.]+)\s*日/);
  if (weekDays) return `週${weekDays[1]}日`;

  const dayHours = normalized.match(/1日\s*([0-9.]+)\s*時間/);
  if (dayHours) return `1日${dayHours[1]}h`;

  const weekHours = normalized.match(/週\s*([0-9.]+)\s*時間/);
  if (weekHours) return `月${Number(weekHours[1]) * 4}h`;

  return '';
}

function extractSummaryValue(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<tr>[\\s\\S]*?<th>[\\s\\S]*?<div>${escaped}<\\/div>[\\s\\S]*?<\\/th>[\\s\\S]*?<td>([\\s\\S]*?)<\\/td>[\\s\\S]*?<\\/tr>`, 'i');
  const match = html.match(pattern);
  return match ? cleanText(match[1]) : '';
}

function extractDetailDescription(html) {
  const match = html.match(/<table class="job_offer_detail_table">[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/table>/i);
  return match ? stripHtml(match[1]) : '';
}

function extractClientName(html) {
  const info = decodeContainerJson(html, 'client_detail_information_container');
  return info?.userDisplayName || '';
}

function extractTitle(html) {
  const raw = cleanText(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '');
  return raw.replace(/のお仕事.*$/, '').trim();
}

function extractCategory(html) {
  const title = cleanText(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '');
  return title.match(/のお仕事\((.+?)\)/)?.[1]?.trim() || '';
}

function buildListUrl(source, page) {
  const url = new URL(source.path.startsWith('http') ? source.path : `${BASE}${source.path}`);
  if (source.type === 'keyword') {
    url.searchParams.set('keyword', source.query);
    url.searchParams.set('order', 'new');
  }
  url.searchParams.set('page', String(page));
  return url.toString();
}

function buildSources() {
  const queries = resolveQueries().map((query) => ({
    type: 'keyword',
    label: `検索:${query}`,
    path: '/public/jobs/search',
    query,
  }));
  return [...GROUP_SOURCES.map((source) => ({ type: 'group', ...source })), ...queries];
}

async function fetchSearchResults(source, page) {
  const html = await fetchHTML(buildListUrl(source, page));
  const data = decodeContainerJson(html, 'vue-container');
  const items = data?.searchResult?.job_offers || [];

  return items.map((item) => ({
    id: String(item.job_offer.id),
    title: cleanText(item.job_offer.title),
    company: cleanText(item.client?.username || ''),
    url: `${BASE}/public/jobs/${item.job_offer.id}`,
    salary: inferListSalary(item.payment),
    workload: inferWorkload(item.job_offer.description_digest || ''),
    remote: inferRemote(item.job_offer.description_digest || ''),
    category: '',
    description: cleanText(item.job_offer.description_digest || ''),
    _expiredOn: item.job_offer.expired_on || '',
  }));
}

function isRelevantJob(job) {
  const text = [job.title, job.category, job.description, job.company].filter(Boolean).join(' ');

  if (HAS_CUSTOM_QUERIES) {
    if (HARD_NEGATIVE_PATTERNS.some((pattern) => pattern.test(text))) return false;
    return true;
  }

  if (HARD_NEGATIVE_PATTERNS.some((pattern) => pattern.test(text))) return false;
  if (/映像編集・映像制作|動画作成・動画制作|記事・Webコンテンツ作成|その他SNS集客・運用|BGM制作/.test(job.category)) return false;

  const strongMatches = STRONG_POSITIVE_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const weakMatches = WEAK_POSITIVE_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const hasPositive = strongMatches > 0 || weakMatches > 0;
  const hasNegative = NEGATIVE_PATTERNS.some((pattern) => pattern.test(text));
  if (hasNegative && !hasPositive) return false;

  if (!RELAXED_SEARCH && strongMatches === 0) return false;
  if (RELAXED_SEARCH && !hasPositive) return false;

  const salaryMatch = String(job.salary || '').match(/([0-9,]+)(?:〜([0-9,]+))?円/);
  if (salaryMatch) {
    const low = Number(salaryMatch[1].replaceAll(',', ''));
    const high = salaryMatch[2] ? Number(salaryMatch[2].replaceAll(',', '')) : low;
    if (Math.max(low, high) <= 5000 && !hasPositive) return false;
  }

  return true;
}

async function fetchJobDetail(job) {
  try {
    const html = await fetchHTML(job.url);
    if (/404|お探しのページは見つかりません/.test(html)) return null;

    const description = extractDetailDescription(html);
    return {
      title: extractTitle(html),
      company: extractClientName(html) || job.company,
      salary: extractSummaryValue(html, '固定報酬制')
        || extractSummaryValue(html, '時間単価制')
        || job.salary,
      workload: inferWorkload(description) || job.workload,
      remote: inferRemote(description),
      category: extractCategory(html),
      description: description || job.description,
    };
  } catch {
    return null;
  }
}

async function scout() {
  const pages = resolvePages();
  const sources = buildSources();
  const allJobs = new Map();

  for (const source of sources) {
    process.stderr.write(`  🔍 ${source.label} を探索中...\n`);
    for (let page = 1; page <= pages; page++) {
      try {
        const results = await fetchSearchResults(source, page);
        let newCount = 0;
        for (const result of results) {
          if (!allJobs.has(result.id)) {
            allJobs.set(result.id, result);
            newCount += 1;
          }
        }
        process.stderr.write(`    → page ${page}: ${results.length}件取得（新規 ${newCount} / 累計 ${allJobs.size}件）\n`);
        if (results.length === 0) break;
      } catch (e) {
        process.stderr.write(`    ⚠️ ${source.label} page ${page} エラー: ${e.message}\n`);
        break;
      }
    }
  }

  const now = new Date();
  const jobs = [...allJobs.values()].filter((job) => {
    if (!job._expiredOn) return true;
    return new Date(job._expiredOn) >= now;
  });
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
