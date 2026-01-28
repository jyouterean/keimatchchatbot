/**
 * データバックアップスクリプト
 * data/ディレクトリの重要ファイルをバックアップする
 *
 * 使用方法:
 *   npm run backup              # バックアップを作成
 *   npm run backup -- --list    # バックアップ一覧を表示
 *   npm run backup -- --restore # 最新のバックアップから復元
 */

import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const BACKUP_DIR = path.join(process.cwd(), 'backups');
const MAX_BACKUPS = 10; // 保持する最大バックアップ数

// バックアップ対象ファイル
const BACKUP_FILES = ['handoff_state.json', 'qa_raw.json', 'qa_index.json'];

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    console.log(`Created backup directory: ${BACKUP_DIR}`);
  }
}

function getBackupTimestamp(): string {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -5);
}

function createBackup() {
  ensureBackupDir();

  const timestamp = getBackupTimestamp();
  const backupSubDir = path.join(BACKUP_DIR, `backup_${timestamp}`);

  fs.mkdirSync(backupSubDir, { recursive: true });

  let backedUpCount = 0;

  for (const file of BACKUP_FILES) {
    const srcPath = path.join(DATA_DIR, file);
    const destPath = path.join(backupSubDir, file);

    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      const stats = fs.statSync(srcPath);
      console.log(`✓ Backed up: ${file} (${formatBytes(stats.size)})`);
      backedUpCount++;
    } else {
      console.log(`- Skipped (not found): ${file}`);
    }
  }

  // メタデータファイルを作成
  const metadata = {
    createdAt: new Date().toISOString(),
    files: BACKUP_FILES.filter((f) => fs.existsSync(path.join(DATA_DIR, f))),
    totalSize: getTotalSize(backupSubDir),
  };

  fs.writeFileSync(path.join(backupSubDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

  console.log(`\nBackup completed: ${backupSubDir}`);
  console.log(`Total files backed up: ${backedUpCount}`);

  // 古いバックアップを削除
  cleanupOldBackups();
}

function listBackups() {
  ensureBackupDir();

  const backups = fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => name.startsWith('backup_'))
    .sort()
    .reverse();

  if (backups.length === 0) {
    console.log('No backups found.');
    return;
  }

  console.log('Available backups:');
  console.log('==================');

  for (const backup of backups) {
    const metadataPath = path.join(BACKUP_DIR, backup, 'metadata.json');
    let info = '';

    if (fs.existsSync(metadataPath)) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      info = ` - ${metadata.files.length} files, ${formatBytes(metadata.totalSize)}`;
    }

    console.log(`  ${backup}${info}`);
  }
}

function restoreBackup(backupName?: string) {
  ensureBackupDir();

  // バックアップ名が指定されていない場合は最新を使用
  if (!backupName) {
    const backups = fs
      .readdirSync(BACKUP_DIR)
      .filter((name) => name.startsWith('backup_'))
      .sort()
      .reverse();

    if (backups.length === 0) {
      console.error('No backups found to restore.');
      process.exit(1);
    }

    backupName = backups[0];
  }

  const backupPath = path.join(BACKUP_DIR, backupName);

  if (!fs.existsSync(backupPath)) {
    console.error(`Backup not found: ${backupName}`);
    process.exit(1);
  }

  console.log(`Restoring from: ${backupName}`);

  // data/ディレクトリが存在しない場合は作成
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  let restoredCount = 0;

  for (const file of BACKUP_FILES) {
    const srcPath = path.join(backupPath, file);
    const destPath = path.join(DATA_DIR, file);

    if (fs.existsSync(srcPath)) {
      // 既存ファイルがある場合はバックアップ
      if (fs.existsSync(destPath)) {
        const tempBackup = `${destPath}.before-restore`;
        fs.copyFileSync(destPath, tempBackup);
      }

      fs.copyFileSync(srcPath, destPath);
      console.log(`✓ Restored: ${file}`);
      restoredCount++;
    }
  }

  console.log(`\nRestore completed: ${restoredCount} files restored`);
}

function cleanupOldBackups() {
  const backups = fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => name.startsWith('backup_'))
    .sort()
    .reverse();

  if (backups.length <= MAX_BACKUPS) {
    return;
  }

  const toDelete = backups.slice(MAX_BACKUPS);

  for (const backup of toDelete) {
    const backupPath = path.join(BACKUP_DIR, backup);
    fs.rmSync(backupPath, { recursive: true });
    console.log(`Deleted old backup: ${backup}`);
  }
}

function getTotalSize(dir: string): number {
  let total = 0;

  for (const file of fs.readdirSync(dir)) {
    const filePath = path.join(dir, file);
    const stats = fs.statSync(filePath);

    if (stats.isFile()) {
      total += stats.size;
    }
  }

  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// メイン処理
const args = process.argv.slice(2);

if (args.includes('--list')) {
  listBackups();
} else if (args.includes('--restore')) {
  const backupIndex = args.indexOf('--restore');
  const backupName = args[backupIndex + 1];
  restoreBackup(backupName);
} else {
  createBackup();
}
