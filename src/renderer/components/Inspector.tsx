import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Plus, Trash2, ArrowUp, ArrowDown, AlertTriangle, Check, RotateCcw, GitBranch, Copy, RefreshCw, Image as ImageIcon } from 'lucide-react';
import { api } from '../api';
import { CodeEditor } from './CodeEditor';
import { deepClone, fmtBytes, fmtTime, resultText } from '../util';
import type { LightRecord } from '../../shared/types';

interface Props {
  file: string;
  rec: LightRecord;
  staged?: any;
  isDeleted: boolean;
  focusBlock?: number;
  onStage(i: number, obj: any): void;
  onUnstage(i: number): void;
  onDelete(i: number): void;
  onFork(i: number): void;
  onClose(): void;
}

type Tab = 'structured' | 'raw';

export function Inspector(props: Props) {
  const { file, rec } = props;
  const [original, setOriginal] = useState<any>(undefined);
  const [originalText, setOriginalText] = useState('');
  const [draft, setDraft] = useState<any>(undefined);
  const [rawText, setRawText] = useState('');
  const [rawError, setRawError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('structured');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const focusRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.getRecord(file, rec.i).then(
      (r) => {
        if (cancelled) return;
        const orig = r.data;
        setOriginal(orig);
        setOriginalText(r.json);
        const start = props.staged !== undefined ? deepClone(props.staged) : deepClone(orig);
        setDraft(start);
        setRawText(start === null || start === undefined ? r.json : JSON.stringify(start, null, 2));
        setTab(orig === null ? 'raw' : 'structured');
        setLoading(false);
      },
      (err) => { if (!cancelled) { setError(String(err?.message || err)); setLoading(false); } },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, rec.i]);

  useEffect(() => {
    if (!loading && focusRef.current) focusRef.current.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [loading, props.focusBlock]);

  const switchTab = (t: Tab) => {
    if (t === tab) return;
    if (t === 'raw') {
      setRawText(JSON.stringify(draft, null, 2));
      setRawError(null);
    } else {
      try { setDraft(JSON.parse(rawText)); setRawError(null); } catch (e: any) { setRawError(e.message); return; }
    }
    setTab(t);
  };

  const current = (): any => {
    if (tab === 'raw') return JSON.parse(rawText);
    return draft;
  };

  const dirtyVsOriginal = useMemo(() => {
    try {
      const cur = tab === 'raw' ? JSON.parse(rawText) : draft;
      return JSON.stringify(cur) !== JSON.stringify(original);
    } catch { return true; }
  }, [draft, rawText, tab, original]);

  const stage = () => {
    let obj: any;
    try { obj = current(); } catch (e: any) { setRawError(e.message); return; }
    if (JSON.stringify(obj) === JSON.stringify(original)) props.onUnstage(rec.i);
    else props.onStage(rec.i, obj);
  };

  const revert = () => {
    const o = deepClone(original);
    setDraft(o);
    setRawText(JSON.stringify(o, null, 2));
    setRawError(null);
    props.onUnstage(rec.i);
  };

  const update = (fn: (d: any) => void) => {
    setDraft((prev: any) => {
      const next = deepClone(prev);
      fn(next);
      return next;
    });
  };

  return (
    <aside className="inspector">
      <div className="inspector-head">
        <div className="inspector-title">
          <span className={`type-badge t-${rec.type.replace(/[^a-z]/g, '')}`}>{rec.type}</span>
          <span className="muted small">line {rec.i + 1} · {fmtBytes(rec.bytes)} · {fmtTime(rec.ts)}</span>
        </div>
        <button className="icon-btn" onClick={props.onClose} title="Close"><X size={16} /></button>
      </div>
      <div className="tabs">
        <button className={tab === 'structured' ? 'active' : ''} onClick={() => switchTab('structured')} disabled={original === null}>Content</button>
        <button className={tab === 'raw' ? 'active' : ''} onClick={() => switchTab('raw')}>Raw JSON</button>
        <div className="spacer" />
        {props.staged !== undefined && <span className="pill pill-edit">staged</span>}
        {props.isDeleted && <span className="pill pill-del">will be deleted</span>}
      </div>
      <div className="inspector-body">
        {loading && <div className="muted pad">Loading full record…</div>}
        {error && <div className="error-box">{error}</div>}
        {!loading && !error && tab === 'raw' && (
          <>
            {rawError && <div className="error-box">JSON error: {rawError}</div>}
            <CodeEditor value={rawText} onChange={(v) => { setRawText(v); try { JSON.parse(v); setRawError(null); } catch (e: any) { setRawError(e.message); } }} language="json" minHeight="300px" />
            <p className="hint">This is the exact record written to the transcript line (pretty-printed here; saved compact). Every field is editable.</p>
          </>
        )}
        {!loading && !error && tab === 'structured' && draft && (
          <StructuredEditor draft={draft} update={update} focusBlock={props.focusBlock} focusRef={focusRef} originalText={originalText} />
        )}
      </div>
      <div className="inspector-foot">
        <button className="btn ghost" onClick={() => props.onFork(rec.i)} title="Create a new session containing everything up to this record"><GitBranch size={14} /> Fork here</button>
        <button className="btn ghost" onClick={() => api.copyText(tab === 'raw' ? rawText : JSON.stringify(draft, null, 2))}><Copy size={14} /> Copy</button>
        <button className="btn ghost danger" onClick={() => props.onDelete(rec.i)}><Trash2 size={14} /> {props.isDeleted ? 'Undo delete' : 'Delete'}</button>
        <div className="spacer" />
        <button className="btn ghost" onClick={revert} disabled={!dirtyVsOriginal && props.staged === undefined}><RotateCcw size={14} /> Revert</button>
        <button className="btn primary" onClick={stage} disabled={!!rawError}><Check size={14} /> {dirtyVsOriginal ? 'Stage change' : 'Keep original'}</button>
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ structured editing

function Section({ title, children, actions, warn, refEl }: { title: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode; warn?: string; refEl?: React.Ref<HTMLDivElement> }) {
  return (
    <div className="ed-section" ref={refEl}>
      <div className="ed-section-head">
        <span>{title}</span>
        <div className="spacer" />
        {actions}
      </div>
      {warn && <div className="warn-box"><AlertTriangle size={13} /> {warn}</div>}
      {children}
    </div>
  );
}

function Field({ label, value, onChange, mono }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className={mono ? 'mono' : ''} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function JsonField({ value, onChange, minHeight }: { value: any; onChange: (v: any) => void; minHeight?: string }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [err, setErr] = useState<string | null>(null);
  const last = useRef(JSON.stringify(value));
  useEffect(() => {
    const s = JSON.stringify(value);
    if (s !== last.current) { last.current = s; setText(JSON.stringify(value, null, 2)); }
  }, [value]);
  return (
    <>
      <CodeEditor
        value={text}
        language="json"
        minHeight={minHeight || '80px'}
        onChange={(v) => {
          setText(v);
          try { const parsed = JSON.parse(v); setErr(null); last.current = JSON.stringify(parsed); onChange(parsed); } catch (e: any) { setErr(e.message); }
        }}
      />
      {err && <div className="error-inline">JSON error: {err} (not applied)</div>}
    </>
  );
}

function ImageThumb({ block }: { block: any }) {
  const src = block?.source?.type === 'base64' && block.source.data ? `data:${block.source.media_type};base64,${block.source.data}` : block?.source?.url;
  if (!src) return <div className="image-chip"><ImageIcon size={14} /> image</div>;
  return <img className="thumb" src={src} alt="" />;
}

function BlockEditor({ block, onChange }: { block: any; onChange: (b: any) => void }) {
  const set = (k: string, v: any) => onChange({ ...block, [k]: v });
  switch (block?.type) {
    case 'text':
      return <CodeEditor value={block.text ?? ''} onChange={(v) => set('text', v)} language="markdown" minHeight="80px" />;
    case 'thinking':
      return <CodeEditor value={block.thinking ?? ''} onChange={(v) => set('thinking', v)} language="markdown" minHeight="80px" />;
    case 'tool_use':
    case 'server_tool_use':
      return (
        <>
          <div className="field-row">
            <Field label="Tool name" value={block.name} onChange={(v) => set('name', v)} mono />
            <Field label="Call id" value={block.id} onChange={(v) => set('id', v)} mono />
          </div>
          <div className="field-label">Input (arguments sent by the model)</div>
          <ToolInputEditor input={block.input} onChange={(v) => set('input', v)} />
        </>
      );
    case 'tool_result':
      return <ToolResultEditor block={block} onChange={onChange} />;
    case 'image':
      return <ImageThumb block={block} />;
    default:
      return <JsonField value={block} onChange={onChange} />;
  }
}

/** Long string arguments (commands, file contents, old/new strings) get their own text editors. */
function ToolInputEditor({ input, onChange }: { input: any; onChange: (v: any) => void }) {
  const [asJson, setAsJson] = useState(false);
  if (!input || typeof input !== 'object' || Array.isArray(input) || asJson) {
    return (
      <>
        <JsonField value={input} onChange={onChange} />
        {input && typeof input === 'object' && !Array.isArray(input) && <button className="link-btn" onClick={() => setAsJson(false)}>Edit as fields</button>}
      </>
    );
  }
  return (
    <div className="arg-list">
      {Object.keys(input).map((k) => {
        const v = input[k];
        return (
          <div key={k} className="arg">
            <div className="arg-key mono">{k}</div>
            {typeof v === 'string' ? (
              v.includes('\n') || v.length > 80
                ? <CodeEditor value={v} onChange={(nv) => onChange({ ...input, [k]: nv })} language="text" minHeight="40px" />
                : <input className="mono" value={v} onChange={(e) => onChange({ ...input, [k]: e.target.value })} />
            ) : (
              <JsonField value={v} onChange={(nv) => onChange({ ...input, [k]: nv })} minHeight="30px" />
            )}
          </div>
        );
      })}
      <button className="link-btn" onClick={() => setAsJson(true)}>Edit as JSON (add/remove arguments)</button>
    </div>
  );
}

function ToolResultEditor({ block, onChange }: { block: any; onChange: (b: any) => void }) {
  const c = block.content;
  return (
    <>
      <div className="field-row">
        <Field label="tool_use_id" value={block.tool_use_id} onChange={(v) => onChange({ ...block, tool_use_id: v })} mono />
        <label className="check">
          <input type="checkbox" checked={!!block.is_error} onChange={(e) => onChange({ ...block, is_error: e.target.checked })} /> is_error
        </label>
      </div>
      <div className="field-label">Result content (this is what the model sees)</div>
      {typeof c === 'string' || c == null ? (
        <CodeEditor value={c ?? ''} onChange={(v) => onChange({ ...block, content: v })} language="text" minHeight="120px" lineNumbers />
      ) : Array.isArray(c) ? (
        <div className="nested-blocks">
          {c.map((b: any, k: number) => (
            <div key={k} className="nested-block">
              <div className="nested-head">
                <span className="mono small">{b?.type}</span>
                <div className="spacer" />
                <button className="icon-btn danger" title="Remove" onClick={() => onChange({ ...block, content: c.filter((_: any, j: number) => j !== k) })}><Trash2 size={13} /></button>
              </div>
              {b?.type === 'text'
                ? <CodeEditor value={b.text ?? ''} onChange={(v) => { const n = [...c]; n[k] = { ...b, text: v }; onChange({ ...block, content: n }); }} language="text" minHeight="80px" lineNumbers />
                : b?.type === 'image' ? <ImageThumb block={b} />
                : <JsonField value={b} onChange={(v) => { const n = [...c]; n[k] = v; onChange({ ...block, content: n }); }} />}
            </div>
          ))}
          <button className="link-btn" onClick={() => onChange({ ...block, content: [...c, { type: 'text', text: '' }] })}><Plus size={12} /> Add text</button>
        </div>
      ) : (
        <JsonField value={c} onChange={(v) => onChange({ ...block, content: v })} />
      )}
    </>
  );
}

function syncToolUseResult(tur: any, text: string): any {
  if (typeof tur === 'string') return text;
  if (tur && typeof tur === 'object') {
    if (typeof tur.stdout === 'string') return { ...tur, stdout: text };
    if (typeof tur.content === 'string') return { ...tur, content: text };
    if (tur.file && typeof tur.file.content === 'string') return { ...tur, file: { ...tur.file, content: text } };
  }
  return tur;
}

function StructuredEditor({ draft, update, focusBlock, focusRef, originalText }: { draft: any; update: (fn: (d: any) => void) => void; focusBlock?: number; focusRef: React.MutableRefObject<HTMLDivElement | null>; originalText: string }) {
  const msg = draft.message;
  const content = msg?.content;
  const isConv = draft.type === 'user' || draft.type === 'assistant';
  const toolResultBlocks = Array.isArray(content) ? content.filter((b: any) => b?.type === 'tool_result') : [];

  return (
    <div className="structured">
      {isConv && typeof content === 'string' && (
        <Section title={draft.type === 'user' ? 'User message' : 'Assistant message'} refEl={focusRef}>
          <CodeEditor value={content} onChange={(v) => update((d) => { d.message.content = v; })} language="markdown" minHeight="140px" />
          <button className="link-btn" onClick={() => update((d) => { d.message.content = [{ type: 'text', text: d.message.content }]; })}>Convert to blocks (to add text / images)</button>
        </Section>
      )}

      {isConv && Array.isArray(content) && content.map((b: any, k: number) => (
        <Section
          key={k}
          refEl={k === focusBlock ? focusRef : undefined}
          title={<><span className="mono">[{k}]</span> {b?.type}{b?.type === 'tool_use' ? ` · ${b.name}` : ''}</>}
          warn={b?.type === 'thinking' ? 'Thinking blocks carry a cryptographic signature. If you change the text the API may reject the conversation when resumed; deleting the block is usually safer.' : undefined}
          actions={
            <>
              <button className="icon-btn" disabled={k === 0} title="Move up" onClick={() => update((d) => { const c = d.message.content; [c[k - 1], c[k]] = [c[k], c[k - 1]]; })}><ArrowUp size={13} /></button>
              <button className="icon-btn" disabled={k === content.length - 1} title="Move down" onClick={() => update((d) => { const c = d.message.content; [c[k + 1], c[k]] = [c[k], c[k + 1]]; })}><ArrowDown size={13} /></button>
              <button className="icon-btn danger" title="Remove block" onClick={() => update((d) => { d.message.content.splice(k, 1); })}><Trash2 size={13} /></button>
            </>
          }
        >
          <BlockEditor block={b} onChange={(nb) => update((d) => { d.message.content[k] = nb; })} />
        </Section>
      ))}

      {isConv && Array.isArray(content) && (
        <div className="add-row">
          <button className="btn ghost small" onClick={() => update((d) => { d.message.content.push({ type: 'text', text: '' }); })}><Plus size={13} /> Add text block</button>
          {focusBlock === undefined && draft.type === 'user' && content.length === 0 && <span className="muted small">Empty message</span>}
        </div>
      )}

      {draft.type === 'user' && toolResultBlocks.length > 0 && draft.toolUseResult !== undefined && (
        <Section
          title="toolUseResult (UI copy)"
          actions={
            toolResultBlocks.length === 1 ? (
              <button className="chip-btn" title="Copy the result content above into the matching field below" onClick={() => update((d) => { d.toolUseResult = syncToolUseResult(d.toolUseResult, resultText(toolResultBlocks[0].content)); })}>
                <RefreshCw size={12} /> Sync from content
              </button>
            ) : undefined
          }
        >
          <p className="hint">Claude Code keeps a structured copy of the tool output for its own display. The model only sees the content above, but keep both consistent when you change file names or paths.</p>
          <JsonField value={draft.toolUseResult} onChange={(v) => update((d) => { d.toolUseResult = v; })} minHeight="100px" />
        </Section>
      )}

      {draft.type === 'attachment' && (
        <Section title={`Attachment · ${draft.attachment?.type || ''}`}>
          <p className="hint">Attachments become &lt;system-reminder&gt; context injected into the conversation.</p>
          <JsonField value={draft.attachment} onChange={(v) => update((d) => { d.attachment = v; })} minHeight="160px" />
        </Section>
      )}

      {!isConv && draft.type !== 'attachment' && (
        <Section title="Fields">
          <JsonField value={draft} onChange={(v) => update((d) => { for (const k of Object.keys(d)) delete d[k]; Object.assign(d, v); })} minHeight="200px" />
        </Section>
      )}

      {isConv && (
        <Section title="Record metadata">
          <div className="field-row">
            <Field label="cwd" value={draft.cwd ?? ''} onChange={(v) => update((d) => { d.cwd = v; })} mono />
            <Field label="gitBranch" value={draft.gitBranch ?? ''} onChange={(v) => update((d) => { d.gitBranch = v; })} mono />
          </div>
          <div className="field-row">
            <Field label="timestamp" value={draft.timestamp ?? ''} onChange={(v) => update((d) => { d.timestamp = v; })} mono />
            {draft.type === 'assistant' && <Field label="model" value={msg?.model ?? ''} onChange={(v) => update((d) => { d.message.model = v; })} mono />}
          </div>
          <div className="muted small mono">uuid {draft.uuid} · parent {String(draft.parentUuid)}</div>
          <div className="muted small">Original line: {originalText.length.toLocaleString()} chars</div>
        </Section>
      )}
    </div>
  );
}
