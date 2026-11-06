import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { iterLines, lighten, atomicReplace, isBlankLine } from './jsonl';
import { backupsRoot, projectsDir } from './paths';
import { liveSessionIds } from './scanner';
import { makeReplacer, replaceDeep } from './replace';
import { makeApplier, newProblems, type ApplyPlan } from './integrity';
import type {
  LoadedSession, LightRecord, SessionStats, SessionIssue, SaveRequest, SaveResult, BackupInfo,
  PathPair, ReplaceOptions, ReplacePreview, ApiRequestView, ChangeReport,
} from '../shared/types';

const LIGHT_LIMIT = 2000;
const MAX_BACKUPS_PER_SESSION = 25;

interface FileIndex {
  size: number;
  mtimeMs: number;
  starts: number[];
  lens: number[];
  blobs: Map<string, number>;
  requests: Map<string, number>;
}

const indexes = new Map<string, FileIndex>();

function sessionIdOf(file: string): string {
  return path.basename(file, '.jsonl');
}

/** Only allow touching files under ~/.claude/projects. */
function checkFile(file: string): string {
  const full = path.resolve(file);
  const rel = path.relative(path.resolve(projectsDir()), full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Refusing to access a file outside ~/.claude/projects');
  if (!full.endsWith('.jsonl')) throw new Error('Not a .jsonl transcript');
  return full;
}

// Only what the transcript view renders goes to the UI; the editor always loads full records from disk.
const UI_KEYS = new Set([
  'type', 'uuid', 'parentUuid', 'timestamp', 'isMeta', 'isCompactSummary', 'isVisibleInTranscriptOnly', 'isSidechain',
  'message', 'attachment', 'subtype', 'content', 'level', 'stopReason', 'hookCount', 'params', 'keep', 'tail', 'id',
  'hash', 'customTitle', 'aiTitle', 'agentName', 'operation', 'lastPrompt', 'trackingPath', 'toolUseID', 'mode',
]);

function slimForUi(o: any, t: string, truncated: string[]): any {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return lighten(o, LIGHT_LIMIT, '', truncated);
  const out: any = {};
  for (const k of Object.keys(o)) {
    if (!UI_KEYS.has(k)) continue;
    const v = o[k];
    if (k === 'message' && v && typeof v === 'object') {
      const m: any = {};
      for (const mk of ['role', 'model', 'id', 'stop_reason', 'content']) if (mk in v) m[mk] = v[mk];
      if (v.usage) m.usage = { input_tokens: v.usage.input_tokens, output_tokens: v.usage.output_tokens, cache_read_input_tokens: v.usage.cache_read_input_tokens, cache_creation_input_tokens: v.usage.cache_creation_input_tokens };
      out.message = lighten(m, t === 'api-request-blob' ? 200 : LIGHT_LIMIT, 'message', truncated);
    } else if (k === 'attachment' || k === 'params') {
      out[k] = lighten(v, 400, k, truncated);
    } else {
      out[k] = lighten(v, LIGHT_LIMIT, k, truncated);
    }
  }
  return out;
}

export async function loadSession(fileIn: string, onProgress?: (f: number) => void): Promise<LoadedSession> {
  const file = checkFile(fileIn);
  const st = await fs.promises.stat(file);
  const records: LightRecord[] = [];
  const idx: FileIndex = { size: st.size, mtimeMs: st.mtimeMs, starts: [], lens: [], blobs: new Map(), requests: new Map() };
  const stats: SessionStats = {
    records: 0, user: 0, assistant: 0, toolUses: 0, outputTokens: 0, lastContextTokens: 0,
    models: [], cwds: [], branches: [], versions: [], apiRequests: 0,
  };
  const issues: SessionIssue[] = [];
  const models = new Set<string>(), cwds = new Set<string>(), branches = new Set<string>(), versions = new Set<string>();
  const seenMsgIds = new Set<string>();
  const toolUses = new Map<string, number>();
  const toolResults = new Map<string, number>();
  const uuids = new Set<string>();
  const parentRefs: [number, string][] = [];

  for await (const line of iterLines(file, onProgress)) {
    idx.starts.push(line.start);
    idx.lens.push(line.buf.length);
    if (isBlankLine(line.buf)) {
      records.push({ i: line.i, type: '(blank)', data: null, truncated: [], bytes: line.buf.length });
      continue;
    }
    let o: any;
    try {
      o = JSON.parse(line.buf.toString('utf8'));
    } catch (err: any) {
      records.push({ i: line.i, type: '(invalid)', data: line.buf.toString('utf8', 0, Math.min(line.buf.length, 2000)), truncated: [], bytes: line.buf.length, parseError: String(err?.message || err) });
      issues.push({ level: 'error', i: line.i, message: `Line ${line.i + 1} is not valid JSON` });
      continue;
    }
    const t = typeof o?.type === 'string' ? o.type : '(untyped)';
    if (t === 'api-request-blob' && o.hash) idx.blobs.set(o.hash, line.i);
    if (t === 'api-request' && o.id) { idx.requests.set(o.id, line.i); stats.apiRequests++; }
    if (o.uuid) uuids.add(o.uuid);
    if (o.parentUuid) parentRefs.push([line.i, o.parentUuid]);
    if (o.cwd) cwds.add(o.cwd);
    if (o.gitBranch) branches.add(o.gitBranch);
    if (o.version) versions.add(o.version);
    if (t === 'user') stats.user++;
    if (t === 'assistant') {
      stats.assistant++;
      const m = o.message;
      if (m?.model && m.model !== '<synthetic>') models.add(m.model);
      if (m?.id && m.usage && !seenMsgIds.has(m.id)) {
        seenMsgIds.add(m.id);
        stats.outputTokens += m.usage.output_tokens || 0;
        stats.lastContextTokens = (m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
      }
    }
    const content = o.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_use' && b.id) { toolUses.set(b.id, line.i); stats.toolUses++; }
        if (b?.type === 'tool_result' && b.tool_use_id) toolResults.set(b.tool_use_id, line.i);
      }
    }
    const truncated: string[] = [];
    const data = slimForUi(o, t, truncated);
    records.push({ i: line.i, type: t, uuid: o.uuid, parentUuid: o.parentUuid, ts: o.timestamp, data, truncated, bytes: line.buf.length });
  }
  stats.records = records.length;
  stats.models = [...models];
  stats.cwds = [...cwds];
  stats.branches = [...branches];
  stats.versions = [...versions];

  const orphanUses = [...toolUses.entries()].filter(([id]) => !toolResults.has(id));
  // The very last tool call may legitimately still be waiting for its result.
  const lastUse = orphanUses.length ? orphanUses[orphanUses.length - 1] : undefined;
  const realOrphanUses = orphanUses.filter((e) => e !== lastUse || e[1] < records.length - 3);
  if (realOrphanUses.length) issues.push({ level: 'warn', i: realOrphanUses[0][1], message: `${realOrphanUses.length} tool call(s) have no matching tool result (the API rejects a resumed conversation like that unless it was interrupted)` });
  const orphanResults = [...toolResults.entries()].filter(([id]) => !toolUses.has(id));
  if (orphanResults.length) issues.push({ level: 'warn', i: orphanResults[0][1], message: `${orphanResults.length} tool result(s) reference a tool call that is not in this file` });
  const brokenParents = parentRefs.filter(([, p]) => !uuids.has(p));
  if (brokenParents.length) issues.push({ level: 'warn', i: brokenParents[0][0], message: `${brokenParents.length} record(s) point to a parent that is not in this file (normal after /compact or for forked sessions)` });

  indexes.set(file, idx);

  const subagents: LoadedSession['subagents'] = [];
  const subDir = path.join(path.dirname(file), sessionIdOf(file), 'subagents');
  try {
    for (const n of fs.readdirSync(subDir)) {
      if (!n.endsWith('.jsonl')) continue;
      const id = n.slice(0, -6);
      let meta: any = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(subDir, `${id}.meta.json`), 'utf8')); } catch { /* none */ }
      subagents.push({ file: path.join(subDir, n), id, description: meta.description, agentType: meta.agentType, toolUseId: meta.toolUseId });
    }
  } catch { /* none */ }

  return {
    file, id: sessionIdOf(file), size: st.size, mtimeMs: st.mtimeMs, records, stats, issues,
    live: liveSessionIds().has(sessionIdOf(file)), subagents,
  };
}

