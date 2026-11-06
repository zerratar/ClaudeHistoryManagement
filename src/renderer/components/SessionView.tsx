import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import {
  Brain, Eye, Code2, Search, ChevronUp, ChevronDown, Wand2, Archive, Copy as CopyIcon, Save, Undo2, AlertTriangle,
  FolderOpen, Radio, ArrowLeft, Bot, RefreshCw, X, ArrowUpToLine, ArrowDownToLine,
} from 'lucide-react';
import { api } from '../api';
import type { LoadedSession, LightRecord, SessionSummary, SaveRequest } from '../../shared/types';
import { buildRows, Row, rowRecords } from '../rows';
import { RowView, RowActions } from './RowView';
import { Inspector } from './Inspector';
import { FindReplaceModal, BackupsModal, ApiRequestModal, PromptModal, Modal } from './Modals';
import { SaveModal, DeleteModal } from './SafetyModals';
import { isRealPrompt, type RemovalPlan, type RemovalTarget } from '../removal';
import { fmtBytes, fmtTokens, searchText } from '../util';

interface RemovalGroup {
  whole: number[];
  /** staged value of partially edited records before the removal (undefined = none) */
  prev: Map<number, any>;
}

interface Props {
  file: string;
  summary?: SessionSummary;
  parent?: { file: string; title: string };
  onOpenFile(file: string, parent?: { file: string; title: string }): void;
  onChanged(): void;
  onClone(): void;
  toast(msg: string, kind?: 'ok' | 'err'): void;
}

