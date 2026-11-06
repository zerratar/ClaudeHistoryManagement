import React, { memo, useState } from 'react';
import {
  Pencil, Braces, Copy, GitBranch, Trash2, Undo2, ChevronRight, ChevronDown, Image as ImageIcon,
  Brain, Bot, Zap, FileText, Info, Server, Tag, ListOrdered, History, AlertTriangle,
} from 'lucide-react';
import type { LightRecord } from '../../shared/types';
import type { Row } from '../rows';
import { Markdown } from './Markdown';
import { api } from '../api';
import { fmtBytes, fmtTime, isTruncatedAt, prettyToolName, resultText, shortId, stripAnsi, toolSummary } from '../util';

export interface RowActions {
  edit(i: number, block?: number): void;
  deleteRow(row: Row): void;
  undoDelete(row: Row): void;
  fork(i: number): void;
  copy(i: number): void;
  openApi(id: string): void;
  openSubagent(toolUseId: string): boolean;
}

interface Props {
  row: Row;
  file: string;
  edited: boolean;
  deleted: boolean;
  selected: boolean;
  hit: boolean;
  actions: RowActions;
  hasSubagent?: boolean;
}

function Toolbar({ row, deleted, actions, editBlock }: { row: Row; deleted: boolean; actions: RowActions; editBlock?: number }) {
  const i = row.rec.i;
  if (deleted) {
    return (
      <div className="row-tools visible">
        <button className="icon-btn" title="Undo delete" onClick={() => actions.undoDelete(row)}><Undo2 size={14} /></button>
      </div>
    );
  }
  return (
    <div className="row-tools">
      <button className="icon-btn" title="Edit" onClick={() => actions.edit(i, editBlock)}><Pencil size={14} /></button>
      <button className="icon-btn" title="Copy raw JSON" onClick={() => actions.copy(i)}><Copy size={14} /></button>
      <button className="icon-btn" title="Fork a new session that ends here" onClick={() => actions.fork(row.kind === 'tool' && row.result ? row.result.rec.i : i)}><GitBranch size={14} /></button>
      <button className="icon-btn danger" title={row.kind === 'tool' ? 'Delete call and its result' : 'Delete'} onClick={() => actions.deleteRow(row)}><Trash2 size={14} /></button>
    </div>
  );
}

function TruncNote({ rec, path, onLoad }: { rec: LightRecord; path: string; onLoad: () => void }) {
  if (!isTruncatedAt(rec, path)) return null;
  return (
    <button className="trunc-note" onClick={onLoad}>
      Shortened for display · open in editor to see everything
    </button>
  );
}

function ImageBlock({ file, rec, path }: { file: string; rec: LightRecord; path: (string | number)[] }) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  let b: any = rec.data;
  for (const p of path) b = b?.[p];
  const media = b?.source?.media_type || 'image';
  const load = async () => {
    setLoading(true);
    try {
      const full = await api.getRecord(file, rec.i);
      let x: any = full.data;
      for (const p of path) x = x?.[p];
      if (x?.source?.type === 'base64') setSrc(`data:${x.source.media_type};base64,${x.source.data}`);
      else if (x?.source?.url) setSrc(x.source.url);
    } finally { setLoading(false); }
  };
  if (src) return <img className="inline-image" src={src} alt="attachment" onClick={() => setSrc(null)} title="Click to hide" />;
  return (
    <button className="image-chip" onClick={load} disabled={loading}>
      <ImageIcon size={14} /> {loading ? 'Loading…' : `Show image (${media})`}
    </button>
  );
}

function UserContent({ file, row }: { file: string; row: Extract<Row, { kind: 'user' }> }) {
  const c = row.rec.data?.message?.content;
  if (typeof c === 'string') return <div className="user-text">{c}</div>;
  if (!Array.isArray(c)) return <div className="user-text muted">(empty)</div>;
  return (
    <>
      {c.map((b: any, k: number) => {
        if (b?.type === 'tool_result') return null;
        if (b?.type === 'text') return <div key={k} className="user-text">{b.text}</div>;
        if (b?.type === 'image') return <ImageBlock key={k} file={file} rec={row.rec} path={['message', 'content', k]} />;
        if (b?.type === 'document') return <div key={k} className="image-chip"><FileText size={14} /> Document ({b.source?.media_type || 'file'})</div>;
        return <pre key={k} className="plain-pre small">{JSON.stringify(b, null, 2)}</pre>;
      })}
    </>
  );
}

