import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { projectsDir, claudeDir, encodeProjectDir, assertInside } from './paths';
import { makeReplacer, type Replacer } from './replace';
import { makeApplier } from './integrity';
import { listProjects } from './scanner';
import { atomicReplace } from './jsonl';
import type { BundleManifest, ExportRequest, ImportRequest, ImportResult, PathPair } from '../shared/types';

const TEXT_EXT = new Set(['.jsonl', '.json', '.txt', '.md', '.log', '.csv', '.xml', '.yaml', '.yml']);

function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p, base));
    else if (e.isFile()) out.push(path.relative(base, p));
  }
  return out;
}

export function exportBundle(req: ExportRequest, outPath: string): { ok: boolean; path?: string; error?: string } {
  const pdir = assertInside(projectsDir(), path.join(projectsDir(), req.projectDir));
  const project = listProjects().find((p) => p.dirName === req.projectDir);
  const zip = new AdmZip();
  const sessions: BundleManifest['sessions'] = [];
  for (const id of req.sessionIds) {
    const f = path.join(pdir, `${id}.jsonl`);
    if (!fs.existsSync(f)) continue;
    zip.addLocalFile(f, 'sessions');
    if (req.includeSidecars) {
      const side = path.join(pdir, id);
      for (const rel of walkFiles(side)) zip.addLocalFile(path.join(side, rel), path.posix.join('sessions', id, path.dirname(rel).split(path.sep).join('/')));
    }
    const s = project?.sessions.find((x) => x.id === id);
    sessions.push({ id, title: s?.title || id, cwd: s?.cwd, size: fs.statSync(f).size });
  }
  const memoryFiles: string[] = [];
  if (req.includeMemory) {
    const mdir = path.join(pdir, 'memory');
    for (const rel of walkFiles(mdir)) {
      zip.addLocalFile(path.join(mdir, rel), path.posix.join('memory', path.dirname(rel).split(path.sep).join('/')));
      memoryFiles.push(rel.split(path.sep).join('/'));
    }
  }
  const manifest: BundleManifest = {
    format: 'claude-history-bundle',
    version: 1,
    exportedAt: new Date().toISOString(),
    source: { host: os.hostname(), home: os.homedir(), platform: process.platform, claudeDir: claudeDir() },
    project: { dirName: req.projectDir, cwd: project?.cwd, displayName: project?.displayName || req.projectDir },
    sessions,
    includesMemory: req.includeMemory,
    memoryFiles,
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  zip.writeZip(outPath);
  return { ok: true, path: outPath };
}

export function readBundleManifest(zipPath: string): BundleManifest {
  const zip = new AdmZip(zipPath);
  const entry = zip.getEntry('manifest.json');
  if (!entry) throw new Error('Not a Claude history bundle (manifest.json missing)');
  const m = JSON.parse(entry.getData().toString('utf8'));
  if (m.format !== 'claude-history-bundle') throw new Error('Unknown bundle format');
  return m;
}

/** Transform JSONL bytes line by line; lines without a hit stay byte-identical. */
function transformJsonl(buf: Buffer, r: Replacer, idSwap: { from: string; to: string } | null, stripThinking: boolean): { out: Buffer; count: number; thinkingRemoved: number } {
  const parts: Buffer[] = [];
  const nl = Buffer.from([0x0a]);
  const applier = makeApplier({ replacer: r, stripThinking });
  let start = 0;
  let i = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end === -1) end = buf.length;
    let lineBuf = buf.subarray(start, end);
    start = end + 1;
    if (lineBuf.length && lineBuf[lineBuf.length - 1] === 0x0d) lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
    if (!lineBuf.length) { i++; continue; }
    const res = applier.process(i++, lineBuf);
    if (res === null) continue;
    let text = typeof res === 'string' ? res : null;
    if (idSwap) {
      const t = text ?? lineBuf.toString('utf8');
      if (t.includes(idSwap.from)) text = t.split(idSwap.from).join(idSwap.to);
    }
    parts.push(text === null ? lineBuf : Buffer.from(text, 'utf8'), nl);
  }
  return { out: Buffer.concat(parts), count: applier.stats.replacements, thinkingRemoved: applier.stats.thinkingBlocksRemoved };
}

function transformText(buf: Buffer, r: Replacer, idSwap: { from: string; to: string } | null): { out: Buffer; count: number } {
  let s = buf.toString('utf8');
  let n = 0;
  if (r.active) [s, n] = r.replace(s);
  if (idSwap) s = s.split(idSwap.from).join(idSwap.to);
  return { out: Buffer.from(s, 'utf8'), count: n };
}

