// Applies edits to a transcript in one streaming pass and checks that the result is still a
// conversation the API accepts.
//
// Two rules matter when resuming an edited transcript:
//  1. Every tool_use must be answered by a tool_result in the next user turn, and every
//     tool_result must answer a tool_use from the turn right before it.
//  2. A thinking block's signature binds the whole conversation before it (system prompt,
//     tools, every earlier message) and chains to the previous thinking block. Changing
//     anything sent to the model invalidates every later thinking block. Removing those later
//     blocks (keeping text and tool calls) is the documented recovery.
import type { Replacer } from './replace';
import { replaceDeep } from './replace';
import type { IntegrityProblem } from '../shared/types';

/** Record types whose content is sent to the model. */
const SENT_TYPES = new Set(['user', 'assistant', 'attachment']);

export interface Struct {
  i: number;
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sidechain: boolean;
  /** content block summary for user/assistant records */
  blocks: { type: string; id?: string; toolUseId?: string }[];
  emptyContent: boolean;
  meta: boolean;
}

export function structOf(o: any, i: number): Struct | null {
  if (!o || typeof o !== 'object' || typeof o.type !== 'string') return null;
  const c = o.message?.content;
  const blocks: Struct['blocks'] = [];
  if (Array.isArray(c)) {
    for (const b of c) blocks.push({ type: b?.type ?? '?', id: b?.type === 'tool_use' ? b.id : undefined, toolUseId: b?.type === 'tool_result' ? b.tool_use_id : undefined });
  } else if (typeof c === 'string') {
    blocks.push({ type: 'text' });
  }
  const isConv = o.type === 'user' || o.type === 'assistant';
  return {
    i,
    type: o.type,
    uuid: o.uuid,
    parentUuid: o.parentUuid,
    sidechain: !!o.isSidechain,
    blocks,
    emptyContent: isConv && (c == null || (Array.isArray(c) && c.length === 0) || (typeof c === 'string' && c.length === 0)),
    meta: !!o.isMeta,
  };
}

/** Compare only what the model sees. Metadata such as cwd or timestamps does not count. */
export function sentDiffers(a: any, b: any): boolean {
  if (!a || !b || !SENT_TYPES.has(a.type)) return a?.type !== b?.type && SENT_TYPES.has(b?.type);
  if (a.type !== b.type) return true;
  if (a.type === 'attachment') return JSON.stringify(a.attachment) !== JSON.stringify(b.attachment);
  return JSON.stringify(a.message?.content) !== JSON.stringify(b.message?.content);
}

export interface ApplyPlan {
  edits?: Map<number, any>;
  deletes?: Set<number>;
  replacer?: Replacer;
  /** only run the replacer on these lines */
  replaceLines?: Set<number>;
  /** remove thinking blocks from the first change onward */
  stripThinking?: boolean;
}

export interface ApplyStats {
  firstChange: number | null;
  changedLines: number;
  replacements: number;
  thinkingBlocksRemoved: number;
  thinkingRecordsRemoved: number;
}

const PARENT_RE = /"(?:parentUuid|logicalParentUuid)":"([0-9a-fA-F-]{36})"/g;

/**
 * Stateful line transformer. Lines must be fed in file order (parents come before children,
 * which lets deleted records be re-linked in a single pass).
 */
