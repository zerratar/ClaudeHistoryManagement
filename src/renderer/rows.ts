import type { LightRecord } from '../shared/types';

export type Row =
  | { kind: 'user'; key: string; rec: LightRecord; meta: boolean }
  | { kind: 'text'; key: string; rec: LightRecord; block: number }
  | { kind: 'thinking'; key: string; rec: LightRecord; block: number }
  | { kind: 'tool'; key: string; rec: LightRecord; block: number; result?: { rec: LightRecord; block: number } }
  | { kind: 'orphan-result'; key: string; rec: LightRecord; block: number }
  | { kind: 'meta'; key: string; rec: LightRecord }
  | { kind: 'raw'; key: string; rec: LightRecord };

export interface ViewOptions {
  showThinking: boolean;
  showMeta: boolean;
  rawMode: boolean;
}

const CONVERSATION_TYPES = new Set(['user', 'assistant']);

export function buildRows(records: LightRecord[], opts: ViewOptions): Row[] {
  if (opts.rawMode) return records.map((rec) => ({ kind: 'raw', key: `r${rec.i}`, rec }));

  // tool_use id -> where its result lives
  const results = new Map<string, { rec: LightRecord; block: number }>();
  for (const rec of records) {
    if (rec.type !== 'user') continue;
    const c = rec.data?.message?.content;
    if (!Array.isArray(c)) continue;
    c.forEach((b: any, k: number) => {
      if (b?.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, { rec, block: k });
    });
  }
  const usedResults = new Set<string>();
  const rows: Row[] = [];
  for (const rec of records) {
    const d = rec.data;
    if (!CONVERSATION_TYPES.has(rec.type)) {
      if (opts.showMeta || rec.parseError) rows.push({ kind: 'meta', key: `m${rec.i}`, rec });
      continue;
    }
    const content = d?.message?.content;
    if (rec.type === 'assistant') {
      if (!Array.isArray(content)) {
        rows.push({ kind: 'text', key: `t${rec.i}`, rec, block: -1 });
        continue;
      }
      content.forEach((b: any, k: number) => {
        if (b?.type === 'tool_use') {
          const result = results.get(b.id);
          if (result) usedResults.add(`${result.rec.i}:${result.block}`);
          rows.push({ kind: 'tool', key: `u${rec.i}:${k}`, rec, block: k, result });
        } else if (b?.type === 'thinking' || b?.type === 'redacted_thinking') {
          if (opts.showThinking) rows.push({ kind: 'thinking', key: `h${rec.i}:${k}`, rec, block: k });
        } else {
          rows.push({ kind: 'text', key: `t${rec.i}:${k}`, rec, block: k });
        }
      });
      continue;
    }
    // user
    const isMeta = !!d?.isMeta || !!d?.isCompactSummary || !!d?.isVisibleInTranscriptOnly;
    if (Array.isArray(content)) {
      const nonResult = content.some((b: any) => b?.type !== 'tool_result');
      if (nonResult) {
        if (!isMeta || opts.showMeta) rows.push({ kind: 'user', key: `p${rec.i}`, rec, meta: isMeta });
      }
      content.forEach((b: any, k: number) => {
        if (b?.type === 'tool_result' && !results.has(b.tool_use_id)) {
          rows.push({ kind: 'orphan-result', key: `o${rec.i}:${k}`, rec, block: k });
        }
      });
    } else if (!isMeta || opts.showMeta || d?.isCompactSummary) {
      rows.push({ kind: 'user', key: `p${rec.i}`, rec, meta: isMeta });
    }
  }
  // Results whose tool_use is not in this file show up as orphans; anything paired but
  // placed before its call (shouldn't happen) is still reachable through the call.
  void usedResults;
  return rows;
}

/** Records referenced by a row (for search / selection). */
export function rowRecords(row: Row): number[] {
  if (row.kind === 'tool' && row.result) return [row.rec.i, row.result.rec.i];
  return [row.rec.i];
}