export function SessionView({ file, summary, parent, onOpenFile, onChanged, onClone, toast }: Props) {
  const [session, setSession] = useState<LoadedSession | null>(null);
  const [progress, setProgress] = useState(0);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [showThinking, setShowThinking] = useState(true);
  const [showMeta, setShowMeta] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  const [pending, setPending] = useState<Map<number, any>>(new Map());
  const [deletes, setDeletes] = useState<Set<number>>(new Set());
  const [inspect, setInspect] = useState<{ i: number; block?: number } | null>(null);
  const [query, setQuery] = useState('');
  const [hitIdx, setHitIdx] = useState(0);
  const [modal, setModal] = useState<
    | null
    | { kind: 'replace' | 'backups' | 'issues' | 'save' }
    | { kind: 'api'; id: string }
    | { kind: 'fork'; i: number }
    | { kind: 'delete'; target: RemovalTarget; prompt: boolean }
  >(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<{ msg: string; conflict?: boolean } | null>(null);
  const vref = useRef<VirtuosoHandle>(null);

  const load = useCallback(async () => {
    setLoadErr(null);
    setProgress(0);
    try {
      const s = await api.loadSession(file);
      setSession(s);
    } catch (e: any) {
      setLoadErr(String(e?.message || e));
    }
  }, [file]);

  useEffect(() => {
    setSession(null);
    setPending(new Map());
    setDeletes(new Set());
    setInspect(null);
    setQuery('');
    load();
    return api.onLoadProgress((p) => { if (p.file.toLowerCase() === file.toLowerCase()) setProgress(p.fraction); });
  }, [file, load]);

  const effective: LightRecord[] = useMemo(() => {
    if (!session) return [];
    if (!pending.size) return session.records;
    return session.records.map((r) => (pending.has(r.i) ? { ...r, data: pending.get(r.i), truncated: [] } : r));
  }, [session, pending]);

  const rows = useMemo(() => buildRows(effective, { showThinking, showMeta, rawMode }), [effective, showThinking, showMeta, rawMode]);

  const subagentByTool = useMemo(() => {
    const m = new Map<string, string>();
    session?.subagents.forEach((s) => { if (s.toolUseId) m.set(s.toolUseId, s.file); });
    return m;
  }, [session]);

  // search
  const textCache = useRef(new Map<number, string>());
  useEffect(() => { textCache.current = new Map(); }, [effective]);
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [] as number[];
    const txt = (r: LightRecord) => {
      let t = textCache.current.get(r.i);
      if (t === undefined) { t = searchText(r.data); textCache.current.set(r.i, t); }
      return t;
    };
    const out: number[] = [];
    rows.forEach((row, idx) => {
      let t = txt(row.rec);
      if (row.kind === 'tool' && row.result) t += '\n' + txt(row.result.rec);
      if (t.includes(q)) out.push(idx);
    });
    return out;
  }, [query, rows]);
  const hitSet = useMemo(() => new Set(hits), [hits]);
  useEffect(() => { setHitIdx(0); if (hits.length) vref.current?.scrollToIndex({ index: hits[0], align: 'center' }); }, [hits]);
  const jump = (d: number) => {
    if (!hits.length) return;
    const n = (hitIdx + d + hits.length) % hits.length;
    setHitIdx(n);
    vref.current?.scrollToIndex({ index: hits[n], align: 'center' });
  };

  const stage = (i: number, obj: any) => setPending((p) => new Map(p).set(i, obj));
  const unstage = (i: number) => setPending((p) => { const n = new Map(p); n.delete(i); return n; });

  // Each delete is a group so undo can put back everything it touched (including linked tool records).
  const [groups, setGroups] = useState<RemovalGroup[]>([]);

  const applyRemoval = async (plan: RemovalPlan) => {
    const del = new Set(deletes);
    const edits = new Map(pending);
    const group: RemovalGroup = { whole: [], prev: new Map() };
    for (const i of plan.whole) {
      if (del.has(i)) continue;
      del.add(i);
      group.whole.push(i);
    }
    for (const [i, blocks] of plan.partial) {
      const base = edits.get(i) ?? (await api.getRecord(file, i)).data;
      const next = JSON.parse(JSON.stringify(base));
      for (const k of blocks) next.message.content.splice(k, 1);
      group.prev.set(i, edits.get(i));
      if (!next.message.content.length) { del.add(i); group.whole.push(i); edits.delete(i); }
      else edits.set(i, next);
    }
    setDeletes(del);
    setPending(edits);
    setGroups((g) => [...g, group]);
    const n = plan.items.length;
    toast(`Marked ${n} record${n === 1 ? '' : 's'} for removal${plan.linkedCount ? ` (incl. ${plan.linkedCount} linked tool record${plan.linkedCount === 1 ? '' : 's'})` : ''} — save to apply`);
  };

  const undoGroupContaining = (i: number) => {
    const g = groups.find((x) => x.whole.includes(i) || x.prev.has(i));
    if (!g) { setDeletes((d) => { const n = new Set(d); n.delete(i); return n; }); return; }
    setDeletes((d) => { const n = new Set(d); g.whole.forEach((k) => n.delete(k)); return n; });
    setPending((p) => {
      const n = new Map(p);
      for (const [k, v] of g.prev) { if (v === undefined) n.delete(k); else n.set(k, v); }
      return n;
    });
    setGroups((gs) => gs.filter((x) => x !== g));
  };

  const discardAll = () => { setPending(new Map()); setDeletes(new Set()); setGroups([]); };

  const jumpToLine = (i: number) => {
    const idx = rows.findIndex((r) => rowRecords(r).includes(i));
    if (idx >= 0) { vref.current?.scrollToIndex({ index: idx, align: 'center' }); return; }
    setRawMode(true);
    setTimeout(() => vref.current?.scrollToIndex({ index: i, align: 'center' }), 60);
  };

  const actions: RowActions = useMemo(() => ({
    edit: (i, block) => setInspect({ i, block }),
    copy: async (i) => { const r = await api.getRecord(file, i); await api.copyText(r.json); toast('Raw JSON copied'); },
    fork: (i) => setModal({ kind: 'fork', i }),
    openApi: (id) => setModal({ kind: 'api', id }),
    openSubagent: (toolUseId) => {
      const f = subagentByTool.get(toolUseId);
      if (f) onOpenFile(f, { file, title: summary?.title || 'session' });
      return !!f;
    },
    deleteRow: (row: Row) => {
      const block = row.kind === 'tool' || row.kind === 'text' || row.kind === 'thinking' || row.kind === 'orphan-result' ? row.block : undefined;
      setModal({ kind: 'delete', target: { i: row.rec.i, block: block !== undefined && block >= 0 ? block : undefined }, prompt: row.kind === 'user' && isRealPrompt(row.rec) });
    },
    undoDelete: (row: Row) => {
      undoGroupContaining(row.rec.i);
      if (row.kind === 'tool' && row.result) undoGroupContaining(row.result.rec.i);
    },
  }), [file, subagentByTool, summary, onOpenFile, toast, groups]);

  const dirtyCount = pending.size + deletes.size;

  const saveRequest = (extra: Partial<SaveRequest>): SaveRequest => ({
    file,
    expected: { size: session!.size, mtimeMs: session!.mtimeMs },
    edits: [...pending.entries()].filter(([i]) => !deletes.has(i)).map(([i, obj]) => ({ i, json: JSON.stringify(obj) })),
    deletes: [...deletes],
    ...extra,
  });

  const save = async (opts: { force?: boolean; stripThinking: boolean; acceptProblems: boolean }) => {
    if (!session) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await api.saveSession(saveRequest(opts));
      if (!res.ok) { setSaveErr({ msg: res.error || 'Save failed', conflict: res.conflict }); return; }
      setModal(null);
      discardAll();
      setInspect(null);
      const removed = res.report?.thinkingBlocksRemoved ?? 0;
      toast(`Saved ${res.changedLines} change(s)${removed ? `, removed ${removed} thinking block(s)` : ''}. Backup created.`);
      await load();
      onChanged();
    } catch (e: any) {
      setSaveErr({ msg: String(e?.message || e) });
    } finally {
      setSaving(false);
    }
  };

  const doFork = async (i: number, title: string) => {
    setModal(null);
    const res = await api.forkSession(file, i, title);
    if (!res.ok || !res.file) { toast(res.error || 'Fork failed', 'err'); return; }
    toast('Forked into a new session');
    onChanged();
    onOpenFile(res.file);
  };

  if (loadErr) return <div className="center-msg error-box">{loadErr}</div>;
  if (!session) {
    return (
      <div className="center-msg">
        <div className="loader"><div className="loader-bar" style={{ width: `${Math.max(4, progress * 100)}%` }} /></div>
        <div className="muted">Reading transcript{summary ? ` · ${fmtBytes(summary.size)}` : ''}…</div>
      </div>
    );
  }

  const st = session.stats;
  const inspectRec = inspect ? session.records[inspect.i] : null;
  const title = parent ? `Subagent · ${session.subagents.length ? '' : ''}${summary?.title || session.id}` : summary?.title || session.id;

  return (
    <div className="session">
      <div className="session-main">
        <header className="session-head">
          {parent && (
            <button className="back-link" onClick={() => onOpenFile(parent.file)}><ArrowLeft size={14} /> {parent.title}</button>
          )}
          <div className="session-title-row">
            <h2 className="session-title" title={title}>{parent ? 'Subagent transcript' : title}</h2>
            {session.live && <span className="pill pill-live"><Radio size={11} /> live</span>}
          </div>
          <div className="chips">
            {st.models.map((m) => <span key={m} className="chip mono">{m}</span>)}
            {st.cwds.slice(0, 2).map((c) => <span key={c} className="chip mono" title="Working directory">{c}</span>)}
            {st.branches.slice(0, 2).map((b) => <span key={b} className="chip mono" title="Git branch">⎇ {b}</span>)}
            <span className="chip">{st.user} prompts/results · {st.assistant} replies · {st.toolUses} tool calls</span>
            <span className="chip" title="Output tokens / last context size">{fmtTokens(st.outputTokens)} out · {fmtTokens(st.lastContextTokens)} ctx</span>
            <span className="chip">{fmtBytes(session.size)}</span>
            {session.issues.length > 0 && (
              <button className="chip warn" onClick={() => setModal({ kind: 'issues' })}><AlertTriangle size={12} /> {session.issues.length} note(s)</button>
            )}
          </div>
          <div className="toolbar">
            <div className="seg">
              <button className={!rawMode ? 'active' : ''} onClick={() => setRawMode(false)}><Eye size={14} /> Conversation</button>
              <button className={rawMode ? 'active' : ''} onClick={() => setRawMode(true)}><Code2 size={14} /> Records</button>
            </div>
            {!rawMode && (
              <>
                <button className={`toggle ${showThinking ? 'on' : ''}`} onClick={() => setShowThinking(!showThinking)}><Brain size={14} /> Thinking</button>
                <button className={`toggle ${showMeta ? 'on' : ''}`} onClick={() => setShowMeta(!showMeta)} title="Attachments, hooks, system records, API request log"><Code2 size={14} /> Context</button>
              </>
            )}
            <div className="search">
              <Search size={14} />
              <input placeholder="Search in conversation" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') jump(e.shiftKey ? -1 : 1); }} />
              {query.trim().length >= 2 && <span className="muted small">{hits.length ? `${hitIdx + 1}/${hits.length}` : '0'}</span>}
              <button className="icon-btn" onClick={() => jump(-1)}><ChevronUp size={14} /></button>
              <button className="icon-btn" onClick={() => jump(1)}><ChevronDown size={14} /></button>
            </div>
            <button className="icon-btn" title="Jump to start" onClick={() => vref.current?.scrollToIndex({ index: 0, align: 'start' })}><ArrowUpToLine size={14} /></button>
            <button className="icon-btn" title="Jump to end" onClick={() => vref.current?.scrollToIndex({ index: rows.length - 1, align: 'end' })}><ArrowDownToLine size={14} /></button>
            <div className="spacer" />
            {session.subagents.length > 0 && !parent && (
              <SubagentMenu subagents={session.subagents} onOpen={(f) => onOpenFile(f, { file, title: summary?.title || 'session' })} />
            )}
            <button className="btn ghost small" onClick={() => setModal({ kind: 'replace' })} title="Find & replace any text in this session"><Wand2 size={14} /> <span className="lbl">Replace</span></button>
            {!parent && <button className="btn ghost small" onClick={onClone} title="Copy this session to another folder/project with rewritten paths"><CopyIcon size={14} /> <span className="lbl">Clone / relocate</span></button>}
            <button className="btn ghost small" onClick={() => setModal({ kind: 'backups' })}><Archive size={14} /> <span className="lbl">Backups</span></button>
            <button className="icon-btn" onClick={() => api.revealInExplorer(file)} title="Show file in Explorer"><FolderOpen size={14} /></button>
            <button className="icon-btn" onClick={() => { if (!dirtyCount || confirm('Discard staged changes and reload?')) { discardAll(); load(); } }} title="Reload from disk"><RefreshCw size={14} /></button>
          </div>
        </header>

        <div className="transcript">
          {rows.length === 0 ? <div className="center-msg muted">No messages</div> : (
            <Virtuoso
              ref={vref}
              style={{ height: '100%' }}
              data={rows}
              increaseViewportBy={{ top: 600, bottom: 1200 }}
              computeItemKey={(_, row) => row.key}
              initialTopMostItemIndex={{ index: Math.max(0, rows.length - 1), align: 'end' }}
              itemContent={(idx, row) => {
                const other = row.kind === 'tool' ? row.result?.rec.i : undefined;
                return (
                  <RowView
                    row={row}
                    file={file}
                    edited={pending.has(row.rec.i) || (other !== undefined && pending.has(other))}
                    deleted={deletes.has(row.rec.i)}
                    selected={inspect?.i === row.rec.i || (other !== undefined && inspect?.i === other)}
                    hit={hitSet.has(idx) && hits[hitIdx] === idx}
                    actions={actions}
                    hasSubagent={row.kind === 'tool' && subagentByTool.has(row.rec.data?.message?.content?.[row.block]?.id)}
                  />
                );
              }}
              components={{ Footer: () => <div style={{ height: dirtyCount ? 90 : 40 }} /> }}
            />
          )}
        </div>

        {dirtyCount > 0 && (
          <div className="pending-bar">
            <span className="pending-dot" />
            <span><b>{pending.size}</b> edited · <b>{deletes.size}</b> deleted — not saved yet</span>
            <div className="spacer" />
            <button className="btn ghost" onClick={discardAll}><Undo2 size={14} /> Discard</button>
            <button className="btn primary" onClick={() => { setSaveErr(null); setModal({ kind: 'save' }); }}><Save size={14} /> Review &amp; save</button>
          </div>
        )}
      </div>

      {inspect && inspectRec && (
        <Inspector
          key={`${file}:${inspect.i}`}
          file={file}
          rec={inspectRec}
          staged={pending.get(inspect.i)}
          isDeleted={deletes.has(inspect.i)}
          focusBlock={inspect.block}
          onStage={(i, o) => { stage(i, o); toast('Change staged — save when ready'); }}
          onUnstage={unstage}
          onDelete={(i) => {
            if (deletes.has(i)) undoGroupContaining(i);
            else setModal({ kind: 'delete', target: { i }, prompt: isRealPrompt(session.records[i]) });
          }}
          onFork={(i) => setModal({ kind: 'fork', i })}
          onClose={() => setInspect(null)}
        />
      )}

      {modal?.kind === 'replace' && (
        <FindReplaceModal
          file={file}
          expected={{ size: session.size, mtimeMs: session.mtimeMs }}
          scopeLines={inspect ? [inspect.i] : undefined}
          hasPending={dirtyCount > 0}
          live={session.live}
          onClose={() => setModal(null)}
          onDone={async (msg) => { setModal(null); toast(msg); await load(); onChanged(); }}
        />
      )}
      {modal?.kind === 'backups' && (
        <BackupsModal file={file} onClose={() => setModal(null)} onRestored={async (m) => { setModal(null); toast(m); discardAll(); await load(); onChanged(); }} />
      )}
      {modal?.kind === 'api' && <ApiRequestModal file={file} id={modal.id} onClose={() => setModal(null)} />}
      {modal?.kind === 'fork' && (
        <PromptModal
          title="Fork session"
          label="Everything up to and including this record is copied into a new session. Title:"
          initial={`Fork of ${summary?.title || session.id.slice(0, 8)}`}
          okText="Create fork"
          onClose={() => setModal(null)}
          onOk={(t) => doFork(modal.i, t)}
        />
      )}
      {modal?.kind === 'issues' && (
        <Modal title="Transcript notes" onClose={() => setModal(null)}>
          <div className="list">
            {session.issues.map((it, k) => (
              <div key={k} className="list-item">
                <AlertTriangle size={14} className={it.level === 'error' ? 'c-err' : 'c-warn'} />
                <div className="grow">{it.message}</div>
                {it.i !== undefined && <button className="btn ghost small" onClick={() => { setModal(null); setRawMode(true); setTimeout(() => vref.current?.scrollToIndex({ index: it.i!, align: 'center' }), 50); }}>Show</button>}
              </div>
            ))}
          </div>
        </Modal>
      )}
      {modal?.kind === 'save' && (
        <SaveModal
          request={saveRequest({ stripThinking: true })}
          live={session.live}
          saving={saving}
          saveErr={saveErr}
          editedCount={pending.size}
          deletedCount={deletes.size}
          onClose={() => setModal(null)}
          onJump={(i) => { setModal(null); jumpToLine(i); }}
          onSave={save}
        />
      )}
      {modal?.kind === 'delete' && (
        <DeleteModal
          records={effective}
          deleted={deletes}
          target={modal.target}
          isPrompt={modal.prompt}
          onClose={() => setModal(null)}
          onConfirm={async (plan) => { setModal(null); await applyRemoval(plan); }}
        />
      )}
    </div>
  );
}

function SubagentMenu({ subagents, onOpen }: { subagents: LoadedSession['subagents']; onOpen: (f: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="menu-wrap">
      <button className="btn ghost small" onClick={() => setOpen(!open)}><Bot size={14} /> Subagents ({subagents.length})</button>
      {open && (
        <div className="menu" onMouseLeave={() => setOpen(false)}>
          {subagents.map((s) => (
            <button key={s.file} className="menu-item" onClick={() => { setOpen(false); onOpen(s.file); }}>
              <span className="ellipsis">{s.description || s.id}</span>
              <span className="muted small">{s.agentType}</span>
            </button>
          ))}
        </div>
      )}
      {open && <div className="menu-catcher" onClick={() => setOpen(false)}><X size={0} /></div>}
    </div>
  );
}
