#!/usr/bin/env node
/**
 * ココナラ案件スカウト
 * 公開 gRPC-Web で一覧取得 → 詳細ページを解析 → フィルタ
 *
 * 使い方:
 *   node coconala.mjs
 *
 * 認証: 不要（公開情報で取得）
 */

import { fetchHTML, filterJobs, parallelLimit, output, outputError } from './common.mjs';
import { SEARCH_QUERIES, WIDE_SEARCH_QUERIES } from './config.mjs';

const PLATFORM = 'coconala';
const BASE = 'https://coconala.com';
const API_BASE = 'https://apiprxy.coconala.com';
const SEARCH_ENDPOINT = `${API_BASE}/request.RequestService/SearchRequests`;
const DEFAULT_QUERIES = ['AI', '生成AI', 'GAS', '業務改善', 'DX コンサル', 'チャットボット', 'カスタマーサクセス'];
const SEARCH_PAGE_LIMIT = 40;
const SEARCH_DELAY_MS = 300;
const DETAIL_DELAY_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error) {
  const message = error?.message || String(error);
  return /HTTP 403|HTTP 429/.test(message);
}

async function fetchHTMLWithRetry(url, opts = {}, config = {}) {
  const attempts = config.attempts ?? 3;
  const baseDelayMs = config.baseDelayMs ?? 2000;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetchHTML(url, opts);
    } catch (error) {
      if (!isRateLimitError(error) || attempt === attempts) throw error;
      const waitMs = baseDelayMs * (2 ** (attempt - 1));
      process.stderr.write(`    ⏳ ココナラ待機 ${Math.round(waitMs / 1000)}秒: ${error.message}\n`);
      await sleep(waitMs);
    }
  }
}

function encodeVarint(value) {
  let current = Number(value) >>> 0;
  const bytes = [];
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

function encodeKey(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeInt32(fieldNumber, value) {
  return Buffer.concat([encodeKey(fieldNumber, 0), encodeVarint(value)]);
}

function encodeBool(fieldNumber, value) {
  return Buffer.concat([encodeKey(fieldNumber, 0), encodeVarint(value ? 1 : 0)]);
}

function encodeString(fieldNumber, value) {
  const buffer = Buffer.from(String(value), 'utf8');
  return Buffer.concat([encodeKey(fieldNumber, 2), encodeVarint(buffer.length), buffer]);
}

function buildSearchRequestsMessage(options) {
  return Buffer.concat([
    encodeInt32(1, options.page),
    encodeInt32(2, options.limit),
    encodeString(3, options.keyword),
    encodeBool(7, options.recruiting),
    encodeString(9, 'default'),
    encodeBool(12, false),
  ]);
}

function frameGrpcWebMessage(messageBuffer) {
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0);
  header.writeUInt32BE(messageBuffer.length, 1);
  return Buffer.concat([header, messageBuffer]);
}

function decodeVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  let cursor = offset;

  while (cursor < buffer.length) {
    const byte = buffer[cursor++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset: cursor };
    shift += 7;
  }

  throw new Error('unterminated varint');
}

function decodeLengthDelimited(buffer, offset) {
  const length = decodeVarint(buffer, offset);
  const start = length.offset;
  const end = start + length.value;
  return { value: buffer.subarray(start, end), offset: end };
}

function skipField(buffer, offset, wireType) {
  if (wireType === 0) return decodeVarint(buffer, offset).offset;
  if (wireType === 2) return decodeLengthDelimited(buffer, offset).offset;
  throw new Error(`unsupported wire type: ${wireType}`);
}

