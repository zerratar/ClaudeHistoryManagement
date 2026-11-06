import type { PathPair, ReplaceOptions } from '../shared/types';

const WIN_ABS = /^[A-Za-z]:[\\/]/;

interface Rule { from: string; to: string; ci: boolean }

function trimSep(p: string): string {
  if (/^[A-Za-z]:[\\/]?$/.test(p) || p === '/') return p;
  return p.replace(/[\\/]+$/, '');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Expand one from→to pair into the textual forms a path takes inside transcripts. */
export function expandPair(pair: PathPair, variants: boolean): Rule[] {
  const from = trimSep(pair.from.trim());
  const to = trimSep(pair.to.trim());
  if (!from) return [];
  const fromWin = WIN_ABS.test(from);
  if (!variants || !fromWin) return [{ from, to, ci: fromWin }];

  const toWin = WIN_ABS.test(to);
  const fBack = from.replace(/\//g, '\\');
  const fFwd = from.replace(/\\/g, '/');
  const fDbl = fBack.replace(/\\/g, '\\\\');
  const fBash = '/' + from[0].toLowerCase() + fFwd.slice(2);
  let tBack = to, tFwd = to, tDbl = to, tBash = to;
  if (toWin) {
    tBack = to.replace(/\//g, '\\');
    tFwd = to.replace(/\\/g, '/');
    tDbl = tBack.replace(/\\/g, '\\\\');
    tBash = '/' + to[0].toLowerCase() + tFwd.slice(2);
  }
  const rules: Rule[] = [
    { from: fDbl, to: tDbl, ci: true },
    { from: fBack, to: tBack, ci: true },
    { from: fFwd, to: tFwd, ci: true },
    { from: fBash, to: tBash, ci: false },
  ];
  const seen = new Set<string>();
  return rules.filter((r) => (seen.has(r.from) ? false : (seen.add(r.from), true)));
}

export interface Replacer {
  /** returns the replaced string and number of hits */
  replace(s: string): [string, number];
  /** cheap pre-filter on a raw JSON line */
  mightMatch(rawLine: string): boolean;
  active: boolean;
}

function makeGenericReplacer(pairs: PathPair[], options: ReplaceOptions): Replacer {
  const flags = 'g' + (options.caseInsensitive ? 'i' : '');
  const list = pairs
    .filter((p) => p.from !== '')
    .map((p) => ({
      re: new RegExp(options.mode === 'regex' ? p.from : escapeRe(p.from), flags),
      to: p.to,
      literal: options.mode !== 'regex',
    }));
  if (!list.length) return { replace: (s) => [s, 0], mightMatch: () => false, active: false };
  return {
    active: true,
    replace(s: string) {
      let n = 0;
      let out = s;
      for (const r of list) {
        r.re.lastIndex = 0;
        out = out.replace(r.re, (...args) => {
          n++;
          if (r.literal) return r.to;
          // expand $1, $<name>, $& like String.replace would
          const groups = typeof args[args.length - 1] === 'object' ? args[args.length - 1] : undefined;
          return r.to.replace(/\$(\$|&|\d{1,2}|<[^>]+>)/g, (m: string, g: string) => {
            if (g === '$') return '$';
            if (g === '&') return args[0];
            if (g.startsWith('<')) return groups?.[g.slice(1, -1)] ?? '';
            const v = args[Number(g)];
            return typeof v === 'string' ? v : '';
          });
        });
      }
      return [out, n];
    },
    // JSON escaping makes a raw pre-filter unreliable for arbitrary text; always parse.
    mightMatch: () => true,
  };
}

export function makeReplacer(pairs: PathPair[], options: ReplaceOptions): Replacer {
  if (options.mode === 'text' || options.mode === 'regex') return makeGenericReplacer(pairs, options);
  const rules = pairs.flatMap((p) => expandPair(p, options.variants)).filter((r) => r.from && r.from !== r.to);
  if (!rules.length) return { replace: (s) => [s, 0], mightMatch: () => false, active: false };
  rules.sort((a, b) => b.from.length - a.from.length);
  const tail = options.wholeSegment ? '(?![A-Za-z0-9_\\-])' : '';
  const ciRules = rules.filter((r) => r.ci);
  const csRules = rules.filter((r) => !r.ci);
  const build = (rs: Rule[], flags: string) =>
    rs.length ? { re: new RegExp(rs.map((r) => `(${escapeRe(r.from)})${tail}`).join('|'), flags), rs } : null;
  const ci = build(ciRules, 'gi');
  const cs = build(csRules, 'g');
  const needles = Array.from(new Set(pairs.map((p) => {
    const segs = trimSep(p.from.trim()).split(/[\\/]+/).filter(Boolean);
    return (segs[segs.length - 1] || p.from).toLowerCase();
  }).filter(Boolean)));

  const run = (s: string, g: { re: RegExp; rs: Rule[] } | null): [string, number] => {
    if (!g) return [s, 0];
    let n = 0;
    const out = s.replace(g.re, (...args) => {
      for (let k = 0; k < g.rs.length; k++) {
        if (args[k + 1] !== undefined) { n++; return g.rs[k].to; }
      }
      return args[0];
    });
    return [out, n];
  };

  return {
    active: true,
    replace(s: string) {
      const [a, n1] = run(s, cs);
      const [b, n2] = run(a, ci);
      return [b, n1 + n2];
    },
    mightMatch(raw: string) {
      const low = raw.toLowerCase();
      return needles.some((nd) => low.includes(nd));
    },
  };
}

/** Deep-replace in every string value and object key. */
export function replaceDeep(v: any, r: Replacer): [any, number] {
  if (typeof v === 'string') return r.replace(v);
  if (Array.isArray(v)) {
    let total = 0;
    const out = v.map((x) => { const [y, n] = replaceDeep(x, r); total += n; return y; });
    return [out, total];
  }
  if (v && typeof v === 'object') {
    let total = 0;
    const out: any = {};
    for (const k of Object.keys(v)) {
      const [nk, kn] = r.replace(k);
      const [nv, vn] = replaceDeep(v[k], r);
      out[nk] = nv;
      total += kn + vn;
    }
    return [out, total];
  }
  return [v, 0];
}
