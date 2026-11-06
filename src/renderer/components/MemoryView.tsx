import React, { useEffect, useState } from 'react';
import { Brain, Save, Eye, Pencil, FileText } from 'lucide-react';
import { api } from '../api';
import type { ProjectSummary } from '../../shared/types';
import { CodeEditor } from './CodeEditor';
import { Markdown } from './Markdown';

export function MemoryView({ project, initial, toast }: { project: ProjectSummary; initial?: string; toast: (m: string, k?: 'ok' | 'err') => void }) {
  const [name, setName] = useState(initial || project.memoryFiles[0]);
  const [text, setText] = useState('');
  const [orig, setOrig] = useState('');
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!name) return;
    setErr(null);
    api.readMemory(project.dirName, name).then((t) => { setText(t); setOrig(t); }, (e) => setErr(String(e)));
  }, [project.dirName, name]);

  const dirty = text !== orig;
  const switchTo = (n: string) => {
    if (dirty && !confirm('Discard unsaved changes to this memory file?')) return;
    setName(n);
  };
  const save = async () => {
    const r = await api.writeMemory(project.dirName, name, text);
    if (r.ok) { setOrig(text); toast('Memory saved (previous version backed up)'); } else toast(r.error || 'Save failed', 'err');
  };
  const body = text.replace(/^---[\s\S]*?\n---\n?/, '');
  const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1];

  return (
    <div className="memory-view">
      <header className="session-head">
        <div className="session-title-row"><h2 className="session-title"><Brain size={18} className="c-accent" /> Memory · {project.displayName}</h2></div>
        <div className="chips"><span className="chip mono">{project.path}\memory</span></div>
      </header>
      <div className="memory-split">
        <div className="memory-files">
          {project.memoryFiles.map((f) => (
            <button key={f} className={`sess ${f === name ? 'active' : ''}`} onClick={() => switchTo(f)}>
              <div className="sess-title"><FileText size={13} /><span className="ellipsis">{f}</span></div>
            </button>
          ))}
        </div>
        <div className="memory-content">
          <div className="toolbar">
            <div className="seg">
              <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}><Eye size={14} /> Preview</button>
              <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}><Pencil size={14} /> Edit</button>
            </div>
            <div className="spacer" />
            {dirty && <span className="pill pill-edit">unsaved</span>}
            <button className="btn primary small" disabled={!dirty} onClick={save}><Save size={14} /> Save</button>
          </div>
          {err && <div className="error-box">{err}</div>}
          <div className="memory-scroll">
            {mode === 'edit' ? (
              <CodeEditor value={text} onChange={setText} language="markdown" minHeight="400px" />
            ) : (
              <div className="memory-preview">
                {front && <pre className="frontmatter">{front}</pre>}
                <Markdown text={body} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
