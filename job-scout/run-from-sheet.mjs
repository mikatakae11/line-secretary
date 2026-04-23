#!/usr/bin/env node
/**
 * 設定シートを読んで案件探索し、案件一覧シートに反映する。
 *
 * 使い方:
 *   node run-from-sheet.mjs
 *
 * .env の SPREADSHEET_ID を使う。
 */

import { execFile } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ALL_KEYWORDS, SEARCH_QUERIES, WIDE_SEARCH_QUERIES } from './config.mjs';
import { getSheetsClient, loadScoutEnv } from './google-sheets-auth.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SETTINGS_SHEET = '設定';
const LIST_SHEET = '案件一覧';
const JOB_LIST_HEADER = [
  '取得日時',
  'おすすめ度',
  'おすすめ理由',
  '案件名',
  '会社名',
  'プラットフォーム',
  '報酬',
  '稼働',
  'リモート',
  'URL',
  'ステータス',
  '応募文メモ',
];

const PLATFORM_LABEL_TO_ID = {
  Wantedly: 'wantedly',
  SOKUDAN: 'sokudan',
  複業クラウド: 'fukugyo-cloud',
  Workship: 'workship',
  YOUTRUST: 'youtrust',
  ユートラスト: 'youtrust',
  CrowdWorks: 'crowdworks',
  クラウドワークス: 'crowdworks',
  ココナラ: 'coconala',
  ランサーズ: 'lancers',
};

const REMOTE_PREFERENCES = new Set(['はい', 'いいえ', 'どちらでも']);

function getArgValue(name) {
  const arg = process.argv.slice(2).find((a) => a.startsWith(`${name}=`));
  return arg ? arg.split('=')[1] : '';
}

async function getSheets() {
  return getSheetsClient();
}

async function readSettings(sheets, spreadsheetId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${SETTINGS_SHEET}'!A1:C50`,
  });

  const rows = res.data.values || [];
  const byKey = new Map();
  for (const row of rows) {
    const key = row[0]?.trim();
    const value = row[1]?.trim() || '';
    if (key) byKey.set(key, value);
  }

  const enabledPlatforms = Object.entries(PLATFORM_LABEL_TO_ID)
    .filter(([label]) => (byKey.get(label) || '') === 'はい')
    .map(([, id]) => id);

  return {
    limit: Number(byKey.get('取得件数') || '5') || 5,
    instruction: byKey.get('指示') || '',
    exclude: byKey.get('除外条件') || '',
    minSalary: byKey.get('最低報酬') || '',
    maxWorkload: byKey.get('最大稼働量') || '',
    remotePreference: byKey.get('リモート希望') || 'どちらでも',
    platforms: enabledPlatforms,
  };
}