function decodeRequestMessage(buffer) {
  const request = {};
  let offset = 0;

  while (offset < buffer.length) {
    const key = decodeVarint(buffer, offset);
    offset = key.offset;
    const fieldNumber = key.value >> 3;
    const wireType = key.value & 7;

    if (wireType === 0) {
      const value = decodeVarint(buffer, offset);
      offset = value.offset;

      if (fieldNumber === 1) request.requestId = value.value;
      else if (fieldNumber === 7) request.isRecruitmentFinished = Boolean(value.value);
      else if (fieldNumber === 8) request.minBudget = value.value;
      else if (fieldNumber === 9) request.maxBudget = value.value;
      else if (fieldNumber === 10) request.budgetConsultation = Boolean(value.value);
      else if (fieldNumber === 11) request.proposalCount = value.value;
      else if (fieldNumber === 20) request.parentMasterCategoryId = value.value;
      else if (fieldNumber === 21) request.childMasterCategoryId = value.value;
      continue;
    }

    if (wireType === 2) {
      const value = decodeLengthDelimited(buffer, offset);
      offset = value.offset;
      const text = value.value.toString('utf8');

      if (fieldNumber === 2) request.title = text;
      else if (fieldNumber === 3) request.requestContent = text;
      else if (fieldNumber === 13) request.userName = text;
      continue;
    }

    offset = skipField(buffer, offset, wireType);
  }

  return request;
}

function decodeSearchRequestsReply(buffer) {
  const reply = { total: 0, offset: 0, limit: 0, page: 0, requests: [] };
  let offset = 0;

  while (offset < buffer.length) {
    const key = decodeVarint(buffer, offset);
    offset = key.offset;
    const fieldNumber = key.value >> 3;
    const wireType = key.value & 7;

    if (wireType === 0) {
      const value = decodeVarint(buffer, offset);
      offset = value.offset;

      if (fieldNumber === 1) reply.total = value.value;
      else if (fieldNumber === 2) reply.offset = value.value;
      else if (fieldNumber === 3) reply.limit = value.value;
      else if (fieldNumber === 5) reply.page = value.value;
      continue;
    }

    if (wireType === 2 && fieldNumber === 4) {
      const nested = decodeLengthDelimited(buffer, offset);
      offset = nested.offset;
      reply.requests.push(decodeRequestMessage(nested.value));
      continue;
    }

    offset = skipField(buffer, offset, wireType);
  }

  return reply;
}

function parseGrpcWebResponse(buffer) {
  const parsed = { messages: [], trailers: {} };
  let offset = 0;

  while (offset + 5 <= buffer.length) {
    const flag = buffer.readUInt8(offset);
    const length = buffer.readUInt32BE(offset + 1);
    const start = offset + 5;
    const end = start + length;
    const payload = buffer.subarray(start, end);

    if (flag === 0) {
      parsed.messages.push(payload);
    } else if (flag === 128) {
      const trailers = payload.toString('utf8').trim().split('\r\n');
      for (const line of trailers) {
        const [key, ...rest] = line.split(':');
        if (!key) continue;
        parsed.trailers[key.trim().toLowerCase()] = rest.join(':').trim();
      }
    }

    offset = end;
  }

  return parsed;
}