export function makeApplier(plan: ApplyPlan) {
  const edits = plan.edits ?? new Map<number, any>();
  const deletes = plan.deletes ?? new Set<number>();
  const gone = new Map<string, string | null>();
  const stats: ApplyStats = { firstChange: null, changedLines: 0, replacements: 0, thinkingBlocksRemoved: 0, thinkingRecordsRemoved: 0 };
  const before: Struct[] = [];
  const after: Struct[] = [];

  const markChange = (i: number) => { if (stats.firstChange === null) stats.firstChange = i; };
  const resolve = (u: string | null | undefined): string | null => {
    let cur = u ?? null;
    const guard = new Set<string>();
    while (cur && gone.has(cur) && !guard.has(cur)) { guard.add(cur); cur = gone.get(cur)!; }
    return cur;
  };
  const relink = (o: any): boolean => {
    let touched = false;
    for (const key of ['parentUuid', 'logicalParentUuid']) {
      if (o && typeof o[key] === 'string' && gone.has(o[key])) { o[key] = resolve(o[key]); touched = true; }
    }
    return touched;
  };
  const mightReferenceGone = (s: string): boolean => {
    if (!gone.size) return false;
    PARENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PARENT_RE.exec(s))) if (gone.has(m[1])) return true;
    return false;
  };

  /** returns null to drop the line, the same Buffer to keep it byte-identical, or new text */
  function process(i: number, buf: Buffer): Buffer | string | null {
    const s = buf.toString('utf8');
    let o: any;
    try { o = JSON.parse(s); } catch {
      // Unparseable lines are kept verbatim unless explicitly deleted.
      if (deletes.has(i)) { stats.changedLines++; return null; }
      return buf;
    }
    const orig = structOf(o, i);
    if (orig) before.push(orig);

    if (deletes.has(i)) {
      if (o?.uuid) gone.set(o.uuid, resolve(o.parentUuid ?? null));
      if (SENT_TYPES.has(o?.type)) markChange(i);
      stats.changedLines++;
      return null;
    }

    let n = edits.has(i) ? edits.get(i) : o;
    let modified = edits.has(i);
    if (plan.replacer?.active && (!plan.replaceLines || plan.replaceLines.has(i)) && plan.replacer.mightMatch(s)) {
      const [r, cnt] = replaceDeep(n, plan.replacer);
      if (cnt) { n = r; modified = true; stats.replacements += cnt; }
    }
    if (modified && sentDiffers(o, n)) markChange(i);

    if (mightReferenceGone(modified ? JSON.stringify(n) : s)) {
      if (!modified) n = JSON.parse(s);
      if (relink(n)) modified = true;
    }

    if (plan.stripThinking && stats.firstChange !== null && n?.type === 'assistant' && Array.isArray(n.message?.content)) {
      const c: any[] = n.message.content;
      const kept = c.filter((b) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking');
      if (kept.length !== c.length) {
        stats.thinkingBlocksRemoved += c.length - kept.length;
        if (!kept.length) {
          if (n.uuid) gone.set(n.uuid, resolve(n.parentUuid ?? null));
          stats.thinkingRecordsRemoved++;
          stats.changedLines++;
          return null;
        }
        if (!modified) n = JSON.parse(s);
        n.message.content = n.message.content.filter((b: any) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking');
        modified = true;
      }
    }

    const next = structOf(n, i);
    if (next) after.push(next);
    if (!modified) return buf;
    stats.changedLines++;
    return JSON.stringify(n);
  }

  return { process, stats, before, after };
}

// ---------------------------------------------------------------- validation

interface Turn { role: 'user' | 'assistant'; recs: Struct[] }

/** The records Claude Code would send when resuming: the parentUuid chain ending at the last message. */
function activeChain(structs: Struct[]): Struct[] {
  const byUuid = new Map<string, Struct>();
  for (const s of structs) if (s.uuid) byUuid.set(s.uuid, s);
  let leaf: Struct | undefined;
  for (let k = structs.length - 1; k >= 0; k--) {
    const s = structs[k];
    if ((s.type === 'user' || s.type === 'assistant') && !s.sidechain && s.uuid) { leaf = s; break; }
  }
  if (!leaf) return [];
  const onChain = new Set<string>();
  let cur: Struct | undefined = leaf;
  while (cur && cur.uuid && !onChain.has(cur.uuid)) {
    onChain.add(cur.uuid);
    cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined;
  }
  // Parallel tool calls: Claude Code hangs each tool result off its own tool call, so all but
  // the last result sit on side branches (sometimes written several records later). They are
  // still sent, paired with their call, so place each right after the call it answers.
  const keyed: { s: Struct; key: number }[] = [];
  for (const s of structs) {
    if (!s.uuid) continue;
    if (onChain.has(s.uuid)) { keyed.push({ s, key: s.i }); continue; }
    if (s.type === 'user' && !s.sidechain && s.parentUuid && onChain.has(s.parentUuid) && s.blocks.some((b) => b.toolUseId)) {
      const parent = byUuid.get(s.parentUuid)!;
      keyed.push({ s, key: parent.i + 0.5 + s.i * 1e-9 });
    }
  }
  return keyed.sort((a, b) => a.key - b.key).map((k) => k.s);
}

function turnsOf(chain: Struct[]): Turn[] {
  const turns: Turn[] = [];
  for (const s of chain) {
    let role: 'user' | 'assistant' | null = null;
    if (s.type === 'assistant') role = 'assistant';
    else if (s.type === 'user' || s.type === 'attachment') role = 'user';
    if (!role) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.recs.push(s);
    else turns.push({ role, recs: [s] });
  }
  return turns;
}

export function validate(structs: Struct[]): IntegrityProblem[] {
  const problems: IntegrityProblem[] = [];
  const chain = activeChain(structs);
  const turns = turnsOf(chain);

  for (const s of chain) {
    if (s.emptyContent) problems.push({ key: `empty:${s.uuid}`, level: 'error', i: s.i, message: `Line ${s.i + 1}: ${s.type} message has no content` });
  }
  const firstReal = turns.find((t) => t.recs.some((r) => r.type !== 'attachment'));
  if (firstReal && firstReal.role === 'assistant') {
    problems.push({ key: 'first-assistant', level: 'error', i: firstReal.recs[0].i, message: 'The conversation starts with an assistant message; the API requires it to start with a user message' });
  }

  turns.forEach((t, k) => {
    if (t.role !== 'assistant') return;
    const uses = t.recs.flatMap((r) => r.blocks.filter((b) => b.type === 'tool_use' && b.id).map((b) => ({ id: b.id!, i: r.i })));
    if (!uses.length) return;
    const next = turns[k + 1];
    const answered = new Set(next ? next.recs.flatMap((r) => r.blocks.filter((b) => b.toolUseId).map((b) => b.toolUseId!)) : []);
    for (const u of uses) {
      if (answered.has(u.id)) continue;
      if (!next) {
        problems.push({ key: `pending:${u.id}`, level: 'warn', i: u.i, message: `Line ${u.i + 1}: the last tool call has no result (fine if the session was interrupted there)` });
      } else {
        problems.push({ key: `use-no-result:${u.id}`, level: 'error', i: u.i, message: `Line ${u.i + 1}: tool call ${u.id.slice(-8)} has no result right after it` });
      }
    }
  });
  turns.forEach((t, k) => {
    if (t.role !== 'user') return;
    const prev = turns[k - 1];
    const calls = new Set(prev && prev.role === 'assistant' ? prev.recs.flatMap((r) => r.blocks.filter((b) => b.id).map((b) => b.id!)) : []);
    for (const r of t.recs) {
      for (const b of r.blocks) {
        if (b.toolUseId && !calls.has(b.toolUseId)) {
          problems.push({ key: `result-no-use:${b.toolUseId}`, level: 'error', i: r.i, message: `Line ${r.i + 1}: tool result ${b.toolUseId.slice(-8)} does not answer a tool call in the turn before it` });
        }
      }
    }
  });
  return problems;
}

/** Problems present after the change that were not there before. */
export function newProblems(before: Struct[], after: Struct[]): { added: IntegrityProblem[]; existing: number } {
  const old = validate(before);
  const oldKeys = new Set(old.map((p) => p.key));
  const now = validate(after);
  return { added: now.filter((p) => !oldKeys.has(p.key)), existing: old.length };
}
