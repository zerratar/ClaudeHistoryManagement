import fs from 'node:fs';
import path from 'node:path';
import { projectsDir, desktopSessionDirs } from './paths';
import type { ProjectSummary, SessionSummary } from '../shared/types';

interface DesktopMeta {
  title?: string;
  sessionId: string;
  cwd?: string;
  model?: string;
  isArchived?: boolean;
}

const HEAD_BYTES = 192 * 1024;
const TAIL_BYTES = 768 * 1024;

const summaryCache = new Map<string, { key: string; summary: SessionSummary }>();

function readSlice(fd: number, start: number, length: number): string {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, start);
  return buf.toString('utf8', 0, n);
}

function safeParse(line: string): any | undefined {
  try { return JSON.parse(line); } catch { return undefined; }
}

export function loadDesktopMeta(): Map<string, DesktopMeta> {
  const map = new Map<string, DesktopMeta>();
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && /^local_.*\.json$/.test(e.name)) {
        try {
          const o = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (o.cliSessionId) map.set(o.cliSessionId, { title: o.title, sessionId: o.sessionId, cwd: o.cwd, model: o.model, isArchived: o.isArchived });
        } catch { /* ignore */ }
      }
    }
  };
  for (const d of desktopSessionDirs()) walk(d, 0);
  return map;
}

/** Session ids of Claude Code processes that are currently running. */
export function liveSessionIds(): Set<string> {
  const set = new Set<string>();
  const dir = path.join(path.dirname(projectsDir()), 'sessions');
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return set; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (!o.sessionId || !o.pid) continue;
      try { process.kill(o.pid, 0); set.add(o.sessionId); } catch (err: any) { if (err?.code === 'EPERM') set.add(o.sessionId); }
    } catch { /* ignore */ }
  }
  return set;
}

function textOfUserContent(content: any): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const b of content) if (b?.type === 'text' && typeof b.text === 'string') return b.text;
  }
  return undefined;
}

function isRealPrompt(t: string | undefined): t is string {
  if (!t) return false;
  const s = t.trimStart();
  return !(s.startsWith('<') || s.startsWith('Caveat:') || s.startsWith('[Request interrupted'));
}