async function writeAtomic(target: string, data: Buffer) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.chm-tmp`;
  await fs.promises.writeFile(tmp, data);
  await atomicReplace(tmp, target);
}

export async function importBundle(req: ImportRequest): Promise<ImportResult> {
  const result: ImportResult = { ok: true, imported: [], memoryWritten: [], skipped: [] };
  if (!req.targetCwd.trim()) return { ...result, ok: false, error: 'Target working directory is required' };
  const targetDir = assertInside(projectsDir(), path.join(projectsDir(), encodeProjectDir(req.targetCwd.trim())));
  result.targetDir = targetDir;

  // Gather source files: sessions: id -> { jsonl, sidecar: rel -> Buffer }, memory: rel -> Buffer
  type Src = { id: string; jsonl: Buffer; sidecar: Map<string, Buffer> };
  const sources: Src[] = [];
  const memory = new Map<string, Buffer>();
  if (req.bundlePath) {
    const zip = new AdmZip(req.bundlePath);
    const byId = new Map<string, Src>();
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      const name = e.entryName.replace(/\\/g, '/');
      let m = name.match(/^sessions\/([^/]+)\.jsonl$/);
      if (m) {
        const src = byId.get(m[1]) || { id: m[1], jsonl: Buffer.alloc(0), sidecar: new Map() };
        src.jsonl = e.getData();
        byId.set(m[1], src);
        continue;
      }
      m = name.match(/^sessions\/([^/]+)\/(.+)$/);
      if (m) {
        const src = byId.get(m[1]) || { id: m[1], jsonl: Buffer.alloc(0), sidecar: new Map() };
        src.sidecar.set(m[2], e.getData());
        byId.set(m[1], src);
        continue;
      }
      m = name.match(/^memory\/(.+)$/);
      if (m) memory.set(m[1], e.getData());
    }
    sources.push(...[...byId.values()].filter((s) => s.jsonl.length));
  } else if (req.localSource) {
    const pdir = assertInside(projectsDir(), path.join(projectsDir(), req.localSource.projectDir));
    for (const id of req.localSource.sessionIds) {
      const f = path.join(pdir, `${id}.jsonl`);
      if (!fs.existsSync(f)) continue;
      const sidecar = new Map<string, Buffer>();
      const side = path.join(pdir, id);
      for (const rel of walkFiles(side)) sidecar.set(rel.split(path.sep).join('/'), fs.readFileSync(path.join(side, rel)));
      sources.push({ id, jsonl: fs.readFileSync(f), sidecar });
    }
    if (req.includeMemory) {
      const mdir = path.join(pdir, 'memory');
      for (const rel of walkFiles(mdir)) memory.set(rel.split(path.sep).join('/'), fs.readFileSync(path.join(mdir, rel)));
    }
  } else {
    return { ...result, ok: false, error: 'No source given' };
  }

  const r = makeReplacer(req.pairs.filter((p: PathPair) => p.from.trim()), req.options);
  await fs.promises.mkdir(targetDir, { recursive: true });

  for (const src of sources) {
    let newId = src.id;
    const exists = fs.existsSync(path.join(targetDir, `${src.id}.jsonl`));
    if (exists) {
      if (req.conflict === 'skip') { result.skipped.push(src.id); continue; }
      if (req.conflict === 'new-id') newId = crypto.randomUUID();
    }
    const idSwap = newId !== src.id ? { from: src.id, to: newId } : null;
    const strip = !!req.options.stripThinking;
    const { out, count, thinkingRemoved } = transformJsonl(src.jsonl, r, idSwap, strip);
    const target = assertInside(targetDir, path.join(targetDir, `${newId}.jsonl`));
    await writeAtomic(target, out);
    let total = count;
    let thinking = thinkingRemoved;
    for (const [rel, data] of src.sidecar) {
      const ext = path.extname(rel).toLowerCase();
      const relOut = idSwap ? rel.split(idSwap.from).join(idSwap.to) : rel;
      const dest = assertInside(targetDir, path.join(targetDir, newId, relOut));
      if (ext === '.jsonl') { const t = transformJsonl(data, r, idSwap, strip); total += t.count; thinking += t.thinkingRemoved; await writeAtomic(dest, t.out); }
      else if (TEXT_EXT.has(ext)) { const t = transformText(data, r, idSwap); total += t.count; await writeAtomic(dest, t.out); }
      else await writeAtomic(dest, data);
    }
    result.imported.push({ oldId: src.id, newId, file: target, replacements: total, thinkingBlocksRemoved: thinking });
  }

  if (req.includeMemory && memory.size) {
    const mdir = path.join(targetDir, 'memory');
    for (const [rel, data] of memory) {
      const dest = assertInside(mdir, path.join(mdir, rel));
      const { out } = transformText(data, r, null);
      if (fs.existsSync(dest) && !req.overwriteMemory) {
        if (path.basename(rel) === 'MEMORY.md') {
          // merge index lines that are missing
          const cur = fs.readFileSync(dest, 'utf8');
          const add = out.toString('utf8').split(/\r?\n/).filter((l) => l.trim() && !cur.includes(l.trim()));
          if (add.length) {
            await writeAtomic(dest, Buffer.from(cur.replace(/\s*$/, '\n') + add.join('\n') + '\n', 'utf8'));
            result.memoryWritten.push(`${rel} (merged ${add.length} line(s))`);
          }
        } else result.skipped.push(`memory/${rel}`);
        continue;
      }
      await writeAtomic(dest, out);
      result.memoryWritten.push(rel);
    }
  }
  return result;
}
