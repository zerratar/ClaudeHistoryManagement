import fs from 'node:fs';
import path from 'node:path';
import { projectsDir, assertInside, backupsRoot } from './paths';
import { atomicReplace } from './jsonl';
import type { SaveResult } from '../shared/types';

function memFile(projectDir: string, name: string): string {
  const mdir = assertInside(projectsDir(), path.join(projectsDir(), projectDir, 'memory'));
  if (!name.endsWith('.md')) throw new Error('Memory files must be .md');
  return assertInside(mdir, path.join(mdir, name));
}

export async function readMemory(projectDir: string, name: string): Promise<string> {
  return fs.promises.readFile(memFile(projectDir, name), 'utf8');
}

export async function writeMemory(projectDir: string, name: string, content: string): Promise<SaveResult> {
  const f = memFile(projectDir, name);
  let backupPath: string | undefined;
  if (fs.existsSync(f)) {
    const dir = path.join(backupsRoot(), projectDir, 'memory');
    await fs.promises.mkdir(dir, { recursive: true });
    backupPath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}__${name}`);
    await fs.promises.copyFile(f, backupPath);
  }
  await fs.promises.mkdir(path.dirname(f), { recursive: true });
  const tmp = `${f}.chm-tmp`;
  await fs.promises.writeFile(tmp, content, 'utf8');
  await atomicReplace(tmp, f);
  return { ok: true, backupPath };
}