function ResultBody({ rec, block, onOpen, file }: { rec: LightRecord; block: number; onOpen: () => void; file: string }) {
  const [expanded, setExpanded] = useState(false);
  const b = rec.data?.message?.content?.[block];
  const text = stripAnsi(resultText(b?.content));
  const lines = text.split('\n');
  const shown = expanded ? text : lines.slice(0, 6).join('\n');
  const images = Array.isArray(b?.content) ? b.content.map((x: any, k: number) => (x?.type === 'image' ? k : -1)).filter((k: number) => k >= 0) : [];
  return (
    <div className={`tool-result ${b?.is_error ? 'error' : ''}`}>
      <span className="elbow">⎿</span>
      <div className="tool-result-body">
        {text.trim() ? <pre className="result-pre">{shown}</pre> : images.length ? null : <span className="muted small">(no output)</span>}
        {images.map((k: number) => <ImageBlock key={k} file={file} rec={rec} path={['message', 'content', block, 'content', k]} />)}
        {lines.length > 6 && (
          <button className="link-btn" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Collapse' : `Show all ${lines.length} lines`}
          </button>
        )}
        <TruncNote rec={rec} path={`message/content/${block}`} onLoad={onOpen} />
      </div>
    </div>
  );
}

function EditDiff({ input }: { input: any }) {
  const edits: { old_string: string; new_string: string }[] = Array.isArray(input?.edits)
    ? input.edits
    : typeof input?.old_string === 'string'
      ? [{ old_string: input.old_string, new_string: input.new_string ?? '' }]
      : [];
  if (!edits.length) return null;
  return (
    <div className="diff">
      {edits.slice(0, 4).map((e, k) => (
        <div key={k} className="diff-hunk">
          {e.old_string.split('\n').slice(0, 12).map((l, j) => <div key={'o' + j} className="diff-del">- {l}</div>)}
          {e.new_string.split('\n').slice(0, 12).map((l, j) => <div key={'n' + j} className="diff-add">+ {l}</div>)}
        </div>
      ))}
    </div>
  );
}

function metaSummary(rec: LightRecord): { icon: React.ReactNode; label: string; text: string } {
  const d = rec.data || {};
  switch (rec.type) {
    case 'attachment': {
      const a = d.attachment || {};
      let text = '';
      if (Array.isArray(a.content)) text = a.content.map((x: any) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' · ');
      else if (typeof a.content === 'string') text = a.content;
      else if (a.prompt) text = a.prompt;
      else if (a.addedNames) text = `+${a.addedNames.length} ${a.addedNames.slice(0, 6).join(', ')}`;
      else if (a.filename) text = a.filename;
      if (a.hookName) text = `${a.hookName}: ${text}`;
      return { icon: <Info size={13} />, label: `attachment · ${a.type || '?'}`, text };
    }
    case 'system':
      return { icon: <AlertTriangle size={13} />, label: `system · ${d.subtype || ''}`, text: d.content || d.stopReason || (d.hookCount ? `${d.hookCount} hook(s)` : '') };
    case 'api-request':
      return { icon: <Server size={13} />, label: 'API request', text: `${d.params?.model || ''} · keeps ${d.keep ?? 0} msg(s) + ${d.tail?.length ?? 0} new · effort ${d.params?.output_config?.effort ?? '-'}` };
    case 'api-request-blob':
      return { icon: <Server size={13} />, label: 'API message blob', text: `${d.message?.role || ''} · ${d.hash?.slice(0, 12) || ''}` };
    case 'custom-title':
    case 'ai-title':
    case 'agent-name':
      return { icon: <Tag size={13} />, label: rec.type, text: d.customTitle || d.aiTitle || d.agentName || '' };
    case 'queue-operation':
      return { icon: <ListOrdered size={13} />, label: `queue · ${d.operation}`, text: typeof d.content === 'string' ? d.content : '' };
    case 'last-prompt':
      return { icon: <Tag size={13} />, label: 'last-prompt', text: d.lastPrompt || '' };
    case 'file-history-snapshot':
    case 'file-history-delta':
      return { icon: <History size={13} />, label: rec.type, text: d.trackingPath || Object.keys(d.snapshot?.trackedFileBackups || {}).join(', ') };
    case '(invalid)':
      return { icon: <AlertTriangle size={13} />, label: 'invalid JSON', text: rec.parseError || '' };
    default:
      return { icon: <Info size={13} />, label: rec.type, text: Object.keys(d).filter((k) => k !== 'type' && k !== 'sessionId').slice(0, 6).join(', ') };
  }
}