async function fetchSearchRequests(keyword, page) {
  const message = buildSearchRequestsMessage({
    keyword,
    page,
    limit: SEARCH_PAGE_LIMIT,
    recruiting: true,
  });

  const response = await fetch(SEARCH_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/grpc-web+proto',
      'accept': 'application/grpc-web+proto',
      'origin': 'https://coconala.com',
      'referer': `${BASE}/requests?keyword=${encodeURIComponent(keyword)}`,
      'user-agent': 'Mozilla/5.0',
      'x-grpc-web': '1',
      'x-lang-code': 'ja',
      'x-user-agent': 'pc',
    },
    body: frameGrpcWebMessage(message),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${keyword} page ${page}`);
  }

  const payload = parseGrpcWebResponse(Buffer.from(await response.arrayBuffer()));
  const grpcStatus = payload.trailers['grpc-status'];
  if (grpcStatus && grpcStatus !== '0') {
    throw new Error(`gRPC ${grpcStatus}: ${payload.trailers['grpc-message'] || 'unknown error'}`);
  }

  const messageBuffer = payload.messages[0];
  if (!messageBuffer) {
    throw new Error('gRPC message not found');
  }

  return decodeSearchRequestsReply(messageBuffer);
}

function decodeRequestDetailItem(buffer) {
  const item = {
    displayStyle: '',
    name: '',
    title: '',
    contentJson: '',
  };
  let offset = 0;

  while (offset < buffer.length) {
    const key = decodeVarint(buffer, offset);
    offset = key.offset;
    const fieldNumber = key.value >> 3;
    const wireType = key.value & 7;

    if (wireType === 2) {
      const value = decodeLengthDelimited(buffer, offset);
      offset = value.offset;
      const text = value.value.toString('utf8');
      if (fieldNumber === 1) item.displayStyle = text;
      else if (fieldNumber === 2) item.name = text;
      else if (fieldNumber === 3) item.title = text;
      else if (fieldNumber === 4) item.contentJson = text;
      continue;
    }

    offset = skipField(buffer, offset, wireType);
  }

  return item;
}

function decodeRequestDetailMasterCategory(buffer) {
  const category = { id: 0, name: '', lowestPrice: 0, highestPrice: 0 };
  let offset = 0;

  while (offset < buffer.length) {
    const key = decodeVarint(buffer, offset);
    offset = key.offset;
    const fieldNumber = key.value >> 3;
    const wireType = key.value & 7;

    if (wireType === 0) {
      const value = decodeVarint(buffer, offset);
      offset = value.offset;
      if (fieldNumber === 1) category.id = value.value;
      else if (fieldNumber === 3) category.lowestPrice = value.value;
      else if (fieldNumber === 4) category.highestPrice = value.value;
      continue;
    }

    if (wireType === 2) {
      const value = decodeLengthDelimited(buffer, offset);
      offset = value.offset;
      if (fieldNumber === 2) category.name = value.value.toString('utf8');
      continue;
    }

    offset = skipField(buffer, offset, wireType);
  }

  return category;
}

function decodeRequestDetailApplicationStatus(buffer) {
  const status = { offerCount: 0, contractCount: 0, viewCount: 0 };
  let offset = 0;

  while (offset < buffer.length) {
    const key = decodeVarint(buffer, offset);
    offset = key.offset;
    const fieldNumber = key.value >> 3;
    const wireType = key.value & 7;
    const value = decodeVarint(buffer, offset);
    offset = value.offset;

    if (wireType !== 0) continue;
    if (fieldNumber === 1) status.offerCount = value.value;
    else if (fieldNumber === 2) status.contractCount = value.value;
    else if (fieldNumber === 3) status.viewCount = value.value;
  }

  return status;
}

function decodeRequestDetailOutline(buffer) {
  const outline = {
    priceMin: 0,
    priceMax: 0,
    isExpired: false,
    expireDate: 0,
    created: 0,
    deliveryDate: 0,
    withholdingFlag: false,
    applicationStatus: null,
  };
  let offset = 0;

  while (offset < buffer.length) {
    const key = decodeVarint(buffer, offset);
    offset = key.offset;
    const fieldNumber = key.value >> 3;
    const wireType = key.value & 7;

    if (wireType === 0) {
      const value = decodeVarint(buffer, offset);
      offset = value.offset;
      if (fieldNumber === 1) outline.priceMin = value.value;
      else if (fieldNumber === 2) outline.priceMax = value.value;
      else if (fieldNumber === 3) outline.isExpired = Boolean(value.value);
      else if (fieldNumber === 4) outline.expireDate = value.value;
      else if (fieldNumber === 5) outline.created = value.value;
      else if (fieldNumber === 6) outline.deliveryDate = value.value;
      else if (fieldNumber === 7) outline.withholdingFlag = Boolean(value.value);
      continue;
    }

    if (wireType === 2 && fieldNumber === 8) {
      const value = decodeLengthDelimited(buffer, offset);
      offset = value.offset;
      outline.applicationStatus = decodeRequestDetailApplicationStatus(value.value);
      continue;
    }

    offset = skipField(buffer, offset, wireType);
  }

  return outline;
}

function decodeGetRequestDetailReply(buffer) {
  const detail = {
    id: 0,
    title: '',
    currentDate: 0,
    outline: null,
    summariesList: [],
    detailsList: [],
    proposersListCount: 0,
    masterCategory: null,
    parentMasterCategory: null,
    isBookmarked: false,
    offerId: 0,
  };
  let offset = 0;

  while (offset < buffer.length) {
    const key = decodeVarint(buffer, offset);
    offset = key.offset;
    const fieldNumber = key.value >> 3;
    const wireType = key.value & 7;

    if (wireType === 0) {
      const value = decodeVarint(buffer, offset);
      offset = value.offset;
      if (fieldNumber === 1) detail.id = value.value;
      else if (fieldNumber === 3) detail.currentDate = value.value;
      else if (fieldNumber === 12) detail.isBookmarked = Boolean(value.value);
      else if (fieldNumber === 13) detail.offerId = value.value;
      continue;
    }

    if (wireType === 2) {
      const value = decodeLengthDelimited(buffer, offset);
      offset = value.offset;
      if (fieldNumber === 2) detail.title = value.value.toString('utf8');
      else if (fieldNumber === 6) detail.outline = decodeRequestDetailOutline(value.value);
      else if (fieldNumber === 7) detail.summariesList.push(decodeRequestDetailItem(value.value));
      else if (fieldNumber === 8) detail.detailsList.push(decodeRequestDetailItem(value.value));
      else if (fieldNumber === 9) detail.proposersListCount += 1;
      else if (fieldNumber === 10) detail.masterCategory = decodeRequestDetailMasterCategory(value.value);
      else if (fieldNumber === 11) detail.parentMasterCategory = decodeRequestDetailMasterCategory(value.value);
      continue;
    }

    offset = skipField(buffer, offset, wireType);
  }

  return detail;
}

async function fetchRequestDetailGrpc(id) {
  const message = Buffer.concat([encodeInt32(1, Number(id))]);
  const response = await fetch(`${API_BASE}/request.RequestDetailService/GetRequestDetail`, {
    method: 'POST',
    headers: {
      'content-type': 'application/grpc-web+proto',
      'accept': 'application/grpc-web+proto',
      'origin': 'https://coconala.com',
      'referer': `${BASE}/requests/${id}`,
      'user-agent': 'Mozilla/5.0',
      'x-grpc-web': '1',
      'x-lang-code': 'ja',
      'x-user-agent': 'pc',
      'x-full-path': `/requests/${id}`,
    },
    body: frameGrpcWebMessage(message),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: detail ${id}`);
  }

  const payload = parseGrpcWebResponse(Buffer.from(await response.arrayBuffer()));
  const grpcStatus = payload.trailers['grpc-status'];
  if (grpcStatus && grpcStatus !== '0') {
    throw new Error(`gRPC ${grpcStatus}: ${payload.trailers['grpc-message'] || 'detail error'}`);
  }

  const messageBuffer = payload.messages[0];
  if (!messageBuffer) {
    throw new Error(`detail message not found: ${id}`);
  }

  return decodeGetRequestDetailReply(messageBuffer);
}

