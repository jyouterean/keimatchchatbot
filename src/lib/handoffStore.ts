import * as fs from 'fs';
import * as path from 'path';

type HandoffRecord = {
  enabled: boolean;
  updatedAt: string; // ISO
  updatedBy?: string; // groupId/userId etc
  reason?: string;
  displayName?: string; // last known display name
};

type HandoffState = Record<string, HandoffRecord>;

const STATE_PATH = path.join(process.cwd(), 'data', 'handoff_state.json');

function ensureDataDir() {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadState(): HandoffState {
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

function saveState(state: HandoffState) {
  ensureDataDir();
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, STATE_PATH);
}

export function isHandoffEnabled(userId: string | undefined): boolean {
  if (!userId) return false;
  const state = loadState();
  return Boolean(state[userId]?.enabled);
}

export function setHandoffEnabled(params: {
  userId: string;
  enabled: boolean;
  updatedBy?: string;
  reason?: string;
  displayName?: string;
}) {
  const state = loadState();
  const prev = state[params.userId];
  state[params.userId] = {
    enabled: params.enabled,
    updatedAt: new Date().toISOString(),
    updatedBy: params.updatedBy,
    reason: params.reason,
    displayName: params.displayName ?? prev?.displayName,
  };
  saveState(state);
}

export function getHandoffRecord(userId: string | undefined): HandoffRecord | null {
  if (!userId) return null;
  const state = loadState();
  return state[userId] || null;
}

export function getDisplayName(userId: string | undefined): string | null {
  if (!userId) return null;
  const rec = getHandoffRecord(userId);
  return rec?.displayName || null;
}

export function listHandoffUsers(): Array<{ userId: string; record: HandoffRecord }> {
  const state = loadState();
  return Object.entries(state).map(([userId, record]) => ({ userId, record }));
}

export function listHandoffEnabledUsers(): Array<{ userId: string; record: HandoffRecord }> {
  return listHandoffUsers().filter((x) => x.record.enabled);
}