export const RowView = memo(function RowView({ row, file, edited, deleted, selected, hit, actions, hasSubagent }: Props) {
  const cls = `row row-${row.kind} ${edited ? 'is-edited' : ''} ${deleted ? 'is-deleted' : ''} ${selected ? 'is-selected' : ''} ${hit ? 'is-hit' : ''}`;
  const rec = row.rec;
  const badge = (
    <>
      {edited && <span className="pill pill-edit">edited</span>}
      {deleted && <span className="pill pill-del">will be deleted</span>}
    </>
  );

  if (row.kind === 'user') {
    const compact = rec.data?.isCompactSummary;
    return (
      <div className={cls}>
        <div className={`user-bubble ${row.meta ? 'meta' : ''} ${compact ? 'compact' : ''}`}>
          <div className="row-head">
            <span className="prompt-glyph">&gt;</span>
            <span className="who">{compact ? 'Compacted summary' : row.meta ? 'Injected (meta) user message' : 'You'}</span>
            <span className="ts">{fmtTime(rec.ts)}</span>
            {badge}
            <Toolbar row={row} deleted={deleted} actions={actions} />
          </div>
          <UserContent file={file} row={row} />
          <TruncNote rec={rec} path="message/content" onLoad={() => actions.edit(rec.i)} />
        </div>
      </div>
    );
  }

  if (row.kind === 'text') {
    const c = rec.data?.message?.content;
    const b = row.block >= 0 ? c?.[row.block] : null;
    const text = row.block < 0 ? (typeof c === 'string' ? c : JSON.stringify(c)) : b?.type === 'text' ? b.text : JSON.stringify(b, null, 2);
    const synthetic = rec.data?.message?.model === '<synthetic>';
    return (
      <div className={cls}>
        <div className="assistant-block">
          <span className={`dot ${synthetic ? 'dot-muted' : ''}`}>●</span>
          <div className="assistant-body">
            <div className="float-tools">
              {synthetic && <span className="pill">synthetic</span>}
              {b && b.type !== 'text' && <span className="pill">{b.type}</span>}
              {badge}
              <Toolbar row={row} deleted={deleted} actions={actions} editBlock={row.block} />
            </div>
            <Markdown text={text || ''} />
            <TruncNote rec={rec} path={`message/content/${row.block}`} onLoad={() => actions.edit(rec.i, row.block)} />
          </div>
        </div>
      </div>
    );
  }

  if (row.kind === 'thinking') {
    return <ThinkingRow cls={cls} row={row} badge={badge} deleted={deleted} actions={actions} />;
  }

  if (row.kind === 'tool') {
    const b = rec.data?.message?.content?.[row.block] || {};
    const isError = row.result?.rec.data?.message?.content?.[row.result.block]?.is_error;
    const name: string = b.name || '?';
    const isAgent = name === 'Agent' || name === 'Task';
    return (
      <ToolRow
        cls={cls}
        row={row}
        name={name}
        b={b}
        isError={!!isError}
        isAgent={isAgent}
        hasSubagent={!!hasSubagent}
        badge={badge}
        deleted={deleted}
        actions={actions}
        file={file}
      />
    );
  }

  if (row.kind === 'orphan-result') {
    return (
      <div className={cls}>
        <div className="assistant-block">
          <span className="dot dot-muted">●</span>
          <div className="assistant-body">
            <div className="row-head slim">
              <span className="tool-name muted">Tool result (call not in this file)</span>
              {badge}
              <Toolbar row={row} deleted={deleted} actions={actions} editBlock={row.block} />
            </div>
            <ResultBody rec={rec} block={row.block} file={file} onOpen={() => actions.edit(rec.i, row.block)} />
          </div>
        </div>
      </div>
    );
  }

  if (row.kind === 'meta') {
    const m = metaSummary(rec);
    return (
      <div className={cls}>
        <div className="meta-line" onDoubleClick={() => actions.edit(rec.i)}>
          {m.icon}
          <span className="meta-label">{m.label}</span>
          <span className="meta-text">{m.text}</span>
          {rec.type === 'api-request' && rec.data?.id && (
            <button className="chip-btn" onClick={() => actions.openApi(rec.data.id)}>View payload</button>
          )}
          {badge}
          <Toolbar row={row} deleted={deleted} actions={actions} />
        </div>
      </div>
    );
  }

  // raw
  return (
    <div className={cls}>
      <div className="raw-line" onDoubleClick={() => actions.edit(rec.i)}>
        <span className="raw-no">{rec.i + 1}</span>
        <span className={`type-badge t-${rec.type.replace(/[^a-z]/g, '')}`}>{rec.type}</span>
        <span className="raw-uuid">{shortId(rec.uuid)}</span>
        <span className="raw-preview">{JSON.stringify(rec.data)?.slice(0, 260)}</span>
        <span className="raw-bytes">{fmtBytes(rec.bytes)}</span>
        {badge}
        <Toolbar row={row} deleted={deleted} actions={actions} />
      </div>
    </div>
  );
});