async function ensureIndex(file: string): Promise<FileIndex> {
  const st = await fs.promises.stat(file);
  const idx = indexes.get(file);
  if (idx && idx.size === st.size && idx.mtimeMs === st.mtimeMs) return idx;
  const fresh: FileIndex = { size: st.size, mtimeMs: st.mtimeMs, starts: [], lens: [], blobs: new Map(), requests: new Map() };
  for await (const line of iterLines(file)) {
    fresh.starts.push(line.start);
    fresh.lens.push(line.buf.length);
    if (line.buf.length < 400000 && (line.buf.includes('"api-request'))) {
      try {
        const o = JSON.parse(line.buf.toString('utf8'));
        if (o.type === 'api-request-blob') fresh.blobs.set(o.hash, line.i);
        if (o.type === 'api-request') fresh.requests.set(o.id, line.i);
      } catch { /* ignore */ }
    }
  }
  indexes.set(file, fresh);
  return fresh;
}

async function readLine(file: string, idx: FileIndex, i: number): Promise<string> {
  if (i < 0 || i >= idx.starts.length) throw new Error(`Line ${i} out of range`);
  const fd = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(idx.lens[i]);
    await fd.read(buf, 0, buf.length, idx.starts[i]);
    return buf.toString('utf8');
  } finally {
    await fd.close();
  }
}

