import * as fs from 'fs';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';

type HandoffRecord = {
  enabled: boolean;
  updatedAt: string; // ISO
  updatedBy?: string; // groupId/userId etc
  reason?: string;
  displayName?: string; // last known display name
};

type HandoffState = Record<string, HandoffRecord>;

const STATE_PATH = path.join(process.cwd(), 'data', 'handoff_state.json');
const LOCK_OPTIONS = {
  stale: 10000, // ロックが10秒以上古い場合は無効とみなす
  retries: {
    retries: 5,
    minTimeout: 100,
    maxTimeout: 1000,
  },
};

function ensureDataDir() {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureStateFile() {
  ensureDataDir();
  if (!fs.existsSync(STATE_PATH)) {
    fs.writeFileSync(STATE_PATH, '{}', 'utf-8');
  }
}

function loadStateUnsafe(): HandoffState {
  try {
    if (!fs.existsSync(STATE_PATH)) return {};
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as HandoffState;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch (e) {
    console.warn('Failed to load handoff_state.json, falling back to empty:', e);
    return {};
  }
}

function saveStateUnsafe(state: HandoffState) {
  ensureDataDir();
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, STATE_PATH);
}

/**
 * ファイルロック付きで状態を更新する
 */
async function withLock<T>(fn: (state: HandoffState) => { newState: HandoffState; result: T }): Promise<T> {
  ensureStateFile();

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(STATE_PATH, LOCK_OPTIONS);
    const state = loadStateUnsafe();
    const { newState, result } = fn(state);
    saveStateUnsafe(newState);
    return result;
  } finally {
    if (release) {
      await release();
    }
  }
}

/**
 * ファイルロック付きで状態を読み取る（変更なし）
 */
async function withLockRead<T>(fn: (state: HandoffState) => T): Promise<T> {
  ensureStateFile();

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(STATE_PATH, LOCK_OPTIONS);
    const state = loadStateUnsafe();
    return fn(state);
  } finally {
    if (release) {
      await release();
    }
  }
}

// 同期版（後方互換性のため、ロックなしで読み取り専用）
export function isHandoffEnabled(userId: string | undefined): boolean {
  if (!userId) return false;
  const state = loadStateUnsafe();
  return Boolean(state[userId]?.enabled);
}

export function getHandoffRecord(userId: string | undefined): HandoffRecord | null {
  if (!userId) return null;
  const state = loadStateUnsafe();
  return state[userId] || null;
}

export function getDisplayName(userId: string | undefined): string | null {
  if (!userId) return null;
  const rec = getHandoffRecord(userId);
  return rec?.displayName || null;
}

export function listHandoffUsers(): Array<{ userId: string; record: HandoffRecord }> {
  const state = loadStateUnsafe();
  return Object.entries(state).map(([userId, record]) => ({ userId, record }));
}

export function listHandoffEnabledUsers(): Array<{ userId: string; record: HandoffRecord }> {
  return listHandoffUsers().filter((x) => x.record.enabled);
}

export function listHandoffDisabledUsers(): Array<{ userId: string; record: HandoffRecord }> {
  return listHandoffUsers().filter((x) => !x.record.enabled);
}

// 非同期版（ファイルロック付き、書き込み操作用）
export async function setHandoffEnabledAsync(params: {
  userId: string;
  enabled: boolean;
  updatedBy?: string;
  reason?: string;
  displayName?: string;
}): Promise<void> {
  await withLock((state) => {
    const prev = state[params.userId];
    state[params.userId] = {
      enabled: params.enabled,
      updatedAt: new Date().toISOString(),
      updatedBy: params.updatedBy,
      reason: params.reason,
      displayName: params.displayName ?? prev?.displayName,
    };
    return { newState: state, result: undefined };
  });
}

export async function trackUserActivityAsync(params: { userId: string; displayName?: string }): Promise<void> {
  await withLock((state) => {
    const prev = state[params.userId];

    if (prev) {
      // 既存ユーザー: displayNameのみ更新（enabled状態は変更しない）
      if (params.displayName && params.displayName !== prev.displayName) {
        state[params.userId] = {
          ...prev,
          displayName: params.displayName,
          updatedAt: new Date().toISOString(),
        };
      }
    } else {
      // 新規ユーザー: enabled: false で追加
      state[params.userId] = {
        enabled: false,
        updatedAt: new Date().toISOString(),
        updatedBy: params.userId,
        reason: 'user_activity',
        displayName: params.displayName,
      };
    }
    return { newState: state, result: undefined };
  });
}

// 後方互換性のための同期版（内部でロックなし、軽量な操作用）
export function setHandoffEnabled(params: {
  userId: string;
  enabled: boolean;
  updatedBy?: string;
  reason?: string;
  displayName?: string;
}) {
  // 非同期版を呼び出すが、awaitせずに実行（後方互換性）
  // 重要な操作は setHandoffEnabledAsync を直接使用することを推奨
  setHandoffEnabledAsync(params).catch((e) => {
    console.error('Failed to set handoff enabled:', e);
  });
}

export function trackUserActivity(params: { userId: string; displayName?: string }) {
  // 非同期版を呼び出すが、awaitせずに実行（後方互換性）
  trackUserActivityAsync(params).catch((e) => {
    console.error('Failed to track user activity:', e);
  });
}
