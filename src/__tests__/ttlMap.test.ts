import { TTLMap, TTLArrayMap } from '../lib/ttlMap';

describe('TTLMap', () => {
  let map: TTLMap<string, number>;

  beforeEach(() => {
    map = new TTLMap<string, number>({ ttlMs: 100, cleanupIntervalMs: 50 });
  });

  afterEach(() => {
    map.destroy();
  });

  it('値を設定して取得できる', () => {
    map.set('key1', 42);
    expect(map.get('key1')).toBe(42);
  });

  it('存在しないキーはundefinedを返す', () => {
    expect(map.get('nonexistent')).toBeUndefined();
  });

  it('hasが正しく動作する', () => {
    map.set('key1', 42);
    expect(map.has('key1')).toBe(true);
    expect(map.has('nonexistent')).toBe(false);
  });

  it('deleteが正しく動作する', () => {
    map.set('key1', 42);
    expect(map.delete('key1')).toBe(true);
    expect(map.get('key1')).toBeUndefined();
    expect(map.delete('nonexistent')).toBe(false);
  });

  it('clearが正しく動作する', () => {
    map.set('key1', 1);
    map.set('key2', 2);
    map.clear();
    expect(map.size).toBe(0);
  });

  it('TTL後にエントリが期限切れになる', async () => {
    map.set('key1', 42);
    expect(map.get('key1')).toBe(42);

    // TTLが経過するまで待機
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(map.get('key1')).toBeUndefined();
  });

  it('カスタムTTLを指定できる', async () => {
    map.set('short', 1, 50);
    map.set('long', 2, 200);

    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(map.get('short')).toBeUndefined();
    expect(map.get('long')).toBe(2);
  });

  it('refreshがTTLをリセットする', async () => {
    map.set('key1', 42);

    await new Promise((resolve) => setTimeout(resolve, 60));
    map.refresh('key1');

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(map.get('key1')).toBe(42); // まだ存在する
  });

  it('sizeが正しい値を返す', () => {
    map.set('key1', 1);
    map.set('key2', 2);
    expect(map.size).toBe(2);
  });

  it('entriesイテレータが正しく動作する', () => {
    map.set('key1', 1);
    map.set('key2', 2);

    const entries = [...map.entries()];
    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual(['key1', 1]);
    expect(entries).toContainEqual(['key2', 2]);
  });

  it('getStatsが正しい情報を返す', () => {
    map.set('key1', 1);
    const stats = map.getStats();
    expect(stats.size).toBe(1);
    expect(stats.ttlMs).toBe(100);
  });
});

describe('TTLArrayMap', () => {
  let map: TTLArrayMap<string, string>;

  beforeEach(() => {
    map = new TTLArrayMap<string, string>({
      ttlMs: 100,
      maxItems: 3,
      cleanupIntervalMs: 50,
    });
  });

  afterEach(() => {
    map.destroy();
  });

  it('pushで値を追加できる', () => {
    map.push('key1', 'a');
    map.push('key1', 'b');
    expect(map.get('key1')).toEqual(['a', 'b']);
  });

  it('maxItemsを超えると古い値が削除される', () => {
    map.push('key1', 'a');
    map.push('key1', 'b');
    map.push('key1', 'c');
    map.push('key1', 'd');
    expect(map.get('key1')).toEqual(['b', 'c', 'd']);
  });

  it('setで配列を直接設定できる', () => {
    map.set('key1', ['x', 'y', 'z']);
    expect(map.get('key1')).toEqual(['x', 'y', 'z']);
  });

  it('setもmaxItemsを超えると切り詰める', () => {
    map.set('key1', ['a', 'b', 'c', 'd', 'e']);
    expect(map.get('key1')).toEqual(['c', 'd', 'e']);
  });

  it('TTL後にエントリが期限切れになる', async () => {
    map.push('key1', 'a');
    expect(map.get('key1')).toEqual(['a']);

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(map.get('key1')).toBeUndefined();
  });

  it('pushがTTLをリセットする', async () => {
    map.push('key1', 'a');

    await new Promise((resolve) => setTimeout(resolve, 60));
    map.push('key1', 'b');

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(map.get('key1')).toEqual(['a', 'b']); // まだ存在する
  });

  it('deleteが正しく動作する', () => {
    map.push('key1', 'a');
    expect(map.delete('key1')).toBe(true);
    expect(map.get('key1')).toBeUndefined();
  });

  it('getStatsが正しい情報を返す', () => {
    map.push('key1', 'a');
    const stats = map.getStats();
    expect(stats.size).toBe(1);
    expect(stats.ttlMs).toBe(100);
    expect(stats.maxItems).toBe(3);
  });
});
