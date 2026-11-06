import React, { useEffect, useMemo, useState } from 'react';
import { X, Plus, Trash2, Search, Wand2, Archive, Upload, RotateCcw, FolderOpen, CheckCircle2 } from 'lucide-react';
import { api } from '../api';
import type { ApiRequestView, BackupInfo, BundleManifest, ImportResult, PathPair, ProjectSummary, ReplaceOptions, ReplacePreview } from '../../shared/types';
import { fmtBytes, fmtTime, relTime, resultText } from '../util';

export function Modal({ title, onClose, children, footer, wide }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function PromptModal({ title, label, initial, onOk, onClose, okText }: { title: string; label: string; initial: string; onOk: (v: string) => void; onClose: () => void; okText?: string }) {
  const [v, setV] = useState(initial);
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onOk(v)}>{okText || 'OK'}</button></>}>
      <label className="field"><span>{label}</span><input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onOk(v); }} /></label>
    </Modal>
  );
}

// ------------------------------------------------------------------ pairs editor

function PairsEditor({ pairs, setPairs, fromLabel = 'Find', toLabel = 'Replace with' }: { pairs: PathPair[]; setPairs: (p: PathPair[]) => void; fromLabel?: string; toLabel?: string }) {
  return (
    <div className="pairs">
      <div className="pairs-head"><span>{fromLabel}</span><span>{toLabel}</span><span /></div>
      {pairs.map((p, k) => (
        <div key={k} className="pair">
          <input className="mono" value={p.from} placeholder="e.g. C:\Users\me\project or old-name.ts" onChange={(e) => setPairs(pairs.map((x, j) => (j === k ? { ...x, from: e.target.value } : x)))} />
          <input className="mono" value={p.to} placeholder="replacement" onChange={(e) => setPairs(pairs.map((x, j) => (j === k ? { ...x, to: e.target.value } : x)))} />
          <button className="icon-btn danger" onClick={() => setPairs(pairs.filter((_, j) => j !== k))}><Trash2 size={13} /></button>
        </div>
      ))}
      <button className="link-btn" onClick={() => setPairs([...pairs, { from: '', to: '' }])}><Plus size={12} /> Add row</button>
    </div>
  );
}

