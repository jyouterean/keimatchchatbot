/**
 * スプレッドシートの行を正規化・バリデーション
 */

export interface RawQARow {
  question: string;
  answer: string;
  category?: string;
  keywords?: string;
  enabled?: string | boolean;
}

export interface NormalizedQA {
  question: string;
  answer: string;
  category?: string;
  keywords?: string;
}

/**
 * enabled フィールドを boolean に変換
 */
function parseEnabled(value: string | boolean | undefined): boolean {
  if (value === undefined || value === null || value === '') {
    return true; // 空ならtrue扱い
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const str = String(value).trim().toLowerCase();
  return str !== 'false' && str !== '0' && str !== 'no' && str !== 'off';
}

/**
 * カラム名を正規化（大文字小文字、空白、全角半角を考慮）
 */
function normalizeColumnName(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[　]/g, ''); // 全角空白を削除
}

/**
 * 行から値を取得（カラム名のバリエーションに対応）
 */
function getRowValue(
  row: Record<string, string | undefined>,
  possibleKeys: string[]
): string | undefined {
  // まず正確なキーで検索
  for (const key of possibleKeys) {
    if (row[key] !== undefined) {
      return row[key];
    }
  }
  
  // 正規化したキーで検索
  const normalizedRow: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(row)) {
    normalizedRow[normalizeColumnName(key)] = value;
  }
  
  for (const key of possibleKeys) {
    const normalizedKey = normalizeColumnName(key);
    if (normalizedRow[normalizedKey] !== undefined) {
      return normalizedRow[normalizedKey];
    }
  }
  
  return undefined;
}

/**
 * 行を正規化
 */
export function normalizeRow(row: Record<string, string | undefined>): NormalizedQA | null {
  // カラム名のバリエーションに対応
  const question = String(
    getRowValue(row, ['question', 'Question', '質問', 'q', 'Q']) || ''
  ).trim();
  const answer = String(
    getRowValue(row, ['answer', 'Answer', '回答', 'a', 'A']) || ''
  ).trim();
  const category = getRowValue(row, ['category', 'Category', 'カテゴリ', 'カテゴリー'])?.trim();
  const keywords = getRowValue(row, ['keywords', 'Keywords', 'キーワード'])?.trim();
  const enabled = parseEnabled(
    getRowValue(row, ['enabled', 'Enabled', '有効', 'enable'])
  );

  // 必須フィールドチェック
  if (!question || !answer) {
    return null;
  }

  // enabled=false の場合は除外
  if (!enabled) {
    return null;
  }

  return {
    question,
    answer,
    category: category || undefined,
    keywords: keywords || undefined,
  };
}

/**
 * 複数行を正規化してフィルタ
 */
export function normalizeRows(rows: Record<string, string | undefined>[]): NormalizedQA[] {
  const normalized: NormalizedQA[] = [];
  let skippedEmpty = 0;
  let skippedDisabled = 0;
  
  // 最初の数行のサンプルを表示
  const sampleCount = Math.min(5, rows.length);
  if (sampleCount > 0) {
    console.log(`Sample rows (first ${sampleCount}):`);
    for (let i = 0; i < sampleCount; i++) {
      const row = rows[i];
      const question = String(
        getRowValue(row, ['question', 'Question', '質問', 'q', 'Q']) || ''
      ).trim();
      const answer = String(
        getRowValue(row, ['answer', 'Answer', '回答', 'a', 'A']) || ''
      ).trim();
      console.log(`  Row ${i + 1}:`, {
        keys: Object.keys(row),
        question: question || '(empty)',
        answer: answer || '(empty)',
      });
    }
  }
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const question = String(
      getRowValue(row, ['question', 'Question', '質問', 'q', 'Q']) || ''
    ).trim();
    const answer = String(
      getRowValue(row, ['answer', 'Answer', '回答', 'a', 'A']) || ''
    ).trim();
    const enabled = parseEnabled(
      getRowValue(row, ['enabled', 'Enabled', '有効', 'enable'])
    );
    
    // 空のquestionまたはanswerをチェック
    if (!question || !answer) {
      skippedEmpty++;
      if (skippedEmpty <= 10) {
        console.log(`Skipped row ${i + 1}: empty question or answer`, {
          keys: Object.keys(row),
          question: question || '(empty)',
          answer: answer || '(empty)',
        });
      }
      continue;
    }
    
    // enabled=falseをチェック
    if (!enabled) {
      skippedDisabled++;
      continue;
    }
    
    // 正規化して追加
    const normalizedRow = normalizeRow(row);
    if (normalizedRow) {
      normalized.push(normalizedRow);
    }
  }
  
  console.log(`\nNormalization summary:`);
  console.log(`  Total rows: ${rows.length}`);
  console.log(`  Valid rows: ${normalized.length}`);
  console.log(`  Skipped (empty question/answer): ${skippedEmpty}`);
  console.log(`  Skipped (disabled): ${skippedDisabled}`);
  
  return normalized;
}



