// Works out everything that has to go together when something is deleted, so a delete
// can never leave a tool call without its result (or the other way round).
import type { LightRecord } from '../shared/types';
import { prettyToolName, resultText, toolSummary } from './util';

export type RemovalMode = 'only' | 'exchange' | 'to-end';

export interface RemovalTarget {
  i: number;
  /** a single content block; undefined = the whole record */
  block?: number;
}

export interface RemovalItem {
  i: number;
  label: string;
  /** pulled in because it is linked to something you chose */
  linked: boolean;
  /** only some blocks of the record are removed */
  partial: boolean;
}

export interface RemovalPlan {
  whole: number[];
  partial: Map<number, number[]>;
  items: RemovalItem[];
  linkedCount: number;
}

/** Records that are part of the conversation chain. Titles, logs and bookkeeping are left alone. */
const CHAIN_TYPES = new Set(['user', 'assistant', 'attachment', 'system']);

export function isRealPrompt(r: LightRecord): boolean {
  if (r.type !== 'user' || r.data?.isMeta || r.data?.isCompactSummary) return false;
  const c = r.data?.message?.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && c.some((b: any) => b?.type !== 'tool_result');
}

function contentOf(r: LightRecord): any[] | null {
  const c = r.data?.message?.content;
  return Array.isArray(c) ? c : null;
}

function describe(r: LightRecord, block?: number): string {
  const c = r.data?.message?.content;
  const short = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 90);
  if (r.type === 'user') {
    if (typeof c === 'string') return `Prompt: ${short(c)}`;
    const blocks = Array.isArray(c) ? (block !== undefined ? [c[block]] : c) : [];
    const res = blocks.find((b: any) => b?.type === 'tool_result');
    if (res) return `Tool result: ${short(resultText(res.content)) || '(empty)'}`;
    const t = blocks.find((b: any) => b?.type === 'text');
    return t ? `Prompt: ${short(t.text)}` : 'User message';
  }
  if (r.type === 'assistant' && Array.isArray(c)) {
    const blocks = block !== undefined ? [c[block]] : c;
    const b = blocks[0];
    if (b?.type === 'tool_use') return `Tool call: ${prettyToolName(b.name)} ${short(toolSummary(b.name, b.input))}`;
    if (b?.type === 'thinking' || b?.type === 'redacted_thinking') return 'Thinking';
    if (b?.type === 'text') return `Reply: ${short(b.text)}`;
    return `Assistant ${b?.type ?? ''}`;
  }
  if (r.type === 'attachment') return `Injected context: ${r.data?.attachment?.type ?? ''}`;
  if (r.type === 'system') return `System record: ${r.data?.subtype ?? ''}`;
  return r.type;
}

export function planRemoval(records: LightRecord[], alreadyDeleted: Set<number>, target: RemovalTarget, mode: RemovalMode): RemovalPlan {
  const sel = new Map<number, Set<number> | 'all'>();
  const direct = new Set<number>();
  const add = (i: number, block?: number) => {
    if (alreadyDeleted.has(i)) return false;
    const cur = sel.get(i);
    if (cur === 'all') return false;
    if (block === undefined) { sel.set(i, 'all'); return true; }
    const set = cur ?? new Set<number>();
    if (set.has(block)) return false;
    set.add(block);
    sel.set(i, set);
    return true;
  };

  if (mode === 'only') {
    add(target.i, target.block);
    direct.add(target.i);
  } else {
    let end = records.length;
    if (mode === 'exchange') {
      for (let k = target.i + 1; k < records.length; k++) {
        if (isRealPrompt(records[k]) && !records[k].data?.isSidechain) { end = k; break; }
      }
    }
    for (let k = target.i; k < end; k++) {
      if (k === target.i || CHAIN_TYPES.has(records[k].type)) { add(k); direct.add(k); }
    }
  }

  // Link closure: tool calls and their results always go together.
  const useAt = new Map<string, [number, number]>();
  const resultAt = new Map<string, [number, number]>();
  for (const r of records) {
    const c = contentOf(r);
    if (!c) continue;
    c.forEach((b: any, k: number) => {
      if (b?.type === 'tool_use' && b.id) useAt.set(b.id, [r.i, k]);
      if (b?.type === 'tool_result' && b.tool_use_id) resultAt.set(b.tool_use_id, [r.i, k]);
    });
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [i, s] of [...sel.entries()]) {
      const c = contentOf(records[i]);
      if (!c) continue;
      const idxs = s === 'all' ? c.map((_, k) => k) : [...s];
      for (const k of idxs) {
        const b = c[k];
        const partner = b?.type === 'tool_use' ? resultAt.get(b.id) : b?.type === 'tool_result' ? useAt.get(b.tool_use_id) : undefined;
        if (partner && add(partner[0], partner[1])) changed = true;
      }
    }
  }

  const whole: number[] = [];
  const partial = new Map<number, number[]>();
  const items: RemovalItem[] = [];
  let linkedCount = 0;
  for (const i of [...sel.keys()].sort((a, b) => a - b)) {
    const s = sel.get(i)!;
    const c = contentOf(records[i]);
    const isWhole = s === 'all' || !c || s.size >= c.length;
    const linked = !direct.has(i);
    if (linked) linkedCount++;
    if (isWhole) whole.push(i);
    else partial.set(i, [...(s as Set<number>)].sort((a, b) => b - a));
    items.push({ i, label: describe(records[i], isWhole ? undefined : [...(s as Set<number>)][0]), linked, partial: !isWhole });
  }
  return { whole, partial, items, linkedCount };
}
