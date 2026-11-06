import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MessagesSquare, ShieldCheck, Pencil, ArrowLeftRight, Eye } from 'lucide-react';
import { api } from './api';
import type { BundleManifest, ProjectSummary } from '../shared/types';
import { Sidebar, Selection } from './components/Sidebar';
import { SessionView } from './components/SessionView';
import { MemoryView } from './components/MemoryView';
import { ExportModal, ImportModal } from './components/Modals';

type ModalState =
  | null
  | { kind: 'export'; project: ProjectSummary; preselect?: string[] }
  | { kind: 'import-bundle'; path: string; manifest: BundleManifest }
  | { kind: 'clone'; project: ProjectSummary; sessionIds: string[] };

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<Selection>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: 'ok' | 'err' }[]>([]);
  const [claudeDir, setClaudeDir] = useState('');

  const toast = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 7000 : 3500);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setProjects(await api.listProjects()); } catch (e: any) { toast(String(e?.message || e), 'err'); } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { refresh(); api.claudeDir().then(setClaudeDir); }, [refresh]);

  const project = useMemo(() => projects.find((p) => p.dirName === selection?.projectDir), [projects, selection]);
  const sessionSummary = useMemo(() => {
    if (selection?.kind !== 'session') return undefined;
    for (const p of projects) for (const s of p.sessions) if (s.file === selection.file) return s;
    return undefined;
  }, [projects, selection]);

  const openFile = useCallback((file: string, parent?: { file: string; title: string }) => {
    const norm = file.replace(/\//g, '\\');
    const proj = projects.find((p) => norm.toLowerCase().startsWith(p.path.toLowerCase() + '\\'));
    const rel = proj ? norm.slice(proj.path.length + 1) : '';
    const dir = proj?.dirName || rel.split('\\')[0] || '';
    setSelection({ kind: 'session', file, projectDir: dir, parent });
  }, [projects]);

  const startImport = async () => {
    try {
      const picked = await api.pickBundle();
      if (picked) setModal({ kind: 'import-bundle', path: picked.path, manifest: picked.manifest });
    } catch (e: any) { toast(String(e?.message || e), 'err'); }
  };

  return (
    <div className="app">
      <div className="titlebar">
        <div className="brand"><span className="brand-mark">✻</span> Claude History Manager</div>
        <div className="titlebar-path mono">{claudeDir}</div>
      </div>
      <div className="app-body">
        <Sidebar
          projects={projects}
          selection={selection}
          onSelect={setSelection}
          onRefresh={refresh}
          onImport={startImport}
          onExport={(p) => setModal({ kind: 'export', project: p })}
          loading={loading}
        />
        <main className="content">
          {selection?.kind === 'session' ? (
            <SessionView
              key={selection.file}
              file={selection.file}
              summary={selection.parent ? undefined : sessionSummary}
              parent={selection.parent}
              onOpenFile={openFile}
              onChanged={refresh}
              onClone={() => { if (project && sessionSummary) setModal({ kind: 'clone', project, sessionIds: [sessionSummary.id] }); }}
              toast={toast}
            />
          ) : selection?.kind === 'memory' && project ? (
            <MemoryView key={project.dirName} project={project} initial={selection.name} toast={toast} />
          ) : (
            <Welcome count={projects.reduce((a, p) => a + p.sessions.length, 0)} projects={projects.length} />
          )}
        </main>
      </div>

      {modal?.kind === 'export' && (
        <ExportModal project={modal.project} preselect={modal.preselect} onClose={() => setModal(null)} onDone={(m) => { setModal(null); toast(m); }} />
      )}
      {modal?.kind === 'import-bundle' && (
        <ImportModal source={{ kind: 'bundle', path: modal.path, manifest: modal.manifest }} onClose={() => setModal(null)} onDone={() => { refresh(); }} />
      )}
      {modal?.kind === 'clone' && (
        <ImportModal source={{ kind: 'local', project: modal.project, sessionIds: modal.sessionIds }} onClose={() => setModal(null)} onDone={() => { refresh(); }} />
      )}

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>)}
      </div>
    </div>
  );
}

function Welcome({ count, projects }: { count: number; projects: number }) {
  return (
    <div className="welcome">
      <div className="welcome-mark">✻</div>
      <h1>Your Claude conversations, inspectable and editable</h1>
      <p className="muted">{projects} projects · {count} sessions found. Pick one on the left.</p>
      <div className="welcome-grid">
        <div className="welcome-card"><Eye size={18} /><b>See what was sent</b><span>Tool calls, results, thinking, injected context and the reconstructed API payloads.</span></div>
        <div className="welcome-card"><Pencil size={18} /><b>Edit anything</b><span>Messages, tool inputs, tool outputs, file names, metadata. Stage changes, then save.</span></div>
        <div className="welcome-card"><ShieldCheck size={18} /><b>Safely</b><span>Automatic backups, atomic writes, conflict detection, JSON validation and chain re-linking.</span></div>
        <div className="welcome-card"><ArrowLeftRight size={18} /><b>Move between machines</b><span>Export bundles and import them with path rewriting for the new workstation.</span></div>
      </div>
      <p className="muted small"><MessagesSquare size={12} /> Edits take effect the next time the session is resumed.</p>
    </div>
  );
}