function getArgValue(name) {
  const arg = process.argv.slice(2).find((a) => a.startsWith(`${name}=`));
  return arg ? arg.split('=')[1] : '';
}

const HAS_CUSTOM_QUERIES = (getArgValue('--queries') || '').trim().length > 0;

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
  return depth === 'wide'
    ? uniqueQueries([...DEFAULT_QUERIES, ...SEARCH_QUERIES, ...WIDE_SEARCH_QUERIES])
    : depth === 'deep'
      ? uniqueQueries([...DEFAULT_QUERIES, ...SEARCH_QUERIES])
      : DEFAULT_QUERIES;
}

function resolvePages() {
  const explicit = Number(getArgValue('--pages') || '');
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(Math.trunc(explicit), 8);

  const depth = getArgValue('--search-depth') || 'default';
  if (depth === 'wide') return 4;
  if (depth === 'deep') return 3;
  return 2;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimText(text) {
  const markers = [
    '応募者一覧',
    '募集内容についての質問',
    '募集者情報',
    'この募集内容に似ている仕事',
    'ホーム 仕事を探す',
  ];

  let trimmed = String(text || '');
  for (const marker of markers) {
    const idx = trimmed.indexOf(marker);
    if (idx >= 0) trimmed = trimmed.slice(0, idx).trim();
  }
  return trimmed;
}

function pickSection(text, startMarker, endMarkers = []) {
  const start = text.indexOf(startMarker);
  if (start < 0) return '';
  let section = text.slice(start + startMarker.length).trim();
  for (const marker of endMarkers) {
    const idx = section.indexOf(marker);
    if (idx >= 0) {
      section = section.slice(0, idx).trim();
      break;
    }
  }
  return section;
}

function extractTitle(text) {
  const title = text.match(/^(.+?)\s+\|\s+ココナラ/);
  return title?.[1]?.trim() || '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractBudget(text) {
  const explicit = text.match(/予算[^0-9]{0,10}([0-9,]+万?円(?:\s*[〜~～\-]\s*[0-9,]+万?円)?|見積り希望)/);
  if (explicit) return explicit[1].replace(/\s+/g, '');

  const hourly = text.match(/(?:時給|時間給)[^0-9]{0,10}([0-9,]+)(?:\s*[〜~～\-]\s*([0-9,]+))?\s*円/);
  if (hourly) {
    const low = Number(hourly[1].replaceAll(',', '')).toLocaleString();
    const high = hourly[2] ? Number(hourly[2].replaceAll(',', '')).toLocaleString() : '';
    return high ? `時給${low}〜${high}円` : `時給${low}円`;
  }

  const monthly = text.match(/月給[^0-9]{0,10}([0-9,]+)(?:\s*[〜~～\-]\s*([0-9,]+))?\s*円/);
  if (monthly) {
    const toMan = (value) => {
      const amount = Number(value.replaceAll(',', '')) / 10000;
      return Number.isInteger(amount) ? String(amount) : amount.toFixed(1).replace(/\.0$/, '');
    };
    const low = toMan(monthly[1]);
    const high = monthly[2] ? toMan(monthly[2]) : '';
    return high ? `月${low}〜${high}万円` : `月${low}万円`;
  }

  return '';
}

function formatBudgetRange(minBudget, maxBudget, budgetConsultation = false) {
  if (budgetConsultation) return '見積り希望';
  if (minBudget > 0 && maxBudget > 0) {
    if (minBudget === maxBudget) return `${minBudget.toLocaleString()}円`;
    return `${minBudget.toLocaleString()}〜${maxBudget.toLocaleString()}円`;
  }
  if (maxBudget > 0) return `${maxBudget.toLocaleString()}円`;
  if (minBudget > 0) return `${minBudget.toLocaleString()}円`;
  return '';
}

function parseContentJson(contentJson) {
  try {
    const parsed = JSON.parse(contentJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function contentJsonToText(contentJson) {
  const items = parseContentJson(contentJson);
  return items
    .flatMap((item) => {
      if (item?.text) return [item.text];
      if (item?.label) return [item.label];
      if (item?.unit || item?.text) return [String(item.text || ''), String(item.unit || '')].filter(Boolean);
      return [];
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildDetailDescription(detail) {
  const content = detail.detailsList.find((item) => item.name === 'content');
  const specialNote = detail.detailsList.find((item) => item.name === 'specialNote');
  const summaryText = detail.summariesList
    .map((item) => [item.title, contentJsonToText(item.contentJson)].filter(Boolean).join(': '))
    .filter(Boolean)
    .join(' ');
  const detailText = detail.detailsList
    .map((item) => {
      if (item.name === 'content') return contentJsonToText(item.contentJson);
      if (item.name === 'specialNote') return contentJsonToText(item.contentJson);
      return '';
    })
    .filter(Boolean)
    .join(' ');
  const notes = specialNote ? contentJsonToText(specialNote.contentJson) : '';

  return [summaryText, detailText, notes].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function buildDetailWorkload(detail) {
  const summaryText = detail.summariesList
    .map((item) => `${item.title} ${contentJsonToText(item.contentJson)}`)
    .join(' ');
  const detailText = buildDetailDescription(detail);
  return inferWorkload([summaryText, detailText].join(' '));
}

function buildDetailRemote(detail) {
  const text = [
    detail.title,
    detail.masterCategory?.name || '',
    detail.parentMasterCategory?.name || '',
    buildDetailDescription(detail),
  ].join(' ');
  return inferRemote(text) ?? true;
}

function extractCategory(text, title) {
  if (!title) return '';
  const pattern = new RegExp(`${escapeRegExp(title)}\\s+(.{2,40}?)\\s+予算`);
  const matched = text.match(pattern);
  if (matched) return matched[1].trim();
  return '';
}

function inferWorkload(text) {
  if (/継続依頼あり/.test(text)) return '継続あり';
  const weekDays = text.match(/週\s*([0-9.]+)\s*日/);
  if (weekDays) return `週${weekDays[1]}日`;
  const weekHours = text.match(/週\s*([0-9.]+)\s*(?:h|H|時間)/);
  if (weekHours) return `月${Number(weekHours[1]) * 4}h`;
  return '';
}

function inferRemote(text) {
  if (/フルリモート|完全在宅|在宅勤務|リモート可|リモートOK/.test(text)) return true;
  if (/出社必須|常駐|リモート不可/.test(text)) return false;
  return null;
}

function isLikelyLongTerm(text) {
  return /継続依頼あり|時給|月給|月額|月収|長期|伴走|運用|導入支援|オンボーディング/.test(text);
}

const STRONG_POSITIVE_PATTERNS = [
  /AIエージェント/,
  /生成AI.{0,12}(導入|活用|支援|コンサル)/,
  /(業務改善|業務効率化|業務自動化|自動化支援)/,
  /(要件定義|業務設計|運用設計|導入支援|壁打ち|改善提案)/,
  /(スクレイピング|連携|API|GAS|Google Apps Script)/,
  /(開発|構築|実装).{0,12}(AI|自動化|チャットボット|システム)/,
];

const WEAK_POSITIVE_PATTERNS = [
  /(DX|PMO|コンサル|オンボーディング|BizOps|CS Ops)/,
  /(分析|設計|改善|運用|伴走|内製化)/,
];

const NEGATIVE_PATTERNS = [
  /AI動画|動画制作|動画編集|ショート動画|YouTube|サムネイル/,
  /画像生成|イラスト|デザイン制作|ロゴ|バナー|LPデザイン/,
  /記事|校正|リライト|SEO|ライティング/,
  /感想|レビュー|モニター|診断ツールを試して/,
  /占い|恋愛系|キャラクター絵柄|顔の入れ替え/,
  /Instagram|SNS運用|インフルエンサー|投稿予約|コピペ|X（旧Twitter）|Twitter/,
];

const BUSINESS_SIGNAL_PATTERNS = [
  /AIエージェント|導入支援|業務改善|業務効率化|業務自動化|自動化支援/,
  /要件定義|業務設計|運用設計|改善提案|壁打ち|PMO|コンサル/,
  /スクレイピング|連携|API|GAS|Google Apps Script|Webエンジニア/,
  /(開発|構築|実装).{0,12}(AI|自動化|チャットボット|システム)/,
];

const STRONG_POSITIVE_CATEGORY_PATTERNS = [
  /AI導入・生成AI活用相談/,
  /AIアプリケーション開発・制作/,
  /業務自動化・効率化支援/,
  /IT相談・システム開発/,
];

const WEAK_POSITIVE_CATEGORY_PATTERNS = [
  /データ分析・集計代行/,
  /財務・会計・経理の指導/,
  /ビジネス代行・事務代行/,
  /コンサル|レッスン|相談/,
];

const NEGATIVE_CATEGORY_PATTERNS = [
  /SNSアカウント運用|MEO対策|Googleマップ集客/,
  /オンライン秘書|事務代行/,
  /ホームページ作成・サイト制作|Webサイトデザイン|Web制作/,
  /動画|画像|デザイン|イラスト|ライティング|記事|編集/,
];

function scoreJob(job) {
  const text = [job.title, job.category, job.description].filter(Boolean).join(' ');
  const categoryText = [job.category, job.title].filter(Boolean).join(' ');
  let score = 0;

  if (!HAS_CUSTOM_QUERIES) {
    for (const pattern of STRONG_POSITIVE_PATTERNS) {
      if (pattern.test(text)) score += 4;
    }
    for (const pattern of WEAK_POSITIVE_PATTERNS) {
      if (pattern.test(text)) score += 2;
    }
    for (const pattern of NEGATIVE_PATTERNS) {
      if (pattern.test(text)) score -= 5;
    }
    for (const pattern of STRONG_POSITIVE_CATEGORY_PATTERNS) {
      if (pattern.test(categoryText)) score += 6;
    }
    for (const pattern of WEAK_POSITIVE_CATEGORY_PATTERNS) {
      if (pattern.test(categoryText)) score += 2;
    }
    for (const pattern of NEGATIVE_CATEGORY_PATTERNS) {
      if (pattern.test(categoryText)) score -= 6;
    }
  }

  if (job._longTerm) score += 2;
  if (/時給|月給|月額|継続/.test([job.salary, job.workload, text].join(' '))) score += 1;

  const salaryText = String(job.salary || '');
  const numericYen = salaryText.match(/([0-9,]+)(?:〜([0-9,]+))?円/);
  if (numericYen) {
    const low = Number(numericYen[1].replaceAll(',', ''));
    const high = numericYen[2] ? Number(numericYen[2].replaceAll(',', '')) : low;
    const max = Math.max(low, high);
    if (max >= 300000) score += 6;
    else if (max >= 100000) score += 4;
    else if (max >= 30000) score += 2;
    else if (max <= 5000) score -= 4;
    else if (max <= 10000) score -= 2;
  }

  if (/見積り希望/.test(salaryText)) score += 1;
  return score;
}

function shouldHardSkipJob(job) {
  if (HAS_CUSTOM_QUERIES) return false;

  const text = [job.title, job.category, job.description].filter(Boolean).join(' ');
  const categoryText = [job.title, job.category].join(' ');
  const creatorCategory = /動画|画像|デザイン|イラスト|ライティング|記事|編集|SNSアカウント運用/.test(categoryText);
  if (creatorCategory) return true;
  if (/オンライン秘書|MEO対策|Googleマップ集客|SEO対策・上位表示|ホームページ作成・サイト制作|Webサイトデザイン/.test(categoryText)) return true;

  const cheapOneShot = String(job.salary || '').match(/([0-9,]+)(?:〜([0-9,]+))?円/);
  if (cheapOneShot) {
    const low = Number(cheapOneShot[1].replaceAll(',', ''));
    const high = cheapOneShot[2] ? Number(cheapOneShot[2].replaceAll(',', '')) : low;
    const max = Math.max(low, high);
    if (max <= 5000 && !job._longTerm) return true;
  }

  const hasNegativeSignal = NEGATIVE_PATTERNS.some((pattern) => pattern.test(text));
  if (!hasNegativeSignal) return false;
  return !BUSINESS_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
}

async function fetchRequestDetail(id) {
  try {
    await sleep(DETAIL_DELAY_MS);
    const detail = await fetchRequestDetailGrpc(id);
    const description = buildDetailDescription(detail);
    const text = [detail.title, description, detail.masterCategory?.name || '', detail.parentMasterCategory?.name || ''].join(' ');

    return {
      closed: detail.outline?.isExpired === true,
      title: detail.title || '',
      salary: formatBudgetRange(detail.outline?.priceMin || 0, detail.outline?.priceMax || 0, false),
      category: [detail.parentMasterCategory?.name, detail.masterCategory?.name].filter(Boolean).join(' / '),
      workload: buildDetailWorkload(detail),
      remote: buildDetailRemote(detail),
      description,
      longTerm: isLikelyLongTerm(text),
    };
  } catch {
    try {
      const html = await fetchHTMLWithRetry(`${BASE}/requests/${id}`, {}, { attempts: 2, baseDelayMs: 3000 });
    if (html.includes('募集終了') || html.includes('この募集は終了しました')) return true;
    if (html.includes('お探しのページが見つかりません')) return true;

      const text = trimText(stripHtml(html));
      const title = extractTitle(text);
      const description = pickSection(text, '募集内容 募集内容', ['添付ファイル', '参考URL', '求めるスキル', '特記事項']);
      const skills = pickSection(text, '求めるスキル', ['特記事項', '募集内容の追記']);
      const notes = pickSection(text, '特記事項', ['募集内容の追記', '応募者一覧']);
      const category = extractCategory(text, title);
      const salary = extractBudget(text);
      const workload = inferWorkload(text);
      const remote = inferRemote(text) ?? true;
      const longTerm = isLikelyLongTerm(text);

      return {
        closed: false,
        title,
        salary,
        category,
        workload,
        remote,
        description: [description, skills, notes].filter(Boolean).join(' '),
        longTerm,
      };
  } catch {
      return {
        closed: false,
        title: '',
        salary: '',
        category: '',
        workload: '',
        remote: true,
        description: '',
        longTerm: false,
      };
    }
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
        if (page > 1) await sleep(SEARCH_DELAY_MS);
        const result = await fetchSearchRequests(query, page);
        const requests = result.requests || [];

        for (const request of requests) {
          const id = String(request.requestId || '').trim();
          if (!id || allJobs.has(id)) continue;
        allJobs.set(id, {
          id,
            title: request.title || '',
            company: request.userName || '',
          url: `${BASE}/requests/${id}`,
            salary: formatBudgetRange(request.minBudget, request.maxBudget, request.budgetConsultation),
            workload: '',
            remote: true,
            category: '',
            description: request.requestContent || '',
            _longTerm: isLikelyLongTerm([request.title, request.requestContent].join(' ')),
            _closed: request.isRecruitmentFinished === true,
          });
        }

        process.stderr.write(`    → page ${page}: ${requests.length}件取得（累計 ${allJobs.size}件）\n`);
        if (requests.length < SEARCH_PAGE_LIMIT) break;
    } catch (e) {
        process.stderr.write(`    ⚠️ "${query}" page ${page} エラー: ${e.message}\n`);
        break;
      }
    }
  }

  // 一覧APIの情報だけで一次選別し、詳細取得件数を絞る
  const jobs = [...allJobs.values()];
  const prefiltered = filterJobs(jobs.filter((job) => !job._closed), { skipKeywordFilter: HAS_CUSTOM_QUERIES })
    .map((job) => {
      job._score = scoreJob(job);
      return job;
    })
    .filter((job) => !shouldHardSkipJob(job))
    .filter((job) => job._score >= 1)
    .sort((a, b) => b._score - a._score || Number(Boolean(b._longTerm)) - Number(Boolean(a._longTerm)));

  process.stderr.write(`  🔎 詳細確認対象: ${prefiltered.length}件 / 全体 ${jobs.length}件\n`);

  const tasks = prefiltered.map(job => async () => {
    const result = await fetchRequestDetail(job.id);
    if (result === true) {
      job._closed = true;
      return;
    }

    job.title = result.title || job.title;
    job.salary = result.salary || job.salary;
    job.category = result.category || job.category;
    job.description = [job.title, result.category, result.description].filter(Boolean).join(' ');
    job.workload = result.workload || job.workload;
    job.remote = result.remote ?? job.remote;
    job._longTerm = result.longTerm;
  });

  await parallelLimit(tasks, 3);

  const closedCount = jobs.filter(j => j._closed).length;
  process.stderr.write(`    → 募集終了: ${closedCount}件 / 募集中: ${jobs.length - closedCount}件\n`);

  const prioritized = prefiltered
    .filter((job) => !job._closed)
    .sort((a, b) => Number(Boolean(b._longTerm)) - Number(Boolean(a._longTerm)));

  const filtered = filterJobs(prioritized, { skipKeywordFilter: HAS_CUSTOM_QUERIES })
    .map((job) => ({ ...job, _score: scoreJob(job) }))
    .filter((job) => !shouldHardSkipJob(job))
    .filter((job) => job._score >= 3)
    .sort((a, b) => b._score - a._score || Number(Boolean(b._longTerm)) - Number(Boolean(a._longTerm)));

  output(PLATFORM, filtered.map(({ _score, ...job }) => job));
}

scout().catch(e => outputError(PLATFORM, e));
