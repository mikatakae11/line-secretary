/**
 * 案件スカウト共通設定
 * キーワード・フィルタ・スキップ条件を一元管理
 */

export const KEYWORDS = {
  tech: [
    'AI', '生成AI', 'AIエージェント', 'LLM', 'ChatGPT', 'GPT',
    'GAS', 'Google Apps Script', 'Dify',
    'チャットボット', 'ノーコード', 'ローコード',
    'SaaS', 'API', '自動化', 'RPA',
  ],
  consul: [
    'コンサル', 'カスタマーサクセス', 'CS', 'PMO',
    'DX', 'DX推進', '業務改善', '業務設計', '業務効率化',
    '事業開発', '営業プロセス', 'KPI', 'オンボーディング',
  ],
  training: [
    'AI研修', '研修', '講師', '動画制作', '自治体',
  ],
};

export const ALL_KEYWORDS = Object.values(KEYWORDS).flat();

export const SEARCH_QUERIES = [
  'AI 業務委託', '生成AI コンサル', 'AIエージェント', 'GAS 自動化',
  'チャットボット 開発', 'DX推進 業務改善', 'カスタマーサクセス 業務委託',
  'AI研修 講師', 'ノーコード AI', 'Dify',
  '要件定義', '導入支援', '業務設計', '運用設計',
  'BPR', 'PMO', 'AI導入', '生成AI活用',
  '社内DX', '業務改革', 'BizOps', 'CS Ops',
  'Salesforce', 'HubSpot',
];

export const WIDE_SEARCH_QUERIES = [
  'DX コンサル', 'AI コンサル', '業務改善 コンサル', 'PMO コンサル',
  'ITコンサル', '導入コンサル', 'システム導入', '業務要件定義',
  'Sales Ops', 'Revenue Ops', 'CRM 導入', 'MA 導入',
  'SaaS 導入支援', 'オンボーディング', 'CS企画', '業務標準化',
];

// 設定シートの「除外条件」でユーザーが自由に設定可能。
// ここには汎用的に不要なもののみ残す。
export const SKIP_WORDS = [
  'ネイリスト', '梱包', '出品代行',
];

// 文脈ベースのスキップルール（description や detail から判定）
export const SKIP_CONTEXT_PATTERNS = [
  // 動画教材・研修動画の「納品」案件（講師登壇とは別物）
  /研修動画.{0,10}(納品|制作|作成|撮影)/,
  /教材.{0,10}(動画|映像|コンテンツ).{0,10}(納品|制作|作成)/,
  /(eラーニング|e-learning).{0,10}(動画|映像|コンテンツ)/i,
  // 正社員・中途採用（業務委託/副業/フリーランスのみ対象）
  /正社員(採用|募集|登用)/,
  /中途(採用|募集)/,
  /新卒(採用|募集)/,
  // 営業フロント（テレアポ、飛び込み等）
  /テレアポ/,
  /飛び込み営業/,
  /架電.{0,5}(件|本).*ノルマ/,
];

// 雇用形態フィルタ: いずれかを含む案件のみ通す（Wantedly等で使用）
export const ACCEPTABLE_WORK_TYPES = [
  '業務委託', '副業', 'フリーランス', '外部', '外注',
  'side_job', 'freelance', 'contract',
];

// 未使用。設定シートの「最低報酬」で制御する。
// export const SKIP_SALARY_BELOW = 3000;

/**
 * テキストがスカウト対象キーワードにマッチするか
 */
export function matchesKeywords(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  return ALL_KEYWORDS.filter(kw => lower.includes(kw.toLowerCase()));
}

/**
 * テキストがスキップ対象か（単語ベース）
 */
export function shouldSkip(text) {
  if (!text) return false;
  return SKIP_WORDS.some(w => text.includes(w));
}

/**
 * 文脈パターンでスキップ対象か（正規表現ベース）
 */
export function shouldSkipByContext(text) {
  if (!text) return false;
  return SKIP_CONTEXT_PATTERNS.some(p => p.test(text));
}