export function summarizeSession(file: string, projectDirName: string, desktop: Map<string, DesktopMeta>, live: Set<string>): SessionSummary {
  const st = fs.statSync(file);
  const id = path.basename(file, '.jsonl');
  const key = `${st.size}:${st.mtimeMs}`;
  const cached = summaryCache.get(file);
  let s: SessionSummary;
  if (cached && cached.key === key) {
    s = { ...cached.summary };
  } else {
    s = {
      id, file, projectDir: projectDirName, title: '', titleSource: 'none', size: st.size, mtimeMs: st.mtimeMs,
      hasSidecar: false, subagentCount: 0, live: false,
    };
    const fd = fs.openSync(file, 'r');
    try {
      const head = readSlice(fd, 0, Math.min(HEAD_BYTES, st.size));
      const headLines = head.split('\n');
      if (st.size > HEAD_BYTES) headLines.pop();
      let custom: string | undefined, ai: string | undefined, agent: string | undefined;
      const scanTitles = (o: any) => {
        if (o.type === 'custom-title' && o.customTitle) custom = o.customTitle;
        else if (o.type === 'ai-title' && o.aiTitle) ai = o.aiTitle;
        else if (o.type === 'agent-name' && o.agentName) agent = o.agentName;
      };
      for (const line of headLines) {
        if (!line) continue;
        const o = safeParse(line);
        if (!o) continue;
        if (!s.cwd && o.cwd) s.cwd = o.cwd;
        if (!s.gitBranch && o.gitBranch) s.gitBranch = o.gitBranch;
        if (!s.createdAt && o.timestamp) s.createdAt = o.timestamp;
        if (!s.firstPrompt && o.type === 'user' && !o.isMeta) {
          const t = textOfUserContent(o.message?.content);
          if (isRealPrompt(t)) s.firstPrompt = t.slice(0, 300);
        }
        scanTitles(o);
      }
      if (st.size > HEAD_BYTES) {
        const start = Math.max(HEAD_BYTES, st.size - TAIL_BYTES);
        const tail = readSlice(fd, start, st.size - start);
        const lines = tail.split('\n');
        lines.shift();
        for (const line of lines) {
          if (!line || line.length > 4000) {
            if (line && !s.model) { /* fallthrough below */ }
            continue;
          }
          if (line.includes('"custom-title"') || line.includes('"ai-title"') || line.includes('"agent-name"')) {
            const o = safeParse(line);
            if (o) scanTitles(o);
          }
        }
        const m = tail.match(/"model":"(claude-[a-z0-9.\-]+)"/g);
        if (m) s.model = m[m.length - 1].slice(9, -1);
      } else {
        const m = head.match(/"model":"(claude-[a-z0-9.\-]+)"/g);
        if (m) s.model = m[m.length - 1].slice(9, -1);
      }
      if (custom) { s.title = custom; s.titleSource = 'custom'; }
      else if (agent) { s.title = agent; s.titleSource = 'agent'; }
      else if (ai) { s.title = ai; s.titleSource = 'ai'; }
      else if (s.firstPrompt) { s.title = s.firstPrompt.split('\n')[0].slice(0, 80); s.titleSource = 'prompt'; }
      else { s.title = id.slice(0, 8); s.titleSource = 'none'; }
    } finally {
      fs.closeSync(fd);
    }
    const side = path.join(path.dirname(file), id);
    if (fs.existsSync(side)) {
      s.hasSidecar = true;
      try { s.subagentCount = fs.readdirSync(path.join(side, 'subagents')).filter((n) => n.endsWith('.jsonl')).length; } catch { /* none */ }
    }
    summaryCache.set(file, { key, summary: { ...s } });
  }
  const d = desktop.get(id);
  if (d) {
    s.desktopSessionId = d.sessionId;
    if (d.title) { s.title = d.title; s.titleSource = 'desktop'; }
    if (!s.cwd && d.cwd) s.cwd = d.cwd;
    if (d.model) s.model = d.model;
  }
  s.live = live.has(id);
  return s;
}

function prettyProjectName(dirName: string, cwd?: string): string {
  if (cwd) {
    const parts = cwd.split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || cwd;
  }
  return dirName;
}

export function listProjects(): ProjectSummary[] {
  const root = projectsDir();
  let dirs: fs.Dirent[] = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const desktop = loadDesktopMeta();
  const live = liveSessionIds();
  const projects: ProjectSummary[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const pdir = path.join(root, d.name);
    let files: string[] = [];
    try { files = fs.readdirSync(pdir); } catch { continue; }
    const sessions: SessionSummary[] = [];
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      try { sessions.push(summarizeSession(path.join(pdir, f), d.name, desktop, live)); } catch { /* unreadable */ }
    }
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let memoryFiles: string[] = [];
    try { memoryFiles = fs.readdirSync(path.join(pdir, 'memory')).filter((n) => n.endsWith('.md')).sort((a, b) => (a === 'MEMORY.md' ? -1 : b === 'MEMORY.md' ? 1 : a.localeCompare(b))); } catch { /* none */ }
    const cwd = sessions.find((s) => s.cwd)?.cwd;
    const isScratch = /scratch/i.test(d.name) && /AppData/i.test(d.name);
    projects.push({
      dirName: d.name,
      path: pdir,
      cwd,
      displayName: isScratch ? 'Scratch workspace' : prettyProjectName(d.name, cwd),
      kind: isScratch ? 'scratch' : 'code',
      sessions,
      memoryFiles,
      lastActivity: sessions.reduce((m, s) => Math.max(m, s.mtimeMs), 0),
      totalSize: sessions.reduce((m, s) => m + s.size, 0),
    });
  }
  projects.sort((a, b) => b.lastActivity - a.lastActivity);
  return projects;
}