export async function getRecord(fileIn: string, i: number): Promise<{ json: string; data: any }> {
  const file = checkFile(fileIn);
  const idx = await ensureIndex(file);
  const json = await readLine(file, idx, i);
  let data: any = null;
  try { data = JSON.parse(json); } catch { /* invalid line */ }
  return { json, data };
}

// ---------------------------------------------------------------- backups

function backupDirFor(file: string): string {
  const project = path.basename(path.dirname(file));
  const rel = path.relative(projectsDir(), file).replace(/\.jsonl$/, '');
  const safe = rel.split(/[\\/]+/).join('__');
  return path.join(backupsRoot(), project, safe);
}

export async function makeBackup(file: string, label: string): Promise<string> {
  const dir = backupDirFor(file);
  await fs.promises.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `${stamp}__${label.replace(/[^a-z0-9-]/gi, '_').slice(0, 40)}.jsonl`);
  await fs.promises.copyFile(file, target);
  // prune
  const all = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - MAX_BACKUPS_PER_SESSION))) {
    try { await fs.promises.unlink(path.join(dir, old)); } catch { /* ignore */ }
  }
  return target;
}

export async function listBackups(fileIn: string): Promise<BackupInfo[]> {
  const file = checkFile(fileIn);
  const dir = backupDirFor(file);
  let names: string[] = [];
  try { names = await fs.promises.readdir(dir); } catch { return []; }
  const out: BackupInfo[] = [];
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const p = path.join(dir, n);
    const st = await fs.promises.stat(p);
    // copyFile keeps the source mtime on Windows, so the time comes from the file name.
    const iso = n.split('__')[0].replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, 'T$1:$2:$3.$4Z');
    const t = Date.parse(iso);
    out.push({ path: p, createdAt: isNaN(t) ? st.mtimeMs : t, size: st.size, label: n.split('__')[1]?.replace(/\.jsonl$/, '').replace(/_/g, ' ') || '' });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function restoreBackup(fileIn: string, backupPath: string): Promise<SaveResult> {
  const file = checkFile(fileIn);
  const dir = backupDirFor(file);
  const rel = path.relative(dir, path.resolve(backupPath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: 'Backup does not belong to this session' };
  const backup = fs.existsSync(file) ? await makeBackup(file, 'before-restore') : undefined;
  const tmp = `${file}.chm-tmp`;
  await fs.promises.copyFile(backupPath, tmp);
  await atomicReplace(tmp, file);
  indexes.delete(file);
  return { ok: true, backupPath: backup };
}

// ---------------------------------------------------------------- saving

async function checkExpected(file: string, expected: { size: number; mtimeMs: number }, force?: boolean): Promise<SaveResult | null> {
  const st = await fs.promises.stat(file);
  if (!force && (st.size !== expected.size || Math.abs(st.mtimeMs - expected.mtimeMs) > 1)) {
    return { ok: false, conflict: true, error: 'The file changed on disk after it was loaded (Claude may still be writing to it). Reload the session and re-apply your edits, or save anyway to overwrite.' };
  }
  return null;
}

type Applier = ReturnType<typeof makeApplier>;

function reportOf(a: Applier, plan: ApplyPlan): ChangeReport {
  const { added, existing } = newProblems(a.before, a.after);
  const fc = a.stats.firstChange;
  let affected = a.stats.thinkingBlocksRemoved;
  if (!plan.stripThinking && fc !== null) {
    for (const st of a.after) {
      if (st.i >= fc && st.type === 'assistant') affected += st.blocks.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking').length;
    }
  }
  return {
    problems: added,
    existingProblems: existing,
    firstChange: fc,
    changedLines: a.stats.changedLines,
    replacements: a.stats.replacements,
    thinkingBlocksRemoved: a.stats.thinkingBlocksRemoved,
    thinkingBlocksAffected: affected,
  };
}

/** Run the plan without writing anything. */
async function dryRun(file: string, plan: ApplyPlan): Promise<ChangeReport> {
  const a = makeApplier(plan);
  for await (const line of iterLines(file)) a.process(line.i, line.buf);
  return reportOf(a, plan);
}

/**
 * Stream the file through the plan into a temp file, then validate. The original is only
 * backed up and replaced if the result introduces no conversation errors (or they are accepted).
 */
async function writePlan(file: string, plan: ApplyPlan, opts: { acceptProblems?: boolean; backupLabel: string }): Promise<SaveResult> {
  const a = makeApplier(plan);
  const tmp = `${file}.chm-tmp`;
  const out = await fs.promises.open(tmp, 'w');
  const abort = async () => { try { await fs.promises.unlink(tmp); } catch { /* ignore */ } };
  try {
    const pending: Buffer[] = [];
    let pendingBytes = 0;
    const nl = Buffer.from('\n');
    const flush = async () => {
      if (!pendingBytes) return;
      await out.write(Buffer.concat(pending, pendingBytes));
      pending.length = 0;
      pendingBytes = 0;
    };
    for await (const line of iterLines(file)) {
      const res = a.process(line.i, line.buf);
      if (res === null) continue;
      const b = typeof res === 'string' ? Buffer.from(res, 'utf8') : res;
      pending.push(b, nl);
      pendingBytes += b.length + 1;
      if (pendingBytes > 4 * 1024 * 1024) await flush();
    }
    await flush();
    await out.sync();
  } catch (err) {
    await out.close();
    await abort();
    throw err;
  }
  await out.close();
  const report = reportOf(a, plan);
  if (!opts.acceptProblems && report.problems.some((p) => p.level === 'error')) {
    await abort();
    return { ok: false, error: 'This change would leave the conversation in a state the API rejects on resume. Nothing was written.', report };
  }
  if (report.changedLines === 0) {
    await abort();
    return { ok: true, changedLines: 0, report };
  }
  const backupPath = await makeBackup(file, opts.backupLabel);
  await atomicReplace(tmp, file);
  indexes.delete(file);
  return { ok: true, backupPath, changedLines: report.changedLines, report };
}

function planFromRequest(req: SaveRequest): ApplyPlan | string {
  const edits = new Map<number, any>();
  for (const e of req.edits) {
    try { edits.set(e.i, JSON.parse(e.json)); } catch (err: any) {
      return `Edit for line ${e.i + 1} is not valid JSON: ${err?.message || err}`;
    }
  }
  return { edits, deletes: new Set(req.deletes), stripThinking: !!req.stripThinking };
}

export async function checkSave(req: SaveRequest): Promise<ChangeReport> {
  const file = checkFile(req.file);
  const plan = planFromRequest(req);
  if (typeof plan === 'string') throw new Error(plan);
  return dryRun(file, plan);
}

export async function saveSession(req: SaveRequest): Promise<SaveResult> {
  const file = checkFile(req.file);
  const conflict = await checkExpected(file, req.expected, req.force);
  if (conflict) return conflict;
  const plan = planFromRequest(req);
  if (typeof plan === 'string') return { ok: false, error: plan };
  return writePlan(file, plan, { acceptProblems: req.acceptProblems, backupLabel: 'before-edit' });
}

export async function forkSession(fileIn: string, upto: number, title: string): Promise<{ ok: boolean; file?: string; id?: string; error?: string }> {
  const file = checkFile(fileIn);
  const newId = crypto.randomUUID();
  const oldId = sessionIdOf(file);
  const target = path.join(path.dirname(file), `${newId}.jsonl`);
  const out = await fs.promises.open(target, 'wx');
  try {
    for await (const line of iterLines(file)) {
      if (line.i > upto) break;
      let s = line.buf.toString('utf8');
      try {
        const o = JSON.parse(s);
        if (o && o.sessionId === oldId) { o.sessionId = newId; s = JSON.stringify(o); }
        // drop stale titles from the source; we add our own below
        if (o && (o.type === 'custom-title' || o.type === 'ai-title' || o.type === 'agent-name')) continue;
      } catch { /* keep raw */ }
      await out.write(s + '\n');
    }
    await out.write(JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: newId }) + '\n');
    await out.sync();
  } finally {
    await out.close();
  }
  return { ok: true, file: target, id: newId };
}

