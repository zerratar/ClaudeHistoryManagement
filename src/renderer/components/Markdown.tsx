import React, { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const plugins = [remarkGfm];

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  // Very large texts render as plain pre to keep scrolling smooth.
  if (text.length > 60000) return <pre className="plain-pre">{text}</pre>;
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={plugins}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
