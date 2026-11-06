import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Trash2, Link2, Brain, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import type { ChangeReport, LightRecord, SaveRequest } from '../../shared/types';
import { Modal } from './Modals';
import { planRemoval, type RemovalMode, type RemovalPlan, type RemovalTarget } from '../removal';

// ------------------------------------------------------------------ delete preview

export function DeleteModal({ records, deleted, target, isPrompt, onClose, onConfirm }: {
  records: LightRecord[];
  deleted: Set<number>;
  target: RemovalTarget;
  isPrompt: boolean;
  onClose: () => void;
  onConfirm: (plan: RemovalPlan) => void;
}) {
  const [mode, setMode] = useState<RemovalMode>(isPrompt ? 'exchange' : 'only');
  const plans = useMemo(() => {
    const modes: RemovalMode[] = isPrompt ? ['exchange', 'only', 'to-end'] : ['only', 'to-end'];
    return modes.map((m) => ({ mode: m, plan: planRemoval(records, deleted, target, m) }));
  }, [records, deleted, target, isPrompt]);
  const plan = plans.find((p) => p.mode === mode)!.plan;

  const label = (m: RemovalMode) => {
    if (m === 'exchange') return { title: 'This exchange', desc: 'The prompt and everything Claude did in response (replies, thinking, tool calls and results), up to your next prompt.' };
    if (m === 'only') return { title: isPrompt ? 'Only this prompt' : target.block !== undefined ? 'Only this item' : 'Only this record', desc: 'Linked tool calls / results are included automatically so none is left without its partner.' };
    return { title: 'Everything from here to the end', desc: 'Cuts the conversation off at this point. Titles and logs are kept.' };
  };

  return (
    <Modal
      title={<><Trash2 size={16} /> Remove from conversation</>}
      onClose={onClose}
      footer={
        <>
          <span className="muted small">Nothing is written until you save.</span>
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!plan.items.length} onClick={() => onConfirm(plan)}>Mark {plan.items.length} for removal</button>
        </>
      }
    >
      <div className="choice-list">
        {plans.map(({ mode: m, plan: p }) => {
          const l = label(m);
          return (
            <label key={m} className={`choice ${mode === m ? 'active' : ''}`}>
              <input type="radio" name="del-mode" checked={mode === m} onChange={() => setMode(m)} />
              <div className="grow">
                <div className="choice-title">{l.title} <span className="muted small">· {p.items.length} record{p.items.length === 1 ? '' : 's'}</span></div>
                <div className="hint">{l.desc}</div>
              </div>
            </label>
          );
        })}
      </div>
      {mode === 'only' && isPrompt && (
        <div className="warn-box"><AlertTriangle size={13} /> Claude's replies to this prompt stay and will follow the previous turn, as if answering nothing. Usually you want "This exchange", or edit the prompt instead.</div>
      )}
      {plan.linkedCount > 0 && (
        <div className="info-box"><Link2 size={13} /> {plan.linkedCount} linked tool record{plan.linkedCount === 1 ? '' : 's'} added so no tool call is left without its result.</div>
      )}
      <div className="removal-list">
        {plan.items.slice(0, 60).map((it) => (
          <div key={it.i} className="removal-item">
            <span className="mono muted small">#{it.i + 1}</span>
            <span className="ellipsis grow">{it.label}</span>
            {it.partial && <span className="pill">part</span>}
            {it.linked && <span className="pill pill-link">linked</span>}
          </div>
        ))}
        {plan.items.length > 60 && <div className="muted small pad">…and {plan.items.length - 60} more</div>}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ checked save

export function SaveModal({ request, live, saving, saveErr, editedCount, deletedCount, onClose, onJump, onSave }: {
  request: SaveRequest;
  live: boolean;
  saving: boolean;
  saveErr: { msg: string; conflict?: boolean } | null;
  editedCount: number;
  deletedCount: number;
  onClose: () => void;
  onJump: (i: number) => void;
  onSave: (opts: { force?: boolean; stripThinking: boolean; acceptProblems: boolean }) => void;
}) {
  const [report, setReport] = useState<ChangeReport | null>(null);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [strip, setStrip] = useState(true);
  const [accept, setAccept] = useState(false);

  useEffect(() => {
    api.checkSave(request).then(setReport, (e) => setCheckErr(String(e?.message || e)));
    // the request is fixed while the dialog is open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const errors = report?.problems.filter((p) => p.level === 'error') ?? [];
  const warns = report?.problems.filter((p) => p.level === 'warn') ?? [];
  const canSave = !!report && !saving && (!errors.length || accept);

  return (
    <Modal
      title="Save changes"
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          {saveErr?.conflict && <button className="btn danger" onClick={() => onSave({ force: true, stripThinking: strip, acceptProblems: accept })} disabled={!canSave}>Overwrite anyway</button>}
          <button className="btn primary" onClick={() => onSave({ stripThinking: strip, acceptProblems: accept })} disabled={!canSave}>{saving ? 'Saving…' : 'Save to transcript'}</button>
        </>
      }
    >
      <p>{editedCount} record(s) edited and {deletedCount} removed.</p>

      {!report && !checkErr && <div className="muted">Checking the conversation…</div>}
      {checkErr && <div className="error-box">Could not check the change: {checkErr}</div>}

      {report && (
        <>
          {errors.length > 0 ? (
            <div className="error-box">
              <div className="box-title"><AlertTriangle size={14} /> This would break the conversation when resumed</div>
              {errors.slice(0, 8).map((p) => (
                <div key={p.key} className="problem-line">
                  <span className="grow">{p.message}</span>
                  {p.i !== undefined && <button className="link-btn" onClick={() => onJump(p.i!)}>Show</button>}
                </div>
              ))}
              {errors.length > 8 && <div className="small">…and {errors.length - 8} more</div>}
              <label className="check"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /> Save anyway. I understand Claude may refuse to resume this session.</label>
            </div>
          ) : (
            <div className="ok-line"><ShieldCheck size={16} /> Conversation structure OK: every tool call still has its result, and it starts with a user message.</div>
          )}
          {warns.map((p) => <div key={p.key} className="warn-box"><AlertTriangle size={13} /> {p.message}</div>)}
          {report.existingProblems > 0 && (
            <div className="muted small">{report.existingProblems} issue(s) were already in this file before your changes; they are not counted here.</div>
          )}

          {report.thinkingBlocksRemoved > 0 && (
            <div className="think-box">
              <label className="check strong">
                <input type="checkbox" checked={strip} onChange={(e) => setStrip(e.target.checked)} />
                <Brain size={14} /> Remove the {report.thinkingBlocksRemoved} thinking block{report.thinkingBlocksRemoved === 1 ? '' : 's'} after the first change{report.firstChange !== null ? ` (line ${report.firstChange + 1})` : ''} (recommended)
              </label>
              <div className="hint">
                Each thinking block is signed together with everything that came before it, so after this change their signatures no longer match.
                Depending on the account, the API either rejects them or passes reasoning written for the old conversation to Claude.
                Removing them keeps every message and tool call; Claude only loses its earlier private reasoning. Thinking before the change is kept.
              </div>
            </div>
          )}
        </>
      )}

      <ul className="bullets">
        <li>A backup of the current file is made first (Backups to restore).</li>
        <li>Written to a temp file and swapped in atomically; unchanged lines stay byte-identical.</li>
        <li>Records after removed ones are re-linked so the conversation chain stays intact.</li>
      </ul>
      {live && <div className="warn-box"><AlertTriangle size={14} /> A running Claude process has this session open. It keeps its own copy in memory; close it first, then resume to pick up your edits.</div>}
      {saveErr && <div className="error-box">{saveErr.msg}</div>}
      {report && !errors.length && !report.thinkingBlocksRemoved && report.firstChange === null && (
        <div className="muted small"><CheckCircle2 size={12} /> Only metadata changes; nothing the model sees is affected.</div>
      )}
    </Modal>
  );
}