function runScout(platforms, options = {}) {
  return new Promise((resolve, reject) => {
    const args = [join(__dirname, 'all.mjs')];
    if (platforms.length) {
      args.push(`--platform=${platforms.join(',')}`);
    }
    if (options.searchDepth) {
      args.push(`--search-depth=${options.searchDepth}`);
    }
    if (options.pages) {
      args.push(`--pages=${options.pages}`);
    }
    if (options.queries?.length) {
      args.push(`--queries=${options.queries.join('||')}`);
    }
    if (options.relaxed) {
      args.push('--relaxed=1');
    }

    execFile('node', args, { timeout: 180000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      process.stderr.write(stderr);
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

function parseAmountYen(text) {
  if (!text) return 0;
  const normalized = text.replaceAll(',', '');
  const man = normalized.match(/([0-9.]+)\s*万円/);
  if (man) return Math.round(Number(man[1]) * 10000);
  const yen = normalized.match(/([0-9.]+)\s*円/);
  if (yen) return Math.round(Number(yen[1]));
  return 0;
}

function parseSalaryRequirement(text) {
  if (!text) return null;
  const normalized = text.replaceAll(',', '');
  const monthly = normalized.match(/([0-9.]+)\s*万円/);
  if (monthly) {
    return { type: 'monthly', value: Math.round(Number(monthly[1]) * 10000) };
  }
  const hourly = normalized.match(/時給\s*([0-9.]+)\s*円/);
  if (hourly) {
    return { type: 'hourly', value: Math.round(Number(hourly[1])) };
  }
  const fixed = normalized.match(/([0-9.]+)\s*円/);
  if (fixed) {
    return { type: 'fixed', value: Math.round(Number(fixed[1])) };
  }
  return null;
}

function parseJobSalaryInfo(salary) {
  if (!salary) return null;

  const monthMatches = [...salary.matchAll(/([0-9.]+)\s*万円/g)].map((m) => Number(m[1]) * 10000);
  if (monthMatches.length) {
    return { type: 'monthly', value: Math.max(...monthMatches) };
  }

  const hourlyMatch = salary.match(/時給\s*([0-9,]+)(?:\s*[〜~-]\s*([0-9,]+))?\s*円/);
  if (hourlyMatch) {
    const values = [hourlyMatch[1], hourlyMatch[2]]
      .filter(Boolean)
      .map((value) => Number(value.replaceAll(',', '')));
    return { type: 'hourly', value: Math.max(...values) };
  }

  const yenMatches = [...salary.matchAll(/([0-9,]+)\s*円/g)]
    .map((match) => Number(match[1].replaceAll(',', '')))
    .filter(Number.isFinite);
  if (yenMatches.length) {
    return { type: 'fixed', value: Math.max(...yenMatches) };
  }

  return null;
}

function parseWorkloadLimit(text) {
  if (!text) return null;
  const weekMatch = text.match(/週\s*([0-9.]+)\s*日/);
  if (weekMatch) return { type: 'weekDays', value: Number(weekMatch[1]) };
  const monthMatch = text.match(/月\s*([0-9.]+)\s*h/i);
  if (monthMatch) return { type: 'monthHours', value: Number(monthMatch[1]) };
  return null;
}

function parseJobWorkload(text) {
  if (!text) return null;
  const weekMatch = text.match(/週\s*([0-9.]+)\s*日/);
  if (weekMatch) return { type: 'weekDays', value: Number(weekMatch[1]) };
  const monthMatch = text.match(/月\s*([0-9.]+)\s*h/i);
  if (monthMatch) return { type: 'monthHours', value: Number(monthMatch[1]) };
  return null;
}

function parseInstructionKeywords(instruction) {
  if (!instruction) return [];
  const delimiters = /[、,，\s　・／/]+/;
  return instruction
    .split(delimiters)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function extractIntentKeywords(instruction) {
  if (!instruction) return [];
  const userKeywords = parseInstructionKeywords(instruction);
  if (userKeywords.length > 0) return userKeywords;
  return ALL_KEYWORDS;
}

function buildAdditionalQueries(settings, mode = 'deep') {
  const userKeywords = parseInstructionKeywords(settings.instruction);
  const hasUserInstruction = userKeywords.length > 0;

  if (hasUserInstruction) {
    const queryVariants = [];
    for (const keyword of userKeywords) {
      queryVariants.push(keyword);
      queryVariants.push(`${keyword} 業務委託`);
      queryVariants.push(`${keyword} 副業`);
      queryVariants.push(`${keyword} フリーランス`);
    }
    for (let i = 0; i < userKeywords.length; i++) {
      for (let j = i + 1; j < userKeywords.length && j < i + 3; j++) {
        queryVariants.push(`${userKeywords[i]} ${userKeywords[j]}`);
      }
    }
    return [...new Set(queryVariants)]
      .filter(Boolean)
      .slice(0, mode === 'wide' ? 40 : 25);
  }

  const baseQueries = mode === 'wide'
    ? [...SEARCH_QUERIES, ...WIDE_SEARCH_QUERIES]
    : SEARCH_QUERIES;

  return [...new Set(baseQueries)]
    .filter(Boolean)
    .slice(0, mode === 'wide' ? 40 : 25);
}

function mergeJobs(jobLists) {
  const merged = [];
  const seen = new Set();

  for (const jobs of jobLists) {
    for (const job of jobs) {
      const key = `${job.platform || ''}|${job.id || ''}|${job.url || ''}|${job.title || ''}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(job);
    }
  }

  return merged;
}

function matchesExclude(text, excludeText) {
  const tokens = excludeText
    .split(/[、,\n\s\u3000]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (!tokens.length) return false;
  return tokens.some((token) => text.includes(token));
}

function validateSettings(settings) {
  const warnings = [];

  if (!Number.isInteger(settings.limit) || settings.limit <= 0) {
    throw new Error('取得件数 は 1 以上の整数で指定してください');
  }

  if (settings.minSalary && !parseSalaryRequirement(settings.minSalary)) {
    warnings.push(`最低報酬 の形式を解釈できませんでした: ${settings.minSalary}`);
  }

  if (settings.maxWorkload && !parseWorkloadLimit(settings.maxWorkload)) {
    warnings.push(`最大稼働量 の形式を解釈できませんでした: ${settings.maxWorkload}`);
  }

  if (!REMOTE_PREFERENCES.has(settings.remotePreference)) {
    warnings.push(`リモート希望 は「はい / いいえ / どちらでも」を推奨します: ${settings.remotePreference}`);
  }

  if (settings.platforms.length === 0) {
    warnings.push('対象プラットフォーム が未選択のため、全プラットフォームを対象にします');
  }

  return warnings;
}

function filterAndRankJobs(jobs, settings) {
  const minSalary = parseSalaryRequirement(settings.minSalary);
  const workloadLimit = parseWorkloadLimit(settings.maxWorkload);
  const intentKeywords = extractIntentKeywords(settings.instruction);
  const hasUserInstruction = parseInstructionKeywords(settings.instruction).length > 0;
  const analysis = {
    sourceJobs: jobs.length,
    excludedBy: {
      exclude: 0,
      minSalary: 0,
      remote: 0,
      workload: 0,
    },
    duplicatesRemoved: 0,
  };

  const filtered = jobs
    .filter((job) => {
      if (job._closed) return false;

      const text = [job.title, job.company, job.description, job.category].join(' ');

      if (matchesExclude(text, settings.exclude)) {
        analysis.excludedBy.exclude += 1;
        return false;
      }

      if (minSalary) {
        const salary = parseJobSalaryInfo(job.salary);
        if (salary && salary.type === minSalary.type && salary.value < minSalary.value) {
          analysis.excludedBy.minSalary += 1;
          return false;
        }
      }

      if (settings.remotePreference === 'はい' && job.remote !== true) {
        analysis.excludedBy.remote += 1;
        return false;
      }

      if (settings.remotePreference === 'いいえ' && job.remote !== false) {
        analysis.excludedBy.remote += 1;
        return false;
      }

      if (workloadLimit) {
        const workload = parseJobWorkload(job.workload);
        if (workload && workload.type === workloadLimit.type && workload.value > workloadLimit.value) {
          analysis.excludedBy.workload += 1;
          return false;
        }
      }

      return true;
    })
    .map((job) => {
      const text = [job.title, job.company, job.description, job.category].join(' ');
      let score = job.score || 0;
      const reasons = [...(job.score_reasons || [])];

      const lowerText = text.toLowerCase();
      const matchedIntent = intentKeywords.filter((keyword) => lowerText.includes(keyword.toLowerCase()));
      if (matchedIntent.length) {
        const bonus = hasUserInstruction ? 10 : 6;
        score += matchedIntent.length * bonus;
        reasons.unshift(`指示一致: ${matchedIntent.join(', ')}`);
      }

      if (settings.remotePreference === 'はい' && job.remote === true) {
        score += 4;
      }

      return {
        ...job,
        score,
        score_reasons: Array.from(new Set(reasons)),
      };
    })
    .sort((a, b) => b.score - a.score);

  const seen = new Set();
  const deduped = [];
  for (const job of filtered) {
    const key = `${job.platform}|${job.company || ''}|${job.title || ''}`.toLowerCase();
    if (seen.has(key)) {
      analysis.duplicatesRemoved += 1;
      continue;
    }
    seen.add(key);
    deduped.push(job);
  }

  const selectedJobs = deduped.slice(0, settings.limit);
  return {
    selectedJobs,
    analysis: {
      ...analysis,
      rankedCandidates: deduped.length,
      targetCount: settings.limit,
      selectedCount: selectedJobs.length,
      shortfall: Math.max(0, settings.limit - selectedJobs.length),
    },
  };
}

function buildRelaxationSignature(settings) {
  return [
    settings.remotePreference || '',
    settings.minSalary || '',
    settings.maxWorkload || '',
  ].join('|');
}

function buildRelaxationStages(settings, analysis) {
  const stages = [{ name: 'strict', label: '', settings }];
  const seen = new Set([buildRelaxationSignature(settings)]);

  const candidates = [
    settings.maxWorkload
      ? {
          count: analysis.excludedBy.workload || 0,
          name: 'workload',
          label: '最大稼働量を緩和',
          settings: { ...settings, maxWorkload: '' },
        }
      : null,
    settings.minSalary
      ? {
          count: analysis.excludedBy.minSalary || 0,
          name: 'salary',
          label: '最低報酬を緩和',
          settings: { ...settings, minSalary: '' },
        }
      : null,
    settings.remotePreference !== 'どちらでも'
      ? {
          count: analysis.excludedBy.remote || 0,
          name: 'remote',
          label: 'リモート条件を緩和',
          settings: { ...settings, remotePreference: 'どちらでも' },
        }
      : null,
  ]
    .filter(Boolean)
    .sort((a, b) => b.count - a.count);

  for (const candidate of candidates) {
    const signature = buildRelaxationSignature(candidate.settings);
    if (seen.has(signature)) continue;
    seen.add(signature);
    stages.push(candidate);
  }

  const fullyRelaxed = {
    ...settings,
    minSalary: '',
    maxWorkload: '',
    remotePreference: 'どちらでも',
  };
  const relaxedSignature = buildRelaxationSignature(fullyRelaxed);
  if (relaxedSignature !== buildRelaxationSignature(settings) && !seen.has(relaxedSignature)) {
    stages.push({
      name: 'combined',
      label: '報酬・稼働・リモート条件をまとめて緩和',
      settings: fullyRelaxed,
    });
  }

  return stages;
}

function selectJobsWithRelaxations(jobs, settings) {
  const strictResult = filterAndRankJobs(jobs, settings);
  const stages = buildRelaxationStages(settings, strictResult.analysis);
  const selected = [];
  const selectedKeys = new Set();
  const relaxationsApplied = [];
  let finalAnalysis = strictResult.analysis;

  for (const stage of stages) {
    const result = stage.name === 'strict' ? strictResult : filterAndRankJobs(jobs, stage.settings);
    finalAnalysis = result.analysis;

    let addedInStage = 0;
    for (const job of result.selectedJobs) {
      const identityKey = buildJobIdentityKey(job) || `${job.platform}|${job.title}|${job.url}`;
      if (selectedKeys.has(identityKey)) continue;
      selectedKeys.add(identityKey);
      selected.push(
        stage.name === 'strict'
          ? job
          : { ...job, relaxation_note: stage.label, relaxation_stage: stage.name }
      );
      addedInStage += 1;
      if (selected.length >= settings.limit) break;
    }

    if (stage.name !== 'strict' && addedInStage > 0) {
      relaxationsApplied.push(stage.label);
    }
    if (selected.length >= settings.limit) break;
  }

  return {
    selectedJobs: selected.slice(0, settings.limit),
    strictAnalysis: strictResult.analysis,
    analysis: {
      ...finalAnalysis,
      targetCount: settings.limit,
      selectedCount: selected.length,
      shortfall: Math.max(0, settings.limit - selected.length),
    },
    relaxationsApplied: Array.from(new Set(relaxationsApplied)),
  };
}

function summarizeShortfall(settings, analysis) {
  if (analysis.shortfall <= 0) {
    return {
      reason: '',
      suggestions: [],
    };
  }

  const reasons = [];
  const suggestions = [];
  const rankedExclusions = Object.entries(analysis.excludedBy)
    .sort((a, b) => b[1] - a[1])
    .filter(([, count]) => count > 0);

  for (const [type] of rankedExclusions) {
    if (type === 'remote') {
      reasons.push('リモート希望が厳しめ');
      suggestions.push('リモート希望');
    } else if (type === 'workload') {
      reasons.push('最大稼働量が厳しめ');
      suggestions.push('最大稼働量');
    } else if (type === 'minSalary') {
      reasons.push('最低報酬が高め');
      suggestions.push('最低報酬');
    } else if (type === 'exclude') {
      reasons.push('除外条件で候補が多く落ちた');
    }
  }

  if (analysis.sourceJobs === 0) {
    reasons.push('探索元の候補自体が取得できなかった');
  } else if (analysis.rankedCandidates < analysis.targetCount && rankedExclusions.length === 0) {
    reasons.push('対象プラットフォーム内の候補母数が少ない');
  }

  return {
    reason: reasons.join(' / '),
    suggestions: Array.from(new Set(suggestions)).slice(0, 3),
  };
}

function summarizePlatforms(jobs) {
  const counts = new Map();
  for (const job of jobs) {
    const label = job.platform_label || '不明';
    counts.set(label, (counts.get(label) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }));
}

function buildJobIdentityKey(job) {
  const url = (job.url || '').trim();
  if (url) return `url:${url}`;

  const platform = (job.platform || job.platform_label || '').trim().toLowerCase();
  const company = (job.company || '').trim().toLowerCase();
  const title = (job.title || '').trim().toLowerCase();
  if (platform || company || title) {
    return `fallback:${platform}|${company}|${title}`;
  }

  return '';
}

async function readExistingJobList(sheets, spreadsheetId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${LIST_SHEET}'!A:L`,
  });

  const rows = res.data.values || [];
  if (rows.length === 0) {
    return {
      hasHeader: false,
      rows: [],
      existingKeys: new Set(),
      unreviewedCount: 0,
      totalRows: 0,
    };
  }

  const hasHeader = rows[0].length > 0 && rows[0][0] === JOB_LIST_HEADER[0];
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const existingKeys = new Set();
  let unreviewedCount = 0;

  for (const row of dataRows) {
    const url = (row[9] || '').trim();
    const platform = (row[5] || '').trim();
    const company = (row[4] || '').trim();
    const title = (row[3] || '').trim();
    const status = (row[10] || '').trim();

    if (url) {
      existingKeys.add(`url:${url}`);
    } else if (platform || company || title) {
      existingKeys.add(`fallback:${platform.toLowerCase()}|${company.toLowerCase()}|${title.toLowerCase()}`);
    }

    if (status === '未確認') {
      unreviewedCount += 1;
    }
  }

  return {
    hasHeader,
    rows: dataRows,
    existingKeys,
    unreviewedCount,
    totalRows: dataRows.length,
  };
}

function pushReason(reasons, reason) {
  if (!reason) return;
  if (reasons.includes(reason)) return;
  if (reasons.length >= 3) return;
  reasons.push(reason);
}

function formatSalaryReason(job, settings) {
  const salaryInfo = parseJobSalaryInfo(job.salary);
  if (!salaryInfo || !job.salary) return '';

  const requirement = parseSalaryRequirement(settings.minSalary);
  if (requirement && requirement.type === salaryInfo.type && salaryInfo.value >= requirement.value) {
    return `${job.salary}で希望報酬ラインを満たす`;
  }

  if (salaryInfo.type === 'monthly' && salaryInfo.value >= 800000) {
    return `${job.salary}で条件水準が高い`;
  }

  if (salaryInfo.type === 'hourly' && salaryInfo.value >= 5000) {
    return `${job.salary}で条件水準が高い`;
  }

  if (salaryInfo.type === 'fixed' && salaryInfo.value >= 300000) {
    return `予算${job.salary}で中大型の案件感がある`;
  }

  if (salaryInfo.type === 'fixed' && salaryInfo.value >= 100000) {
    return `予算${job.salary}が明記されていて判断しやすい`;
  }

  if (salaryInfo.type === 'fixed') {
    return `予算${job.salary}が明記されている`;
  }

  return `${job.salary}で報酬条件が明確`;
}

function formatWorkStyleReason(job, settings) {
  const workload = parseJobWorkload(job.workload);
  const workloadLimit = parseWorkloadLimit(settings.maxWorkload);

  function describeWorkload() {
    if (!workload) return '';

    if (workload.type === 'monthHours') {
      if (workload.value <= 40) return `月${workload.value}hで副業しやすい`;
      if (workload.value <= 80) return `月${workload.value}hで現実的に参画しやすい`;
      return `月${workload.value}hで稼働はやや重め`;
    }

    if (workload.type === 'weekDays') {
      if (workload.value <= 2) return `週${workload.value}日で副業しやすい`;
      if (workload.value <= 3) return `週${workload.value}日で現実的に参画しやすい`;
      return `週${workload.value}日で稼働はやや重め`;
    }

    return '';
  }

  if (settings.remotePreference === 'はい' && job.remote === true) {
    const workloadDescription = describeWorkload();
    if (workloadDescription) return `フルリモートかつ${workloadDescription}`;
    return 'フルリモートで希望条件に合致';
  }

  if (workload && workloadLimit && workload.type === workloadLimit.type && workload.value <= workloadLimit.value) {
    return describeWorkload();
  }

  if (job.remote === true) {
    const workloadDescription = describeWorkload();
    if (workloadDescription) return `リモートかつ${workloadDescription}`;
    return 'リモートで参画しやすい';
  }

  return describeWorkload();
}

function formatContentReason(job, settings) {
  const text = [job.title, job.category, job.description].join(' ');
  const lowerText = text.toLowerCase();
  const matchedIntent = extractIntentKeywords(settings.instruction)
    .filter((keyword) => lowerText.includes(keyword.toLowerCase()));

  if (matchedIntent.length > 0) {
    return `${matchedIntent.slice(0, 3).join('・')}のテーマと一致`;
  }

  return '';
}

function formatRecommendationReasons(job, settings) {
  const reasons = [];

  pushReason(reasons, formatContentReason(job, settings));
  pushReason(reasons, formatWorkStyleReason(job, settings));
  pushReason(reasons, formatSalaryReason(job, settings));
  pushReason(reasons, job.relaxation_note ? `候補不足のため${job.relaxation_note}` : '');

  for (const reason of job.score_reasons || []) {
    if (/キーワード一致/.test(reason)) {
      pushReason(reasons, reason);
    } else if (/リモート可/.test(reason)) {
      pushReason(reasons, 'リモートで参画しやすい');
    } else if (/副業向き/.test(reason) || /現実的な稼働/.test(reason)) {
      pushReason(reasons, reason);
    }
  }

  if (reasons.length === 0) {
    pushReason(reasons, '募集内容が比較的具体的');
  }

  return reasons.map((reason) => `・${reason}`).join('\n');
}

function buildStarRating(index, total) {
  if (total <= 0) return '★';
  const topBucket = Math.ceil(total / 3);
  const middleBucketEnd = Math.ceil((total * 2) / 3);

  if (index < topBucket) return '★★★';
  if (index < middleBucketEnd) return '★★';
  return '★';
}

function buildRows(jobs, settings) {
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' });
  return jobs.map((job, index) => [
    now,
    buildStarRating(index, jobs.length),
    formatRecommendationReasons(job, settings),
    job.title || '',
    job.company || '',
    job.platform_label || '',
    job.salary || '要確認',
    job.workload || '',
    job.remote === true ? '可' : job.remote === false ? '不可' : '不明',
    job.url || '',
    '未確認',
    '',
  ]);
}

async function writeJobList(sheets, spreadsheetId, rows) {
  const existing = await readExistingJobList(sheets, spreadsheetId);

  if (!existing.hasHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${LIST_SHEET}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [JOB_LIST_HEADER, ...rows] },
    });
    return;
  }

  if (rows.length === 0) return;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${LIST_SHEET}'!A:L`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

async function main() {
  loadScoutEnv();
  const spreadsheetId = getArgValue('--spreadsheet') || process.env.SPREADSHEET_ID || '';
  if (!spreadsheetId) {
    throw new Error(
      '.env に SPREADSHEET_ID を設定してください'
    );
  }

  const sheets = await getSheets();
  const settings = await readSettings(sheets, spreadsheetId);
  const warnings = validateSettings(settings);
  const existingJobList = await readExistingJobList(sheets, spreadsheetId);
  const targetUnreviewedCount = settings.limit;
  const neededCount = Math.max(0, targetUnreviewedCount - existingJobList.unreviewedCount);
  process.stderr.write(`📋 設定読込: ${settings.limit}件 / ${settings.platforms.join(', ') || '全プラットフォーム'}\n`);
  process.stderr.write(`📚 既存案件: ${existingJobList.totalRows}件 / 未確認: ${existingJobList.unreviewedCount}件\n`);
  for (const warning of warnings) {
    process.stderr.write(`⚠️  ${warning}\n`);
  }

  if (neededCount <= 0) {
    process.stderr.write(`✅ 未確認案件はすでに ${existingJobList.unreviewedCount}件あるため、追加取得は不要です\n`);
    console.log(JSON.stringify({
      success: true,
      spreadsheetId,
      settings,
      warnings,
      targetUnreviewedCount,
      existingUnreviewedCount: existingJobList.unreviewedCount,
      neededCount: 0,
      jobsWritten: 0,
      attempts: [],
      shortfall: 0,
      shortfallReason: '',
      suggestedRelaxations: [],
      platformBreakdown: [],
      analysis: {
        sourceJobs: 0,
        excludedBy: { exclude: 0, minSalary: 0, remote: 0, workload: 0 },
        duplicatesRemoved: 0,
        rankedCandidates: 0,
        targetCount: 0,
        selectedCount: 0,
        shortfall: 0,
      },
    }, null, 2));
    return;
  }

  const attempts = [];

  const initialQueries = buildAdditionalQueries(settings, 'deep');
  const firstCombined = await runScout(settings.platforms, {
    searchDepth: 'default',
    queries: initialQueries.length ? initialQueries : undefined,
  });
  attempts.push({ name: 'default', combined: firstCombined });

  let mergedJobs = mergeJobs(attempts.map((attempt) => attempt.combined.top_jobs || []));
  mergedJobs = mergedJobs.filter((job) => {
    const identityKey = buildJobIdentityKey(job);
    return identityKey ? !existingJobList.existingKeys.has(identityKey) : true;
  });

  let { selectedJobs, analysis } = filterAndRankJobs(mergedJobs, { ...settings, limit: neededCount });

  if (analysis.shortfall > 0) {
    process.stderr.write('🔁 同条件で追加探索します...\n');
    const additionalQueries = buildAdditionalQueries(settings, 'deep');
    const deepCombined = await runScout(settings.platforms, {
      searchDepth: 'deep',
      pages: 3,
      queries: additionalQueries,
    });
    attempts.push({ name: 'deep', combined: deepCombined });
    mergedJobs = mergeJobs(attempts.map((attempt) => attempt.combined.top_jobs || []));
    mergedJobs = mergedJobs.filter((job) => {
      const identityKey = buildJobIdentityKey(job);
      return identityKey ? !existingJobList.existingKeys.has(identityKey) : true;
    });
    ({ selectedJobs, analysis } = filterAndRankJobs(mergedJobs, { ...settings, limit: neededCount }));
  }

  if (analysis.shortfall > 0) {
    process.stderr.write('🔁 検索幅をさらに広げます...\n');
    const wideQueries = buildAdditionalQueries(settings, 'wide');
    const wideCombined = await runScout(settings.platforms, {
      searchDepth: 'deep',
      pages: 4,
      queries: wideQueries,
    });
    attempts.push({ name: 'wide', combined: wideCombined });
    mergedJobs = mergeJobs(attempts.map((attempt) => attempt.combined.top_jobs || []));
    mergedJobs = mergedJobs.filter((job) => {
      const identityKey = buildJobIdentityKey(job);
      return identityKey ? !existingJobList.existingKeys.has(identityKey) : true;
    });
    ({ selectedJobs, analysis } = filterAndRankJobs(mergedJobs, { ...settings, limit: neededCount }));
  }

  if (analysis.shortfall > 0) {
    process.stderr.write('🪶 条件を段階的に緩和して補完候補を探します...\n');
    const relaxedQueries = buildAdditionalQueries(settings, 'wide');
    const relaxedCombined = await runScout(settings.platforms, {
      searchDepth: 'deep',
      pages: 4,
      queries: relaxedQueries,
      relaxed: true,
    });
    attempts.push({ name: 'relaxed', combined: relaxedCombined });
    mergedJobs = mergeJobs(attempts.map((attempt) => attempt.combined.top_jobs || []));
    mergedJobs = mergedJobs.filter((job) => {
      const identityKey = buildJobIdentityKey(job);
      return identityKey ? !existingJobList.existingKeys.has(identityKey) : true;
    });
  }

  const finalSelection = selectJobsWithRelaxations(mergedJobs, { ...settings, limit: neededCount });
  selectedJobs = finalSelection.selectedJobs;
  analysis = finalSelection.analysis;

  const rows = buildRows(selectedJobs, settings);
  const shortfall = summarizeShortfall(settings, finalSelection.strictAnalysis);
  const platformsSummary = summarizePlatforms(selectedJobs);

  await writeJobList(sheets, spreadsheetId, rows);

  if (finalSelection.relaxationsApplied.length) {
    process.stderr.write(`🪶 条件緩和を適用: ${finalSelection.relaxationsApplied.join(' / ')}\n`);
  }

  if (analysis.shortfall > 0) {
    process.stderr.write(
      `⚠️  目標件数未達: ${analysis.targetCount}件中 ${analysis.selectedCount}件`
      + `（不足 ${analysis.shortfall}件）\n`
    );
    if (shortfall.reason) {
      process.stderr.write(`   不足理由: ${shortfall.reason}\n`);
    }
    if (shortfall.suggestions.length) {
      process.stderr.write(`   緩和候補: ${shortfall.suggestions.join(' / ')}\n`);
    }
  }

  process.stderr.write(`✅ 案件一覧に新規追加: ${rows.length}件\n`);
  console.log(JSON.stringify({
    success: true,
    spreadsheetId,
    settings,
    warnings,
    targetUnreviewedCount,
    existingUnreviewedCount: existingJobList.unreviewedCount,
    neededCount,
    jobsWritten: rows.length,
    attempts: attempts.map((attempt) => ({
      name: attempt.name,
      sitesSuccess: attempt.combined.sites_success,
      sitesTotal: attempt.combined.sites_total,
      jobsTotal: attempt.combined.jobs_total,
    })),
    targetCount: settings.limit,
    shortfall: analysis.shortfall,
    shortfallReason: shortfall.reason,
    suggestedRelaxations: shortfall.suggestions,
    relaxationsApplied: finalSelection.relaxationsApplied,
    platformBreakdown: platformsSummary,
    analysis,
    strictAnalysis: finalSelection.strictAnalysis,
  }, null, 2));
}

main().catch((error) => {
  process.stderr.write(`❌ scout sheet run error: ${error.message}\n`);
  process.exit(1);
});