// ---------------------------------------------------------------- find & replace

function replacePlan(pairs: PathPair[], options: ReplaceOptions): ApplyPlan {
  return {
    replacer: makeReplacer(pairs, options),
    replaceLines: options.onlyLines ? new Set(options.onlyLines) : undefined,
    stripThinking: !!options.stripThinking,
  };
}

export async function previewReplace(fileIn: string, pairs: PathPair[], options: ReplaceOptions): Promise<ReplacePreview> {
  const file = checkFile(fileIn);
  const plan = replacePlan(pairs, options);
  const res: ReplacePreview = { linesAffected: 0, occurrences: 0, samples: [] };
  const r = plan.replacer!;
  if (!r.active) return res;
  const a = makeApplier(plan);
  for await (const line of iterLines(file)) {
    a.process(line.i, line.buf);
    if (plan.replaceLines && !plan.replaceLines.has(line.i)) continue;
    const s = line.buf.toString('utf8');
    if (!r.mightMatch(s)) continue;
    let o: any;
    try { o = JSON.parse(s); } catch { continue; }
    const [no, n] = replaceDeep(o, r);
    if (!n) continue;
    res.linesAffected++;
    res.occurrences += n;
    if (res.samples.length < 12) {
      const before = JSON.stringify(o);
      const after = JSON.stringify(no);
      let k = 0;
      while (k < before.length && before[k] === after[k]) k++;
      const from = Math.max(0, k - 60);
      res.samples.push({ i: line.i, before: before.slice(from, k + 120), after: after.slice(from, k + 120) });
    }
  }
  res.report = reportOf(a, plan);
  return res;
}

