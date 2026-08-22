import { useMemo } from 'react';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';

const marked = new Marked(
  markedHighlight({
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    },
  }),
);

marked.setOptions({ gfm: true, breaks: true });

export function Markdown({ text, live = false }) {
  const html = useMemo(() => {
    const raw = marked.parse(String(text ?? ''), { async: false });
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [text]);

  return (
    <div
      className={`md${live ? ' is-live' : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
