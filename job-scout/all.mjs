#!/usr/bin/env node
/**
 * 全プラットフォーム案件スカウト（オーケストレーター）
 *
 * 使い方:
 *   node all.mjs                               # JSON 出力（既定）
 *   node all.mjs --format=markdown            # 読みやすい Markdown 出力
 *   node all.mjs --tier=1                     # Tier 1 のみ
 *   node all.mjs --tier=1,2                   # Tier 1+2
 *   node all.mjs --platform=coconala,wantedly # 特定プラットフォームのみ
 *   node all.mjs --limit=10                   # 上位 10 件まで表示
 *
 * 各プラットフォームを並列実行し、結果を統合して JSON / Markdown を出力する。
 * 実行結果は .cache/scout/latest.{json,md} に保存される。
 */

import { ALL_KEYWORDS } from './config.mjs';
import { execFile } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '.cache');

const PLATFORMS = {
  // Tier 1: API 直叩き
  'fukugyo-cloud': { tier: 1, script: 'fukugyo-cloud.mjs', label: '複業クラウド' },
  'wantedly':      { tier: 1, script: 'wantedly.mjs',      label: 'Wantedly' },
  'sokudan':       { tier: 1, script: 'sokudan.mjs',       label: 'SOKUDAN' },
  'workship':      { tier: 1, script: 'workship.mjs',      label: 'Workship' },
  'youtrust':      { tier: 1, script: 'youtrust.mjs',      label: 'YOUTRUST' },

  // Tier 2: HTML パース
  'crowdworks':    { tier: 2, script: 'crowdworks.mjs',    label: 'CrowdWorks' },
  'coconala':      { tier: 2, script: 'coconala.mjs',      label: 'ココナラ' },
  'lancers':       { tier: 2, script: 'lancers.mjs',       label: 'ランサーズ' },

  // Tier 3: browser-use（応募フォーム入力など）
  // その他: linkedin, indeed, lancers-agent
};

function runScout(name, config, forwardedArgs = []) {
  return new Promise((resolve) => {
    const script = join(__dirname, config.script);
    execFile('node', [script, ...forwardedArgs], { timeout: 180000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        process.stderr.write(`❌ ${config.label}: ${error.message}\n`);
        resolve({ platform: name, label: config.label, tier: config.tier, jobs: [], error: error.message });
        return;
      }
      process.stderr.write(stderr);
      try {
        const result = JSON.parse(stdout);
        resolve({ ...result, label: config.label, tier: config.tier });
      } catch {
        resolve({ platform: name, label: config.label, tier: config.tier, jobs: [], error: 'JSON parse error' });
      }
    });
  });
}

function getArgValue(args, name, fallback = null) {
  const arg = args.find((a) => a.startsWith(`${name}=`));
  return arg ? arg.split('=')[1] : fallback;
}

function toBoolLabel(value) {
  if (value === true) return '可';
  if (value === false) return '不可';
  return '不明';
}

function parseSalaryScore(salary) {
  if (!salary) return { score: 0, reason: null };

  const monthRange = salary.match(/月\s*([0-9.]+)\s*〜\s*([0-9.]+)\s*万円/);
  if (monthRange) {
    const max = Number(monthRange[2]);
    if (max >= 100) return { score: 24, reason: `高単価（月${max}万円）` };
    if (max >= 80) return { score: 20, reason: `好条件（月${max}万円）` };
    if (max >= 50) return { score: 14, reason: `十分な単価（月${max}万円）` };
    return { score: 8, reason: `月額あり（月${max}万円）` };
  }

  const hourRange = salary.match(/時給\s*([0-9,]+)\s*〜\s*([0-9,]+)\s*円/);
  if (hourRange) {
    const max = Number(hourRange[2].replaceAll(',', ''));
    if (max >= 8000) return { score: 18, reason: `高単価（時給${max.toLocaleString()}円）` };
    if (max >= 5000) return { score: 14, reason: `好条件（時給${max.toLocaleString()}円）` };
    if (max >= 3000) return { score: 10, reason: `許容単価（時給${max.toLocaleString()}円）` };
  }

  return { score: 0, reason: null };
}