export async function applyReplace(fileIn: string, pairs: PathPair[], options: ReplaceOptions, expected: { size: number; mtimeMs: number }): Promise<SaveResult> {
  const file = checkFile(fileIn);
  const conflict = await checkExpected(file, expected);
  if (conflict) return conflict;
  const plan = replacePlan(pairs, options);
  if (!plan.replacer!.active) return { ok: false, error: 'Nothing to replace' };
  return writePlan(file, plan, { backupLabel: 'before-replace' });
}

// ---------------------------------------------------------------- API request reconstruction

/** JSON with sorted keys and no whitespace – the form Claude Code hashes request messages in. */
function stableStringify(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

type MsgRef = { lines: number[]; strip: string[]; textify?: boolean };
const msgHashCache = new Map<string, { key: string; map: Map<string, MsgRef> }>();

/**
 * Request logs only store "extra" messages as blobs; ordinary user/assistant messages are referenced by
 * the hash of the message as sent. Build hash -> transcript lines for those.
 */
async function transcriptMessageHashes(file: string, idx: FileIndex): Promise<Map<string, MsgRef>> {
  const key = `${idx.size}:${idx.mtimeMs}`;
  const cached = msgHashCache.get(file);
  if (cached && cached.key === key) return cached.map;
  const map = new Map<string, MsgRef>();
  const groups = new Map<string, { lines: number[]; blocks: any[] }>();
  const stripVariants = [[], ['caller'], ['caller', 'signature']];
  const strip = (b: any, keys: string[]) => {
    if (!keys.length || !b || typeof b !== 'object') return b;
    const o: any = {};
    for (const k of Object.keys(b)) if (!keys.includes(k)) o[k] = b[k];
    return o;
  };
  for await (const line of iterLines(file)) {
    const head = line.buf.subarray(0, 400).toString('utf8');
    if (!head.includes('"type":"user"') && !head.includes('"type":"assistant"') && !line.buf.includes('"type":"user"') && !line.buf.includes('"type":"assistant"')) continue;
    let o: any;
    try { o = JSON.parse(line.buf.toString('utf8')); } catch { continue; }
    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      map.set(sha256(stableStringify({ role: 'user', content: c })), { lines: [line.i], strip: [] });
      if (typeof c === 'string') map.set(sha256(stableStringify({ role: 'user', content: [{ type: 'text', text: c }] })), { lines: [line.i], strip: [], textify: true });
    } else if (o.type === 'assistant' && o.message?.id && Array.isArray(o.message.content)) {
      const g = groups.get(o.message.id) || { lines: [], blocks: [] };
      g.lines.push(line.i);
      g.blocks.push(...o.message.content);
      groups.set(o.message.id, g);
    }
  }
  for (const g of groups.values()) {
    for (const keys of stripVariants) {
      map.set(sha256(stableStringify({ role: 'assistant', content: g.blocks.map((b) => strip(b, keys)) })), { lines: g.lines, strip: keys });
    }
  }
  msgHashCache.set(file, { key, map });
  return map;
}

