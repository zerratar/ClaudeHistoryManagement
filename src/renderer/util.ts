import type { LightRecord } from '../shared/types';

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function relTime(ms: number): string {
  const d = Date.now() - ms;
  const m = Math.round(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function fmtTime(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(+d)) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Text of a tool_result content (string or block array). */
export function resultText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? `[image ${b.source?.media_type || ''}]` : b?.type ? `[${b.type}]` : ''))
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content, null, 2);
}

export function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof input[k] === 'string' && input[k]) return input[k];
    return undefined;
  };
  const short = (s: string) => (s.length > 160 ? s.slice(0, 160) + '…' : s);
  const v =
    pick('command') ??
    pick('file_path', 'notebook_path', 'path') ??
    pick('pattern') ??
    pick('url', 'query') ??
    pick('description', 'prompt', 'skill') ??
    Object.values(input).find((x) => typeof x === 'string');
  const extra = name === 'Grep' && input.path ? ` in ${input.path}` : '';
  return v ? short(String(v).replace(/\s+/g, ' ')) + extra : '';
}

export function prettyToolName(name: string): string {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (m) {
    const server = m[1].replace(/^claude[_-]/i, '').replace(/[_-]+/g, ' ');
    return `${m[2]} · ${server}`;
  }
  return name;
}

export function isTruncatedAt(rec: LightRecord, pathPrefix: string): boolean {
  return rec.truncated.some((p) => p === pathPrefix || p.startsWith(pathPrefix + '/'));
}

/** Plain text of a record for search. */
export function searchText(data: any): string {
  const parts: string[] = [];
  const walk = (v: any, depth: number) => {
    if (depth > 6 || parts.length > 400) return;
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (k === 'signature' || k === 'data' || k === 'usage' || k === 'uuid' || k === 'parentUuid') continue;
        walk(v[k], depth + 1);
      }
    }
  };
  walk(data?.message ?? data, 0);
  return parts.join('\n').toLowerCase();
}

export function deepClone<T>(v: T): T {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

export function shortId(id?: string): string {
  return id ? id.slice(0, 8) : '';
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
export function stripAnsi(s: string): string {
  return s.indexOf('\u001b') === -1 ? s : s.replace(ANSI, '');
}
