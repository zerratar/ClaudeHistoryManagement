import React, { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderCode, Brain, Search, Upload, RefreshCw, Archive, Radio, Bot, Sparkles } from 'lucide-react';
import type { ProjectSummary } from '../../shared/types';
import { fmtBytes, relTime } from '../util';

export type Selection =
  | { kind: 'session'; file: string; projectDir: string; parent?: { file: string; title: string } }
  | { kind: 'memory'; projectDir: string; name?: string }
  | null;

interface Props {
  projects: ProjectSummary[];
  selection: Selection;
  onSelect(s: Selection): void;
  onRefresh(): void;
  onImport(): void;
  onExport(p: ProjectSummary): void;
  loading: boolean;
}

export function Sidebar({ projects, selection, onSelect, onRefresh, onImport, onExport, loading }: Props) {
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return projects;
    return projects
      .map((p) => {
        const projHit = p.displayName.toLowerCase().includes(q) || (p.cwd || '').toLowerCase().includes(q);
        const sessions = projHit ? p.sessions : p.sessions.filter((s) => s.title.toLowerCase().includes(q) || (s.firstPrompt || '').toLowerCase().includes(q) || s.id.startsWith(q));
        return { ...p, sessions };
      })
      .filter((p) => p.sessions.length || p.displayName.toLowerCase().includes(q));
  }, [projects, filter]);

  const selProject = selection?.projectDir;

  return (
    <nav className="sidebar">
      <div className="sidebar-search">
        <Search size={14} />
        <input placeholder="Filter projects & sessions" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="sidebar-list">
        {filtered.map((p) => {
          const isCollapsed = collapsed[p.dirName] ?? (p.dirName !== selProject && !filter);
          return (
            <div key={p.dirName} className="proj">
              <div className={`proj-head ${p.dirName === selProject ? 'active' : ''}`} onClick={() => setCollapsed({ ...collapsed, [p.dirName]: !isCollapsed })} title={p.cwd || p.dirName}>
                {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                {p.kind === 'scratch' ? <Sparkles size={15} className="c-accent" /> : isCollapsed ? <Folder size={15} /> : <FolderCode size={15} />}
                <div className="proj-name">
                  <span className="ellipsis">{p.displayName}</span>
                  <span className="proj-path ellipsis">{p.cwd || p.dirName}</span>
                </div>
                <span className="count">{p.sessions.length}</span>
                <button className="icon-btn hover-only" title="Export project" onClick={(e) => { e.stopPropagation(); onExport(p); }}><Archive size={13} /></button>
              </div>
              {!isCollapsed && (
                <div className="proj-body">
                  {p.sessions.map((s) => {
                    const active = selection?.kind === 'session' && (selection.file === s.file || selection.parent?.file === s.file);
                    return (
                      <button key={s.id} className={`sess ${active ? 'active' : ''}`} onClick={() => onSelect({ kind: 'session', file: s.file, projectDir: p.dirName })} title={s.firstPrompt || s.title}>
                        <div className="sess-title">
                          {s.live && <Radio size={11} className="c-live" />}
                          <span className="ellipsis">{s.title}</span>
                        </div>
                        <div className="sess-meta">
                          <span>{relTime(s.mtimeMs)}</span>
                          <span>·</span>
                          <span>{fmtBytes(s.size)}</span>
                          {s.subagentCount > 0 && <><span>·</span><Bot size={11} /><span>{s.subagentCount}</span></>}
                        </div>
                      </button>
                    );
                  })}
                  {p.memoryFiles.length > 0 && (
                    <button className={`sess memory ${selection?.kind === 'memory' && selection.projectDir === p.dirName ? 'active' : ''}`} onClick={() => onSelect({ kind: 'memory', projectDir: p.dirName })}>
                      <div className="sess-title"><Brain size={13} className="c-accent" /><span>Memory</span></div>
                      <div className="sess-meta"><span>{p.memoryFiles.length} file(s)</span></div>
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!filtered.length && <div className="muted pad small">{loading ? 'Scanning…' : 'Nothing found'}</div>}
      </div>
      <div className="sidebar-foot">
        <button className="btn ghost small" onClick={onImport}><Upload size={14} /> Import bundle</button>
        <div className="spacer" />
        <button className={`icon-btn ${loading ? 'spin' : ''}`} onClick={onRefresh} title="Rescan"><RefreshCw size={14} /></button>
      </div>
    </nav>
  );
}