function parseWorkloadScore(workload) {
  if (!workload) return { score: 0, reason: null };

  const monthHours = workload.match(/月\s*([0-9.]+)\s*h/i);
  if (monthHours) {
    const hours = Number(monthHours[1]);
    if (hours <= 60) return { score: 8, reason: `副業向き（月${hours}h）` };
    if (hours <= 100) return { score: 5, reason: `現実的な稼働（月${hours}h）` };
    return { score: 1, reason: `重めの稼働（月${hours}h）` };
  }

  const weekDays = workload.match(/週\s*([0-9.]+)\s*日/);
  if (weekDays) {
    const days = Number(weekDays[1]);
    if (days <= 2) return { score: 8, reason: `副業向き（週${days}日）` };
    if (days <= 3) return { score: 5, reason: `現実的な稼働（週${days}日）` };
    return { score: 1, reason: `重めの稼働（週${days}日）` };
  }

  return { score: 0, reason: null };
}

function scoreJob(job, tier) {
  let score = 0;
  const reasons = [];

  const keywordCount = job.keywords_matched?.length || 0;
  if (keywordCount > 0) {
    const keywordScore = keywordCount * 8;
    score += keywordScore;
    reasons.push(`キーワード${keywordCount}件一致`);
  }

  const salaryScore = parseSalaryScore(job.salary);
  score += salaryScore.score;
  if (salaryScore.reason) reasons.push(salaryScore.reason);

  const workloadScore = parseWorkloadScore(job.workload);
  score += workloadScore.score;
  if (workloadScore.reason) reasons.push(workloadScore.reason);

  if (job.remote === true) {
    score += 6;
    reasons.push('リモート可');
  }

  if (tier === 1) {
    score += 4;
    reasons.push('Tier1取得');
  } else if (tier === 2) {
    score += 2;
    reasons.push('Tier2取得');
  }

  const text = [job.title, job.category, job.description].join(' ');
  const matched = ALL_KEYWORDS.filter((kw) => text.toLowerCase().includes(kw.toLowerCase()));
  if (matched.length) {
    score += Math.min(matched.length * 2, 6);
    reasons.push(`キーワード一致: ${matched.slice(0, 3).join(', ')}`);
  }

  return {
    ...job,
    score,
    score_reasons: reasons,
  };
}

function enrichResults(results) {
  const flatJobs = results.flatMap((result) =>
    (result.jobs || []).map((job) =>
      scoreJob(
        {
          ...job,
          platform: result.platform,
          platform_label: result.label,
          tier: result.tier,
        },
        result.tier
      )
    )
  );

  const rankedJobs = flatJobs.sort((a, b) => b.score - a.score);
  const byPlatform = results.map((result) => ({
    platform: result.platform,
    label: result.label,
    tier: result.tier,
    total: result.jobs?.length || 0,
    top_score: Math.max(
      0,
      ...rankedJobs
        .filter((job) => job.platform === result.platform)
        .map((job) => job.score)
    ),
    error: result.error || null,
  }));

  return { rankedJobs, byPlatform };
}

