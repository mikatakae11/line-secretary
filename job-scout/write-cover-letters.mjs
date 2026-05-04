/**
 * 案件一覧の「応募予定」行に応募文を自動生成してL列に書き込む
 * - URLから募集要項・クライアント情報・レビューを取得
 * - テンプレがあればそれを使用
 * - AI感のない自然な文章で生成
 */
import { getSheetsClient, loadScoutEnv } from './google-sheets-auth.mjs';

loadScoutEnv();

const SPREADSHEET_ID = process.env.JOB_SCOUT_SPREADSHEET_ID || process.env.SPREADSHEET_ID || '1tmuRePgdiAN7xG_hQaf-Zg6bNx6S_C8-_ia0f_vHl9M';
const LIST_SHEET = '案件一覧';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const PROFILE = `
■ 基本情報
名前：髙江海香（たかえみか）、40歳、女性、未婚

■ 職業・経験
- 在宅秘書（業務委託）1年以上
- YouTube台本制作（スカッと系・日本称賛系・朗読系・漫画系）10本以上
- 文字起こし業務経験あり
- モデル・飲食店経営の職歴あり
- AIコミュニティでライティングを勉強中（2024年12月〜）
- Claude AIを活用したライティング

■ スキル・得意分野
- 秘書業務で培った正確性・細部への気配り・時間管理
- YouTube台本：プロットからオチまで、伏線・抑揚・演出
- 得意ジャンル：美容・健康・教育・旅行・食・映画ドラマ・シナリオ
- 即レス（12時間以内）・納期厳守・長期継続希望

■ 稼働時間
1日3〜5時間、週15〜20時間。平日・休日ともに対応可能。

■ 趣味・人柄
旅行（ほぼ毎月、年数回は1ヶ月単位の長期旅行）、映画・ドラマ（週15〜20話）、健康・食
数学専攻（大学）、健康オタク、発酵食品・腸活に詳しい
`.trim();

// URLから本文テキストを取得
async function fetchPageText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return '';
    const html = await res.text();
    // HTMLタグを除去して本文を抽出
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000); // 長すぎる場合は切り詰め
  } catch {
    return '';
  }
}

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude API error: ${JSON.stringify(data)}`);
  return data.content[0].text.trim();
}

async function generateCoverLetter(job, pageText) {
  const prompt = `あなたはフリーランスライターの髙江海香（40歳女性）です。以下の案件に応募するための文章を書いてください。

【あなたのプロフィール】
${PROFILE}

【案件情報】
案件名：${job.title}
クライアント：${job.company}
プラットフォーム：${job.platform}
報酬：${job.reward}
稼働：${job.workload}
リモート：${job.remote}

【募集ページの内容（クライアント情報・要件・レビュー含む）】
${pageText || '（取得できませんでした）'}

【応募文を作成する際の絶対ルール】
1. 募集ページにテンプレ（質問形式・記入欄など）があれば、必ずそのフォーマットに従って回答すること
2. テンプレがない場合は自然な応募文を書く（400〜600文字）
3. クライアントのレビューや要望から「この人が重視していること」を読み取り、そこに刺さる内容にする
4. AI感・テンプレ感を一切出さない。「〜させていただきます」「〜幸いです」の多用を避ける
5. 髙江海香本人が書いたような自然な口語文体を意識する
6. 具体的なエピソードや数字を使い、信頼感を出す
7. 長すぎず、読みやすい文章にする
8. 宛名・件名は不要。本文のみ出力する
9. 「ご検討よろしくお願いします」など定番の締めも自然に

応募文のみを出力してください。解説や前置きは一切不要です。`;

  return await callClaude(prompt);
}

async function main() {
  const sheets = getSheetsClient();

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${LIST_SHEET}'!A1:L`,
  });

  const rows = data.values || [];
  if (rows.length < 2) { console.log('データがありません'); return; }

  const dataRows = rows.slice(1);
  const targets = dataRows
    .map((row, i) => ({ row, rowIndex: i + 2 }))
    .filter(({ row }) => {
      const status = (row[10] || '').trim();
      const memo   = (row[11] || '').trim();
      return status === '応募予定' && !memo;
    });

  if (targets.length === 0) {
    console.log('「応募予定」かつ応募文未記入の案件はありません');
    return;
  }

  console.log(`対象案件: ${targets.length}件\n`);

  for (const { row, rowIndex } of targets) {
    const job = {
      title:    (row[3] || '').trim(),
      company:  (row[4] || '').trim(),
      platform: (row[5] || '').trim(),
      reward:   (row[6] || '').trim(),
      workload: (row[7] || '').trim(),
      remote:   (row[8] || '').trim(),
      url:      (row[9] || '').trim(),
    };

    console.log(`[${rowIndex}行目] ${job.title}`);

    // URLから募集ページを取得
    let pageText = '';
    if (job.url) {
      process.stdout.write('  → ページ取得中...');
      pageText = await fetchPageText(job.url);
      console.log(pageText ? ` ${pageText.length}文字取得` : ' 取得失敗');
    }

    try {
      process.stdout.write('  → 応募文生成中...');
      const letter = await generateCoverLetter(job, pageText);
      console.log(' 完了');

      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${LIST_SHEET}'!L${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[letter]] },
      });
      console.log(`  ✅ L${rowIndex}に書き込みました\n`);

      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.error(`  ❌ エラー (行${rowIndex}):`, err.message, '\n');
    }
  }

  console.log('✅ 全件完了。スプレッドシートのL列をご確認ください。');
}

main().catch(e => { console.error(e); process.exit(1); });