function OptionsEditor({ options, setOptions }: { options: ReplaceOptions; setOptions: (o: ReplaceOptions) => void }) {
  const mode = options.mode || 'path';
  return (
    <div className="options">
      <div className="seg">
        {(['text', 'path', 'regex'] as const).map((m) => (
          <button key={m} className={mode === m ? 'active' : ''} onClick={() => setOptions({ ...options, mode: m })}>
            {m === 'text' ? 'Plain text' : m === 'path' ? 'Path-aware' : 'Regex'}
          </button>
        ))}
      </div>
      {mode === 'path' ? (
        <>
          <label className="check"><input type="checkbox" checked={options.variants} onChange={(e) => setOptions({ ...options, variants: e.target.checked })} /> Match \ and / forms, escaped \\ and /c/… (git-bash)</label>
          <label className="check"><input type="checkbox" checked={options.wholeSegment} onChange={(e) => setOptions({ ...options, wholeSegment: e.target.checked })} /> Whole folder names only (don't turn Foo into Bar inside FooBar)</label>
        </>
      ) : (
        <label className="check"><input type="checkbox" checked={!!options.caseInsensitive} onChange={(e) => setOptions({ ...options, caseInsensitive: e.target.checked })} /> Ignore case</label>
      )}
      {mode === 'regex' && <span className="hint">JavaScript regex. Use $1, $&lt;name&gt; in the replacement.</span>}
    </div>
  );
}

function ThinkingOption({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="think-box">
      <label className="check strong">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        Remove thinking blocks after the first change (recommended)
      </label>
      <div className="hint">
        Thinking blocks are signed together with everything before them, so changed text invalidates every later one.
        Removing them keeps all messages and tool calls; Claude just won't see its earlier private reasoning.
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ find & replace in a session

export function FindReplaceModal({ file, expected, scopeLines, onClose, onDone, hasPending, live }: {
  file: string; expected: { size: number; mtimeMs: number }; scopeLines?: number[]; onClose: () => void; onDone: (msg: string) => void; hasPending: boolean; live: boolean;
}) {
  const [pairs, setPairs] = useState<PathPair[]>([{ from: '', to: '' }]);
  const [options, setOptions] = useState<ReplaceOptions>({ mode: 'text', variants: true, wholeSegment: true, caseInsensitive: false });
  const [onlyScope, setOnlyScope] = useState(!!scopeLines?.length);
  const [strip, setStrip] = useState(true);
  const [preview, setPreview] = useState<ReplacePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const opts = (): ReplaceOptions => ({ ...options, onlyLines: onlyScope ? scopeLines : undefined, stripThinking: strip });

  const doPreview = async () => {
    setBusy(true); setErr(null);
    try { setPreview(await api.previewReplace(file, pairs, opts())); } catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(false); }
  };
  const doApply = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.applyReplace(file, pairs, opts(), expected);
      if (!r.ok) setErr(r.error || 'Failed');
      else onDone(`Replaced in ${r.changedLines} line(s)${r.report?.thinkingBlocksRemoved ? `, removed ${r.report.thinkingBlocksRemoved} thinking block(s)` : ''}. Backup saved.`);
    } catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(false); }
  };
  useEffect(() => setPreview(null), [pairs, options, onlyScope, strip]);

  return (
    <Modal
      wide
      title={<><Wand2 size={16} /> Find &amp; replace in this session</>}
      onClose={onClose}
      footer={
        <>
          <span className="muted small">Edits every string in every record: messages, tool inputs, tool results, metadata. A backup is made first.</span>
          <div className="spacer" />
          <button className="btn ghost" onClick={doPreview} disabled={busy}><Search size={14} /> Preview</button>
          <button className="btn primary" onClick={doApply} disabled={busy || !preview || !preview.occurrences || hasPending}>Replace {preview ? preview.occurrences : ''}</button>
        </>
      }
    >
      {hasPending && <div className="warn-box">Save or discard your staged edits first.</div>}
      {live && <div className="warn-box">This session is open in a running Claude process. It will not see these changes until it is resumed again.</div>}
      <PairsEditor pairs={pairs} setPairs={setPairs} />
      <OptionsEditor options={options} setOptions={setOptions} />
      {!!scopeLines?.length && (
        <label className="check"><input type="checkbox" checked={onlyScope} onChange={(e) => setOnlyScope(e.target.checked)} /> Only in the selected record{scopeLines.length > 1 ? 's' : ''} (lines {scopeLines.map((x) => x + 1).join(', ')})</label>
      )}
      <ThinkingOption checked={strip} onChange={setStrip} />
      {err && <div className="error-box">{err}</div>}
      {preview && (
        <div className="preview">
          <div className="preview-summary">{preview.occurrences} occurrence(s) in {preview.linesAffected} record(s)</div>
          {preview.report && preview.report.firstChange !== null && (
            <div className="muted small">
              First change the model sees: line {preview.report.firstChange + 1}.{' '}
              {strip ? `${preview.report.thinkingBlocksRemoved} thinking block(s) after it will be removed.` : `${preview.report.thinkingBlocksAffected} thinking block(s) after it will no longer match their signatures.`}
            </div>
          )}
          {preview.report?.problems.filter((p) => p.level === 'error').map((p) => <div key={p.key} className="error-box">{p.message}</div>)}
          {preview.samples.map((s, k) => (
            <div key={k} className="sample">
              <div className="muted small">line {s.i + 1}</div>
              <div className="diff-del mono">{s.before}</div>
              <div className="diff-add mono">{s.after}</div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ backups

export function BackupsModal({ file, onClose, onRestored }: { file: string; onClose: () => void; onRestored: (msg: string) => void }) {
  const [list, setList] = useState<BackupInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.listBackups(file).then(setList, (e) => setErr(String(e))); }, [file]);
  const restore = async (b: BackupInfo) => {
    if (!confirm(`Restore the backup from ${new Date(b.createdAt).toLocaleString()}? The current file is backed up first.`)) return;
    const r = await api.restoreBackup(file, b.path);
    if (!r.ok) setErr(r.error || 'Failed'); else onRestored('Backup restored');
  };
  return (
    <Modal title={<><Archive size={16} /> Backups</>} onClose={onClose}>
      {err && <div className="error-box">{err}</div>}
      {list === null ? <div className="muted">Loading…</div> : list.length === 0 ? <div className="muted">No backups yet. One is made automatically before every save.</div> : (
        <div className="list">
          {list.map((b) => (
            <div key={b.path} className="list-item">
              <div>
                <div>{new Date(b.createdAt).toLocaleString()} <span className="muted small">· {relTime(b.createdAt)}</span></div>
                <div className="muted small">{b.label} · {fmtBytes(b.size)}</div>
              </div>
              <div className="spacer" />
              <button className="btn ghost small" onClick={() => api.revealInExplorer(b.path)}><FolderOpen size={13} /></button>
              <button className="btn ghost small" onClick={() => restore(b)}><RotateCcw size={13} /> Restore</button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ export

export function ExportModal({ project, preselect, onClose, onDone }: { project: ProjectSummary; preselect?: string[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set(preselect?.length ? preselect : project.sessions.map((s) => s.id)));
  const [mem, setMem] = useState(true);
  const [side, setSide] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const total = project.sessions.filter((s) => sel.has(s.id)).reduce((a, s) => a + s.size, 0);
  const run = async () => {
    setBusy(true); setErr(null);
    const r = await api.exportBundle({ projectDir: project.dirName, sessionIds: [...sel], includeMemory: mem, includeSidecars: side });
    setBusy(false);
    if (r.canceled) return;
    if (!r.ok) setErr(r.error || 'Export failed');
    else onDone(`Exported to ${r.path}`);
  };
  return (
    <Modal
      title={<><Archive size={16} /> Export · {project.displayName}</>}
      onClose={onClose}
      footer={<><span className="muted small">{sel.size} session(s) · {fmtBytes(total)}</span><div className="spacer" /><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !sel.size} onClick={run}>{busy ? 'Exporting…' : 'Export bundle…'}</button></>}
    >
      <p className="hint">Creates a .zip bundle you can import on another machine. Paths are rewritten during import, so export as-is.</p>
      <div className="list selectable">
        {project.sessions.map((s) => (
          <label key={s.id} className="list-item">
            <input type="checkbox" checked={sel.has(s.id)} onChange={(e) => { const n = new Set(sel); e.target.checked ? n.add(s.id) : n.delete(s.id); setSel(n); }} />
            <div className="grow"><div className="ellipsis">{s.title}</div><div className="muted small">{relTime(s.mtimeMs)} · {fmtBytes(s.size)}{s.subagentCount ? ` · ${s.subagentCount} subagents` : ''}</div></div>
          </label>
        ))}
      </div>
      <label className="check"><input type="checkbox" checked={side} onChange={(e) => setSide(e.target.checked)} /> Include subagent transcripts and saved tool outputs</label>
      <label className="check"><input type="checkbox" checked={mem} onChange={(e) => setMem(e.target.checked)} disabled={!project.memoryFiles.length} /> Include project memory ({project.memoryFiles.length} file(s))</label>
      {err && <div className="error-box">{err}</div>}
    </Modal>
  );
}

// ------------------------------------------------------------------ import / clone with remap

const encode = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

export function ImportModal({ source, onClose, onDone }: {
  source: { kind: 'bundle'; path: string; manifest: BundleManifest } | { kind: 'local'; project: ProjectSummary; sessionIds: string[] };
  onClose: () => void;
  onDone: (res: ImportResult) => void;
}) {
  const sourceCwd = source.kind === 'bundle'
    ? source.manifest.project.cwd || source.manifest.sessions.find((s) => s.cwd)?.cwd || ''
    : source.project.sessions.find((s) => source.sessionIds.includes(s.id))?.cwd || source.project.cwd || '';
  const [home, setHome] = useState('');
  const sourceHome = source.kind === 'bundle' ? source.manifest.source.home : home;
  const [targetCwd, setTargetCwd] = useState(sourceCwd);
  const [pairs, setPairs] = useState<PathPair[]>([]);
  const [options, setOptions] = useState<ReplaceOptions>({ mode: 'path', variants: true, wholeSegment: true, stripThinking: true });
  const [conflict, setConflict] = useState<'new-id' | 'overwrite' | 'skip'>('new-id');
  const [mem, setMem] = useState(source.kind === 'bundle' ? source.manifest.includesMemory : false);
  const [overwriteMem, setOverwriteMem] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => { api.homeDir().then(setHome); }, []);

  const suggest = useMemo(() => () => {
    const out: PathPair[] = [];
    const t = targetCwd.trim();
    if (sourceCwd && t && sourceCwd !== t) {
      out.push({ from: sourceCwd, to: t });
      out.push({ from: encode(sourceCwd), to: encode(t) });
    }
    if (sourceHome && home && sourceHome.toLowerCase() !== home.toLowerCase()) out.push({ from: sourceHome, to: home });
    return out;
  }, [sourceCwd, targetCwd, sourceHome, home]);

  const [touched, setTouched] = useState(false);
  useEffect(() => { if (!touched) setPairs(suggest()); }, [suggest, touched]);

  const run = async () => {
    setBusy(true);
    const res = await api.importBundle({
      bundlePath: source.kind === 'bundle' ? source.path : undefined,
      localSource: source.kind === 'local' ? { projectDir: source.project.dirName, sessionIds: source.sessionIds } : undefined,
      targetCwd: targetCwd.trim(),
      pairs: pairs.filter((p) => p.from.trim()),
      options,
      conflict,
      includeMemory: mem,
      overwriteMemory: overwriteMem,
    });
    setBusy(false);
    setResult(res);
    if (res.ok) onDone(res);
  };

  const sessions = source.kind === 'bundle'
    ? source.manifest.sessions
    : source.project.sessions.filter((s) => source.sessionIds.includes(s.id)).map((s) => ({ id: s.id, title: s.title, size: s.size }));

  return (
    <Modal
      wide
      title={<><Upload size={16} /> {source.kind === 'bundle' ? 'Import bundle' : 'Clone / relocate session'}</>}
      onClose={onClose}
      footer={
        result?.ok ? <><div className="spacer" /><button className="btn primary" onClick={onClose}>Done</button></> :
        <><span className="muted small">Writes to ~/.claude/projects/{encode(targetCwd.trim() || '?')}</span><div className="spacer" /><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={run} disabled={busy || !targetCwd.trim()}>{busy ? 'Working…' : source.kind === 'bundle' ? 'Import' : 'Create copy'}</button></>
      }
    >
      {result?.ok ? (
        <div className="result">
          <div className="ok-line"><CheckCircle2 size={16} /> Imported {result.imported.length} session(s)</div>
          {result.imported.map((x) => <div key={x.newId} className="muted small mono">{x.newId}{x.newId !== x.oldId ? ` (was ${x.oldId})` : ''} · {x.replacements} replacement(s){x.thinkingBlocksRemoved ? ` · ${x.thinkingBlocksRemoved} thinking block(s) removed` : ''}</div>)}
          {result.memoryWritten.length > 0 && <div className="muted small">Memory: {result.memoryWritten.join(', ')}</div>}
          {result.skipped.length > 0 && <div className="muted small">Skipped: {result.skipped.join(', ')}</div>}
          <p className="hint">Resume in a terminal from the target folder with <code>claude --resume</code>. The Claude desktop app may only list sessions it started itself.</p>
        </div>
      ) : (
        <>
          <div className="kv">
            {source.kind === 'bundle' && <><span>From</span><span>{source.manifest.source.host} · exported {fmtTime(source.manifest.exportedAt)}</span></>}
            <span>Sessions</span><span>{sessions.map((s) => s.title).join(' · ')}</span>
            <span>Original folder</span><span className="mono">{sourceCwd || '(unknown)'}</span>
          </div>
          <label className="field">
            <span>Working directory on this computer (the project folder you will run Claude in)</span>
            <input className="mono" value={targetCwd} onChange={(e) => setTargetCwd(e.target.value)} />
          </label>
          <div className="field-label">Rewrite text inside the transcripts <button className="link-btn" onClick={() => { setTouched(false); setPairs(suggest()); }}>Re-suggest</button></div>
          <PairsEditor pairs={pairs} setPairs={(p) => { setTouched(true); setPairs(p); }} fromLabel="Original text" toLabel="Becomes" />
          <OptionsEditor options={options} setOptions={setOptions} />
          {pairs.some((p) => p.from.trim()) && (
            <ThinkingOption checked={!!options.stripThinking} onChange={(v) => setOptions({ ...options, stripThinking: v })} />
          )}
          <div className="field-row">
            <label className="field">
              <span>If a session with the same id already exists</span>
              <select value={conflict} onChange={(e) => setConflict(e.target.value as any)}>
                <option value="new-id">Import as a new session id</option>
                <option value="overwrite">Overwrite it</option>
                <option value="skip">Skip it</option>
              </select>
            </label>
          </div>
          {(source.kind === 'local' || source.manifest.includesMemory) && (
            <>
              <label className="check"><input type="checkbox" checked={mem} onChange={(e) => setMem(e.target.checked)} /> Copy project memory</label>
              {mem && <label className="check"><input type="checkbox" checked={overwriteMem} onChange={(e) => setOverwriteMem(e.target.checked)} /> Overwrite existing memory files (otherwise only new files are added and MEMORY.md is merged)</label>}
            </>
          )}
          {result && !result.ok && <div className="error-box">{result.error}</div>}
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ API request viewer

export function ApiRequestModal({ file, id, onClose }: { file: string; id: string; onClose: () => void }) {
  const [view, setView] = useState<ApiRequestView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showParams, setShowParams] = useState(false);
  useEffect(() => { api.getApiRequest(file, id).then(setView, (e) => setErr(String(e?.message || e))); }, [file, id]);
  return (
    <Modal wide title={<>What was sent · API request</>} onClose={onClose}>
      {err && <div className="error-box">{err}</div>}
      {!view && !err && <div className="muted">Reconstructing request…</div>}
      {view && (
        <>
          <div className="kv">
            <span>Time</span><span>{fmtTime(view.timestamp)}</span>
            <span>Model</span><span className="mono">{view.params?.model}</span>
            <span>Messages</span><span>{view.messages.length}{view.missingBlobs ? ` (${view.missingBlobs} blob(s) missing)` : ''}</span>
          </div>
          <p className="hint">Reconstructed from the request log Claude Code keeps in the transcript. Messages marked <b>injected</b> were added by Claude Code and never shown as chat. The system prompt and tool definitions are not logged, only the messages array and parameters.</p>
          <button className="link-btn" onClick={() => setShowParams(!showParams)}>{showParams ? 'Hide' : 'Show'} request parameters</button>
          {showParams && <pre className="plain-pre small">{JSON.stringify(view.params, null, 2)}</pre>}
          <div className="api-msgs">
            {view.messages.map((m, k) => (
              <div key={k} className={`api-msg role-${m?.role}`}>
                <div className="api-msg-head"><span className="mono">#{k}</span> <b>{m?.role}</b>{m?._injected ? <span className="pill pill-edit" title="Not a visible chat message: context Claude Code added to the request (system reminders, CLAUDE.md, hook output…)">injected by Claude Code</span> : m?._fromLine !== undefined ? <span className="muted small">transcript line {m._fromLine + 1}</span> : null}</div>
                {typeof m?.content === 'string' ? <pre className="plain-pre">{m.content}</pre> : (m?.content || []).map((b: any, j: number) => (
                  <div key={j} className="api-block">
                    <span className="pill">{b?.type}{b?.name ? ` · ${b.name}` : ''}</span>
                    {b?.type === 'text' ? <pre className="plain-pre">{b.text}</pre>
                      : b?.type === 'thinking' ? <pre className="plain-pre muted">{b.thinking}</pre>
                      : b?.type === 'tool_use' ? <pre className="plain-pre">{JSON.stringify(b.input, null, 2)}</pre>
                      : b?.type === 'tool_result' ? <pre className="plain-pre">{resultText(b.content)}</pre>
                      : b?.type === 'image' ? <span className="muted small"> image ({b.source?.media_type})</span>
                      : <pre className="plain-pre small">{JSON.stringify(b, null, 2)}</pre>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
