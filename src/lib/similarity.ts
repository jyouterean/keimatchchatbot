/**
 * L2正規化（ユークリッドノルムで正規化）
 */
export function l2Normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (norm === 0) return vector;
  return vector.map(val => val / norm);
}

/**
 * ドット積（内積）を計算
 * 両ベクトルがL2正規化済みなら、結果はコサイン類似度になる
 */
export function dotProduct(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  return a.reduce((sum, val, i) => sum + val * b[i], 0);
}

/**
 * TopK検索（スコア降順）
 */
export function topK<T>(
  items: T[],
  scores: number[],
  k: number
): Array<{ item: T; score: number; index: number }> {
  if (items.length !== scores.length) {
    throw new Error('Items and scores length mismatch');
  }

  const indexed = items.map((item, i) => ({
    item,
    score: scores[i],
    index: i,
  }));

  indexed.sort((a, b) => b.score - a.score);

  return indexed.slice(0, k);
}