function summarizeDescription(text, max = 110) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function toMarkdown(combined, limit) {
  const lines = [
    '# 案件スカウト結果',
    '',
    `- 実行時刻: ${combined.timestamp}`,
    `- 成功サイト: ${combined.sites_success}/${combined.sites_total}`,
    `- 候補件数: ${combined.jobs_total}件`,
    '',
    '## サイト別サマリ',
    '',
  ];

  for (const site of combined.summary_by_platform) {
    const status = site.error ? `失敗: ${site.error}` : `${site.total}件 / 最高スコア ${site.top_score}`;
    lines.push(`- ${site.label}: ${status}`);
  }

  lines.push('', '## 上位案件', '');

  const topJobs = combined.top_jobs.slice(0, limit);
  if (topJobs.length === 0) {
    lines.push('候補案件はありませんでした。');
    return `${lines.join('\n')}\n`;
  }

  for (const [index, job] of topJobs.entries()) {
    lines.push(`### ${index + 1}. ${job.company || '会社名不明'} — ${job.title}`);
    lines.push(`- プラットフォーム: ${job.platform_label}`);
    lines.push(`- スコア: ${job.score}`);
    lines.push(`- 理由: ${job.score_reasons.join(' / ') || 'キーワード一致'}`);
    if (job.salary) lines.push(`- 報酬: ${job.salary}`);
    if (job.workload) lines.push(`- 稼働: ${job.workload}`);
    lines.push(`- リモート: ${toBoolLabel(job.remote)}`);
    if (job.keywords_matched?.length) lines.push(`- キーワード: ${job.keywords_matched.join(', ')}`);
    if (job.url) lines.push(`- URL: ${job.url}`);
    const desc = summarizeDescription(job.description);
    if (desc) lines.push(`- 概要: ${desc}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function writeCaches(jsonText, markdownText) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, 'latest.json'), jsonText, 'utf-8');
  writeFileSync(join(CACHE_DIR, 'latest.md'), markdownText, 'utf-8');
}

function printQuickSummary(combined, limit) {
  process.stderr.write(`\n${'─'.repeat(40)}\n`);
  process.stderr.write(`✅ 完了: ${combined.sites_success}/${combined.sites_total}サイト | ${combined.jobs_total}件\n`);
  process.stderr.write(`📌 上位 ${Math.min(limit, combined.top_jobs.length)} 件\n`);

  combined.top_jobs.slice(0, limit).forEach((job, index) => {
    const company = job.company || '会社名不明';
    const salary = job.salary ? ` | ${job.salary}` : '';
    process.stderr.write(
      `  ${index + 1}. [${job.score}] ${company} / ${job.title} (${job.platform_label})${salary}\n`
    );
  });
  process.stderr.write('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const format = getArgValue(args, '--format', 'json');
  const limit = Number(getArgValue(args, '--limit', '10')) || 10;
  const forwardedArgs = args.filter((arg) =>
    arg.startsWith('--queries=')
    || arg.startsWith('--search-depth=')
    || arg.startsWith('--pages=')
    || arg.startsWith('--relaxed=')
  );

  // --tier フィルタ
  const tierArg = args.find(a => a.startsWith('--tier='));
  const tiers = tierArg ? tierArg.split('=')[1].split(',').map(Number) : [1, 2];

  // --platform フィルタ
  const platformArg = args.find(a => a.startsWith('--platform='));
  const platformFilter = platformArg ? platformArg.split('=')[1].split(',') : null;

  const targets = Object.entries(PLATFORMS).filter(([name, cfg]) => {
    if (platformFilter) return platformFilter.includes(name);
    return tiers.includes(cfg.tier);
  });

  process.stderr.write(`\n🔍 案件スカウト開始（${targets.length}サイト）\n`);
  process.stderr.write(`${'─'.repeat(40)}\n`);

  // 全プラットフォームを並列実行
  const results = await Promise.all(
    targets.map(([name, cfg]) => runScout(name, cfg, forwardedArgs))
  );

  const { rankedJobs, byPlatform } = enrichResults(results);

  // 統合結果
  const combined = {
    timestamp: new Date().toISOString(),
    sites_total: targets.length,
    sites_success: results.filter(r => !r.error).length,
    jobs_total: results.reduce((sum, r) => sum + (r.jobs?.length || 0), 0),
    summary_by_platform: byPlatform,
    top_jobs: rankedJobs,
    results,
  };

  const jsonText = JSON.stringify(combined, null, 2);
  const markdownText = toMarkdown(combined, limit);
  writeCaches(jsonText, markdownText);
  printQuickSummary(combined, limit);
  process.stderr.write(`💾 保存先: ${CACHE_DIR}/latest.{json,md}\n\n`);

  if (format === 'markdown' || format === 'md') {
    process.stdout.write(markdownText);
    return;
  }

  console.log(jsonText);
}

main().catch(e => {
  console.error('致命的エラー:', e.message);
  process.exit(1);
});
