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
 * 行を正規化
 */
export function normalizeRow(row: Record<string, string | undefined>): NormalizedQA | null {
  const question = String(row.question || '').trim();
  const answer = String(row.answer || '').trim();
  const enabled = parseEnabled(row.enabled);

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
    category: row.category?.trim() || undefined,
    keywords: row.keywords?.trim() || undefined,
  };
}

/**
 * 複数行を正規化してフィルタ
 */
export function normalizeRows(rows: Record<string, string | undefined>[]): NormalizedQA[] {
  const normalized: NormalizedQA[] = [];
  for (const row of rows) {
    const normalizedRow = normalizeRow(row);
    if (normalizedRow) {
      normalized.push(normalizedRow);
    }
  }
  return normalized;
}


