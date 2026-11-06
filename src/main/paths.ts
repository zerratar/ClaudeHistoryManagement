import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function projectsDir(): string {
  return path.join(claudeDir(), 'projects');
}

/** Directories where the Claude desktop app keeps its own session metadata (titles etc). */
export function desktopSessionDirs(): string[] {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const candidates: string[] = [];
  const dataRoot = path.join(local, 'Claude-Data');
  try {
    for (const d of fs.readdirSync(dataRoot)) candidates.push(path.join(dataRoot, d, 'claude-code-sessions'));
  } catch { /* not present */ }
  candidates.push(path.join(roaming, 'Claude', 'claude-code-sessions'));
  return candidates.filter((p) => fs.existsSync(p));
}

export function backupsRoot(): string {
  const dir = path.join(app.getPath('userData'), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Same rule Claude Code uses to name a project folder after its working directory. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Ensure a path is inside a root (prevents writing outside ~/.claude by crafted names). */
export function assertInside(root: string, p: string): string {
  const r = path.resolve(root);
  const full = path.resolve(p);
  const rel = path.relative(r, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path escapes ${r}: ${p}`);
  return full;
}