function ThinkingRow({ cls, row, badge, deleted, actions }: any) {
  const [open, setOpen] = useState(false);
  const b = row.rec.data?.message?.content?.[row.block] || {};
  const text: string = b.thinking || (b.type === 'redacted_thinking' ? '(redacted)' : '');
  return (
    <div className={cls}>
      <div className="assistant-block">
        <span className="dot dot-think">✻</span>
        <div className="assistant-body">
          <div className="row-head slim">
            <button className="disclosure" onClick={() => setOpen(!open)}>
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Brain size={13} /> <span className="think-label">Thinking</span>
              {!open && <span className="think-preview">{text.replace(/\s+/g, ' ').slice(0, 140)}</span>}
            </button>
            {badge}
            <Toolbar row={row} deleted={deleted} actions={actions} editBlock={row.block} />
          </div>
          {open && <div className="thinking-text">{text}</div>}
        </div>
      </div>
    </div>
  );
}

function ToolRow({ cls, row, name, b, isError, isAgent, hasSubagent, badge, deleted, actions, file }: any) {
  const [open, setOpen] = useState(false);
  const summary = toolSummary(name, b.input);
  const hasDiff = (name === 'Edit' || name === 'MultiEdit') && b.input;
  return (
    <div className={cls}>
      <div className="assistant-block">
        <span className={`dot ${row.result ? (isError ? 'dot-err' : 'dot-ok') : 'dot-pending'}`}>●</span>
        <div className="assistant-body">
          <div className="row-head slim">
            <button className="disclosure tool-head" onClick={() => setOpen(!open)}>
              {isAgent ? <Bot size={13} /> : <Zap size={13} />}
              <span className="tool-name">{prettyToolName(name)}</span>
              {summary && <span className="tool-summary">({summary})</span>}
            </button>
            {isAgent && hasSubagent && (
              <button className="chip-btn" onClick={() => actions.openSubagent(b.id)}>Open subagent</button>
            )}
            {badge}
            <div className="row-tools-group">
              {row.result && !deleted && (
                <button className="chip-btn ghost" title="Edit the tool result" onClick={() => actions.edit(row.result.rec.i, row.result.block)}>Edit result</button>
              )}
              <Toolbar row={row} deleted={deleted} actions={actions} editBlock={row.block} />
            </div>
          </div>
          {open && <pre className="tool-input">{JSON.stringify(b.input, null, 2)}</pre>}
          {hasDiff && !open && <EditDiff input={b.input} />}
          {row.result ? (
            <ResultBody rec={row.result.rec} block={row.result.block} file={file} onOpen={() => actions.edit(row.result.rec.i, row.result.block)} />
          ) : (
            <div className="tool-result pending"><span className="elbow">⎿</span><span className="muted small">no result recorded</span></div>
          )}
        </div>
      </div>
    </div>
  );
}
