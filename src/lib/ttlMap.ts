/**
 * TTL（Time To Live）付きのMapクラス
 * 一定時間経過したエントリを自動的に削除する
 */
export class TTLMap<K, V> {
  private map = new Map<K, { value: V; expiresAt: number }>();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly ttlMs: number;
  private readonly cleanupIntervalMs: number;

  constructor(options: { ttlMs: number; cleanupIntervalMs?: number }) {
    this.ttlMs = options.ttlMs;
    this.cleanupIntervalMs = options.cleanupIntervalMs || Math.min(options.ttlMs, 60000);
    this.startCleanup();
  }

  private startCleanup() {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.cleanupIntervalMs);
    // Node.jsのタイマーがプロセス終了を妨げないようにする
    this.cleanupInterval.unref();
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.map.entries()) {
      if (entry.expiresAt < now) {
        this.map.delete(key);
      }
    }
  }

  set(key: K, value: V, customTtlMs?: number): void {
    const ttl = customTtlMs ?? this.ttlMs;
    this.map.set(key, {
      value,
      expiresAt: Date.now() + ttl,
    });
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /**
   * TTLをリセットして値を更新
   */
  refresh(key: K, value?: V): void {
    const existing = this.get(key);
    if (existing !== undefined || value !== undefined) {
      this.set(key, value ?? existing!);
    }
  }

  /**
   * エントリ数を取得
   */
  get size(): number {
    this.cleanup();
    return this.map.size;
  }

  /**
   * 全エントリをイテレート（期限切れは除外）
   */
  *entries(): IterableIterator<[K, V]> {
    const now = Date.now();
    for (const [key, entry] of this.map.entries()) {
      if (entry.expiresAt >= now) {
        yield [key, entry.value];
      }
    }
  }

  /**
   * 全キーをイテレート（期限切れは除外）
   */
  *keys(): IterableIterator<K> {
    for (const [key] of this.entries()) {
      yield key;
    }
  }

  /**
   * 全値をイテレート（期限切れは除外）
   */
  *values(): IterableIterator<V> {
    for (const [, value] of this.entries()) {
      yield value;
    }
  }

  /**
   * クリーンアップを停止（シャットダウン時に呼び出し）
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * メモリ使用量の概算を取得（デバッグ用）
   */
  getStats(): { size: number; ttlMs: number } {
    return {
      size: this.size,
      ttlMs: this.ttlMs,
    };
  }
}

/**
 * TTL付きの配列値を持つMapクラス
 * メッセージ履歴などの配列データ用
 */
export class TTLArrayMap<K, V> {
  private map = new Map<K, { values: V[]; expiresAt: number }>();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly ttlMs: number;
  private readonly maxItems: number;
  private readonly cleanupIntervalMs: number;

  constructor(options: { ttlMs: number; maxItems: number; cleanupIntervalMs?: number }) {
    this.ttlMs = options.ttlMs;
    this.maxItems = options.maxItems;
    this.cleanupIntervalMs = options.cleanupIntervalMs || Math.min(options.ttlMs, 60000);
    this.startCleanup();
  }

  private startCleanup() {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.cleanupIntervalMs);
    this.cleanupInterval.unref();
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.map.entries()) {
      if (entry.expiresAt < now) {
        this.map.delete(key);
      }
    }
  }

  push(key: K, value: V): void {
    const existing = this.map.get(key);
    const now = Date.now();

    if (existing && existing.expiresAt >= now) {
      existing.values.push(value);
      // 最大件数を超えたら古いものを削除
      while (existing.values.length > this.maxItems) {
        existing.values.shift();
      }
      existing.expiresAt = now + this.ttlMs; // TTLをリセット
    } else {
      this.map.set(key, {
        values: [value],
        expiresAt: now + this.ttlMs,
      });
    }
  }

  get(key: K): V[] | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.values;
  }

  set(key: K, values: V[]): void {
    const trimmed = values.slice(-this.maxItems);
    this.map.set(key, {
      values: trimmed,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    this.cleanup();
    return this.map.size;
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  getStats(): { size: number; ttlMs: number; maxItems: number } {
    return {
      size: this.size,
      ttlMs: this.ttlMs,
      maxItems: this.maxItems,
    };
  }
}