export async function getApiRequest(fileIn: string, id: string): Promise<ApiRequestView> {
  const file = checkFile(fileIn);
  const idx = await ensureIndex(file);
  const blobCache = new Map<string, any>();
  let missing = 0;
  let msgHashes: Map<string, MsgRef> | null = null;
  const blob = async (hash: string) => {
    if (blobCache.has(hash)) return blobCache.get(hash);
    const i = idx.blobs.get(hash);
    let m: any = { role: '?', content: [{ type: 'text', text: `[message ${hash.slice(0, 12)}… not found in this file]` }] };
    if (i !== undefined) {
      try { m = { ...JSON.parse(await readLine(file, idx, i)).message, _injected: true }; } catch { /* keep placeholder */ }
    } else {
      msgHashes = msgHashes || (await transcriptMessageHashes(file, idx));
      const ref = msgHashes.get(hash);
      if (ref) {
        const recs = await Promise.all(ref.lines.map(async (l) => JSON.parse(await readLine(file, idx, l))));
        if (recs[0].type === 'user') {
          const c = recs[0].message.content;
          m = { role: 'user', content: ref.textify && typeof c === 'string' ? [{ type: 'text', text: c }] : c, _fromLine: ref.lines[0] };
        } else {
          m = { role: 'assistant', content: recs.flatMap((r) => r.message.content), _fromLine: ref.lines[0] };
        }
      } else missing++;
    }
    blobCache.set(hash, m);
    return m;
  };
  const memo = new Map<string, any[]>();
  const messagesOf = async (reqId: string, depth: number): Promise<{ msgs: any[]; req: any }> => {
    const i = idx.requests.get(reqId);
    if (i === undefined) throw new Error(`API request ${reqId} not found`);
    const req = JSON.parse(await readLine(file, idx, i));
    if (memo.has(reqId)) return { msgs: memo.get(reqId)!, req };
    let base: any[] = [];
    if (req.base && depth < 2000) {
      try { base = (await messagesOf(req.base, depth + 1)).msgs; } catch { missing++; }
    }
    const msgs = base.slice(0, req.keep ?? 0);
    for (const h of req.tail || []) msgs.push(await blob(h));
    memo.set(reqId, msgs);
    return { msgs, req };
  };
  const { msgs, req } = await messagesOf(id, 0);
  const truncated: string[] = [];
  return { id, timestamp: req.timestamp, params: req.params, messages: lighten(msgs, 20000, '', truncated), missingBlobs: missing };
}
