import React, { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';

const theme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--bg-input)', color: 'var(--text)', fontSize: '12.5px', borderRadius: '8px' },
    '.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--accent)', padding: '8px 0' },
    '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--text-faint)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.025)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
    '&.cm-focused': { outline: '1px solid var(--accent-dim)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(217,119,87,0.28) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-scroller': { lineHeight: '1.55' },
    '.cm-foldPlaceholder': { background: 'var(--bg-elev)', border: 'none', color: 'var(--text-muted)' },
    '.cm-tooltip': { background: 'var(--bg-elev)', border: '1px solid var(--border)' },
  },
  { dark: true },
);

export function CodeEditor(props: {
  value: string;
  onChange?: (v: string) => void;
  language?: 'json' | 'markdown' | 'text';
  readOnly?: boolean;
  minHeight?: string;
  maxHeight?: string;
  lineNumbers?: boolean;
}) {
  const extensions = useMemo(() => {
    const ex = [EditorView.lineWrapping, theme];
    if (props.language === 'json') ex.push(json());
    if (props.language === 'markdown') ex.push(markdown());
    return ex;
  }, [props.language]);
  return (
    <CodeMirror
      value={props.value}
      onChange={props.onChange}
      extensions={extensions}
      theme="dark"
      editable={!props.readOnly}
      readOnly={props.readOnly}
      minHeight={props.minHeight ?? '60px'}
      maxHeight={props.maxHeight}
      basicSetup={{
        lineNumbers: props.lineNumbers ?? props.language === 'json',
        foldGutter: props.language === 'json',
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        autocompletion: false,
        searchKeymap: true,
      }}
    />
  );
}
