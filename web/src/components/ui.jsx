import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

/** Lesson body. The hidden `<!-- mastery: … -->` comment is stripped first. */
export function Markdown({ children }) {
  const clean = (children ?? '').replace(/<!--[\s\S]*?-->/g, '');
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
    >
      {clean}
    </ReactMarkdown>
  );
}

export function Icon({ name, size = 16 }) {
  const paths = {
    home: 'M3 9.5 12 3l9 6.5V21H3z',
    plus: 'M12 5v14M5 12h14',
    arrow: 'M12 19V5M5 12l7-7 7 7',
    chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    book: 'M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3z M18 7h2v13H7',
    spark: 'M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z',
    back: 'M15 18l-6-6 6-6',
    next: 'M9 6l6 6-6 6',
    close: 'M6 6l12 12M18 6L6 18',
    file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6',
    trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
    check: 'M20 6L9 17l-5-5',
    chevron: 'M6 9l6 6 6-6',
    ask: 'M9 9a3 3 0 1 1 4 2.8c-.7.3-1 .9-1 1.7v.5M12 17.5v.01',
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.book} />
    </svg>
  );
}

/** Click-outside dropdown. */
export function Popover({ trigger, children, align = 'down', menuClass = '' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div className="pop" ref={ref}>
      {trigger(open, () => setOpen((v) => !v))}
      {open && (
        <div className={`pop-menu ${align} ${menuClass}`}>
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}

export function ModelPicker({ models, value, onChange, align = 'down', compact }) {
  const current = models.find((m) => m.id === value) ?? models[0];
  if (!current) return null;

  return (
    <Popover
      align={align}
      trigger={(open, toggle) => (
        <button
          className={`chip ${open ? 'on' : ''}`}
          onClick={toggle}
          title="Which Claude model generates this"
        >
          <span className="dot" />
          {compact ? current.name : `Model · ${current.name}`}
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="pop-label">Claude model</div>
          {models.map((m) => (
            <button
              key={m.id}
              className={`pop-item ${m.id === value ? 'on' : ''}`}
              onClick={() => {
                onChange(m.id);
                close();
              }}
            >
              <div className="row">
                <span className="name grow">{m.name}</span>
                <span className="tag">{m.tagline}</span>
                {m.id === value && <Icon name="check" size={13} />}
              </div>
              <div className="blurb">{m.blurb}</div>
            </button>
          ))}
          <div
            className="blurb"
            style={{ padding: '8px 11px 4px', borderTop: '1px solid var(--line-soft)', marginTop: 4 }}
          >
            Runs through your Claude Code subscription — no API key.
          </div>
        </>
      )}
    </Popover>
  );
}

export function Notice({ kind = 'error', children, onRetry }) {
  return (
    <div className={`notice notice-${kind}`}>
      <div className="row-between">
        <span>{children}</span>
        {onRetry && (
          <button className="btn btn-ghost btn-sm" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

