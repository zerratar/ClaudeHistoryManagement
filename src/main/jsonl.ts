import fs from 'node:fs';

export interface RawLine {
  i: number;
  start: number;
  /** raw bytes of the line without the trailing newline */
  buf: Buffer;
}

const CHUNK = 8 * 1024 * 1024;

/** Stream a JSONL file line by line, keeping exact byte offsets and raw bytes. */
export async function* iterLines(file: string, onProgress?: (fraction: number) => void): AsyncGenerator<RawLine> {
  const fd = await fs.promises.open(file, 'r');
  try {
    const { size } = await fd.stat();
    let pos = 0;
    let carry: Buffer = Buffer.alloc(0);
    let carryStart = 0;
    let i = 0;
    let lastReport = 0;
    while (pos < size) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK, size - pos));
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, pos);
      if (bytesRead === 0) break;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const dataStart = carry.length ? carryStart : pos;
      pos += bytesRead;
      let lineStart = 0;
      let nl = data.indexOf(0x0a, lineStart);
      while (nl !== -1) {
        let end = nl;
        if (end > lineStart && data[end - 1] === 0x0d) end--;
        yield { i: i++, start: dataStart + lineStart, buf: data.subarray(lineStart, end) };
        lineStart = nl + 1;
        nl = data.indexOf(0x0a, lineStart);
      }
      carry = Buffer.from(data.subarray(lineStart));
      carryStart = dataStart + lineStart;
      if (onProgress && pos - lastReport > 16 * 1024 * 1024) {
        lastReport = pos;
        onProgress(pos / size);
      }
    }
    if (carry.length) {
      let end = carry.length;
      if (carry[end - 1] === 0x0d) end--;
      if (end > 0) yield { i: i++, start: carryStart, buf: carry.subarray(0, end) };
    }
  } finally {
    await fd.close();
  }
}

export function isBlankLine(buf: Buffer): boolean {
  for (let k = 0; k < buf.length; k++) {
    const c = buf[k];
    if (c !== 0x20 && c !== 0x09 && c !== 0x0d) return false;
  }
  return true;
}

/** Shorten long strings so huge transcripts (base64 images, big tool output) stay light in the UI. */
export function lighten(v: any, limit: number, pathParts: string, truncated: string[]): any {
  if (typeof v === 'string') {
    if (v.length > limit) {
      truncated.push(pathParts);
      return v.slice(0, limit);
    }
    return v;
  }
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let k = 0; k < v.length; k++) out[k] = lighten(v[k], limit, pathParts ? `${pathParts}/${k}` : String(k), truncated);
    return out;
  }
  if (v && typeof v === 'object') {
    const out: any = {};
    for (const k of Object.keys(v)) {
      // Base64 payloads are never useful as text; keep only a tiny prefix.
      const lim = k === 'data' && typeof v[k] === 'string' && (v.type === 'base64' || v.media_type) ? 0 : k === 'signature' ? 0 : limit;
      out[k] = lighten(v[k], lim, pathParts ? `${pathParts}/${k}` : k, truncated);
    }
    return out;
  }
  return v;
}

/** Atomically replace `target` with `tmp`, retrying around transient Windows locks (AV scanners, indexers). */
export async function atomicReplace(tmp: string, target: string): Promise<void> {
  let lastErr: any;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await fs.promises.rename(tmp, target);
      return;
    } catch (err: any) {
      lastErr = err;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) break;
      await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
    }
  }
  try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
  throw lastErr;
}
