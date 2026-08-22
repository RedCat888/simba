import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Markdown } from './Markdown.jsx';

const api = window.simba;

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function Composer({ placeholder, onSend, busy }) {
  const [text, setText] = useState('');
  const send = async () => {
    const next = text.trim();
    if (!next || busy) return;
    setText('');
    await onSend(next);
  };
  return (
    <div className="composer">
      <textarea
        value={text}
        placeholder={placeholder}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button className="go" disabled={busy || !text.trim()} onClick={send}>
        {busy ? '…' : 'Send'}
      </button>
    </div>
  );
}

function Talk({ onLiveTick }) {
  const [homeId, setHomeId] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [stream, setStream] = useState('');
  const [tools, setTools] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const scroller = useRef(null);
  const stick = useRef(true);

  const load = async (id) => {
    if (!id) return;
    const rows = await api.messages(id);
    setMsgs((rows || []).filter((m) => m.role === 'user' || m.role === 'assistant'));
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const home = await api.home();
        if (!alive) return;
        setHomeId(home.sessionId);
        await load(home.sessionId);
      } catch (e) {
        if (alive) setErr(e.message);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!api.onLive) return undefined;
    return api.onLive((msg) => {
      if (msg.type !== 'session_event') return;
      if (homeId && msg.sessionId !== homeId) return;
      if (!homeId && msg.sessionId) setHomeId(msg.sessionId);
      const e = msg.event || {};
      if (e.kind === 'text' && e.role === 'assistant' && e.partial && e.text) {
        setStream((prev) => prev + e.text);
        onLiveTick?.(true);
        return;
      }
      if (e.kind === 'text' && e.role === 'assistant' && !e.partial && e.text?.trim()) {
        setStream('');
        setMsgs((prev) => [...prev, { role: 'assistant', content: e.text, seq: Date.now() }]);
        onLiveTick?.(false);
        return;
      }
      if (e.kind === 'tool_call') {
        setTools((prev) => [...prev.slice(-8), { name: e.name, at: Date.now() }]);
      }
    });
  }, [homeId, onLiveTick]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs, stream, tools]);

  return (
    <section className="talk">
      <header className="talk-head">
        <div>
          <p className="eyebrow">Live thread</p>
          <h1>Talk</h1>
        </div>
        {stream ? <span className="live-pill">writing</span> : null}
      </header>
      {err ? <p className="err">{err}</p> : null}
      <div
        className="thread"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {!msgs.length && !stream ? (
          <p className="empty">Say something. This is the one conversation — phone and desk share it.</p>
        ) : null}
        <AnimatePresence initial={false}>
          {msgs.map((m, i) => (
            <motion.article
              key={m.seq ?? `${m.role}-${i}-${(m.content || '').slice(0, 24)}`}
              className={`bubble ${m.role}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              {m.role === 'assistant' ? <i className="filament" aria-hidden="true" /> : null}
              {m.role === 'assistant' ? <Markdown text={m.content || m.text || ''} /> : <p>{m.content || m.text}</p>}
            </motion.article>
          ))}
        </AnimatePresence>
        {tools.slice(-3).map((t) => (
          <div className="tool" key={t.at}>
            {t.name}
          </div>
        ))}
        {stream ? (
          <article className="bubble assistant live">
            <i className="filament pulse" aria-hidden="true" />
            <Markdown text={stream} live />
          </article>
        ) : null}
      </div>
      <Composer
        placeholder="Talk to Simba…"
        busy={busy}
        onSend={async (text) => {
          setBusy(true);
          setErr('');
          setMsgs((prev) => [...prev, { role: 'user', content: text, seq: Date.now() }]);
          try {
            const r = await api.say(text);
            if (r.sessionId && r.sessionId !== homeId) {
              setHomeId(r.sessionId);
              await load(r.sessionId);
            }
          } catch (e) {
            setErr(e.message);
          } finally {
            setBusy(false);
          }
        }}
      />
    </section>
  );
}

function CardList({ items }) {
  if (!items?.length) return <p className="empty">Nothing here.</p>;
  return items.map((it) => (
    <motion.article
      key={it.id}
      className="sheet"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="row">
        <h3>{it.title || it.kind}</h3>
        <span className="pill">{it.kind}</span>
      </div>
      {it.detail ? <p className="sub">{it.detail}</p> : null}
      <p className="sub">{ago(it.at)}</p>
    </motion.article>
  ));
}

function Today({ goTalk }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.today().then(setData).catch((e) => setErr(e.message));
  }, []);
  if (err) return <p className="err">{err}</p>;
  if (!data) return <p className="empty">Loading today…</p>;
  return (
    <section className="page">
      <p className="eyebrow">Home</p>
      <h1>Today</h1>
      <div className="sec">Needs you</div>
      <CardList items={data.needsMe} />
      <div className="sec">Running</div>
      <CardList items={data.running} />
      <div className="sec">Overnight</div>
      <CardList items={data.overnight} />
      <Composer
        placeholder="Talk to Simba…"
        onSend={async (text) => {
          await api.say(text);
          goTalk();
        }}
      />
    </section>
  );
}

function Inbox() {
  const [pending, setPending] = useState([]);
  const [needs, setNeeds] = useState([]);
  const [sources, setSources] = useState([]);
  const refresh = async () => {
    const [today, acts, intakes] = await Promise.all([
      api.today(),
      api.pending().catch(() => []),
      api.intakes().catch(() => ({ sources: [] })),
    ]);
    setNeeds(today.needsMe || []);
    setPending(acts || []);
    setSources(intakes.sources || []);
  };
  useEffect(() => {
    refresh().catch(() => {});
  }, []);
  return (
    <section className="page">
      <p className="eyebrow">Arrivals</p>
      <h1>Inbox</h1>
      <div className="sec">Approvals</div>
      {!pending.length ? <p className="empty">No pending approvals.</p> : null}
      {pending.map((a) => (
        <article className="sheet" key={a.id}>
          <div className="row">
            <h3>{a.summary || a.action_class || a.id}</h3>
            <span>
              <button className="go" onClick={async () => { await api.confirm(a.id, true); refresh(); }}>
                Approve
              </button>
              <button className="ghost" onClick={async () => { await api.confirm(a.id, false); refresh(); }}>
                Deny
              </button>
            </span>
          </div>
        </article>
      ))}
      <div className="sec">Accounts</div>
      {!sources.length ? <p className="empty">Intake has not polled yet.</p> : null}
      {sources.map((s) => (
        <article className="sheet" key={s.source}>
          <div className="row">
            <h3>{s.source}</h3>
            <span className={`pill ${s.connected ? 'ok' : ''}`}>{s.connected ? 'connected' : 'not connected'}</span>
          </div>
          <p className="sub">{s.note || s.lastError || ''}</p>
        </article>
      ))}
      <button className="go" onClick={() => api.pollIntakes().then(refresh)}>
        Check accounts now
      </button>
      <div className="sec">Needs you</div>
      <CardList items={needs} />
    </section>
  );
}

function Work() {
  const [list, setList] = useState([]);
  const refresh = async () => {
    const missions = await api.missions().catch(() => []);
    setList(Array.isArray(missions) ? missions : missions.items || missions.missions || []);
  };
  useEffect(() => {
    refresh().catch(() => {});
  }, []);
  return (
    <section className="page">
      <p className="eyebrow">Missions</p>
      <h1>Work</h1>
      <Composer
        placeholder="Go do this — Simba will keep going…"
        onSend={async (text) => {
          await api.startMission(text.split('\n')[0].slice(0, 80), text);
          refresh();
        }}
      />
      {!list.length ? <p className="empty">No missions yet.</p> : null}
      {list.map((m) => (
        <article className="sheet" key={m.id}>
          <div className="row">
            <h3>{m.title || m.goal || m.id}</h3>
            <span className="pill">{m.status}</span>
          </div>
          <p className="sub">{m.summary || m.detail || m.blocked_reason || ''}</p>
        </article>
      ))}
    </section>
  );
}

const THEMES = [
  {
    id: 'paper',
    name: 'Paper',
    blurb: 'Daylight notebook. Side rail, soft cards, indigo ink on cool gray.',
    ink: '#f4f5f8',
    paper: '#1b1f27',
    accent: '#3b5bdb',
    layout: 'rail',
  },
  {
    id: 'forest',
    name: 'Forest',
    blurb: 'Workshop daylight. Top bar, square corners, green stamps, serif titles.',
    ink: '#efece4',
    paper: '#1e2420',
    accent: '#2f6a46',
    layout: 'top',
  },
  {
    id: 'navy',
    name: 'Navy',
    blurb: 'Night instrument. Tight rail, small type, ice on navy, built like a tool.',
    ink: '#0b1220',
    paper: '#eaf0f7',
    accent: '#4c8dff',
    layout: 'compact',
  },
  {
    id: 'rose',
    name: 'Rose',
    blurb: 'Evening editorial. Top bar, huge type, charcoal and dusty rose.',
    ink: '#141210',
    paper: '#f4efe9',
    accent: '#d08b8b',
    layout: 'top',
  },
  {
    id: 'ledger',
    name: 'Ledger',
    blurb: 'Mail client. Thread in the middle, Today peeking on the right.',
    ink: '#f7f4ee',
    paper: '#1c1916',
    accent: '#8a4b27',
    layout: 'split',
  },
  {
    id: 'sodium',
    name: 'Sodium',
    blurb: 'The first night look. Filament yellow on ink. Kept as a choice.',
    ink: '#081018',
    paper: '#e8eef4',
    accent: '#f0b429',
    layout: 'rail',
  },
];

function ThemePreview({ theme }) {
  return (
    <div className={`preview layout-${theme.layout}`} style={{ background: theme.ink, color: theme.paper }}>
      <div className="preview-bar" style={{ background: theme.accent }} />
      <div className="preview-line" style={{ background: theme.paper, opacity: 0.35 }} />
      <div className="preview-line short" style={{ background: theme.paper, opacity: 0.2 }} />
      <div className="preview-chip" style={{ background: theme.accent }} />
    </div>
  );
}

function Settings({ theme, onTheme }) {
  return (
    <section className="page settings">
      <p className="eyebrow">Appearance</p>
      <h1>Settings</h1>
      <p className="lead">These are different rooms, not recolors. Layout, type, and chrome change with the palette.</p>
      <div className="theme-gallery">
        {THEMES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`theme-card${theme === t.id ? ' on' : ''}`}
            onClick={() => onTheme(t.id)}
          >
            <ThemePreview theme={t} />
            <h3>{t.name}</h3>
            <p>{t.blurb}</p>
          </button>
        ))}
      </div>
    </section>
  );
}

function LedgerPeek() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    api.today().then((d) => setItems((d.needsMe || []).slice(0, 6))).catch(() => {});
  }, []);
  return (
    <aside className="ledger-peek">
      <p className="eyebrow">Needs you</p>
      {!items.length ? <p className="empty">Clear.</p> : null}
      {items.map((it) => (
        <article className="sheet" key={it.id}>
          <h3>{it.title}</h3>
          <p className="sub">{ago(it.at)}</p>
        </article>
      ))}
    </aside>
  );
}

export function App() {
  const [view, setView] = useState('talk');
  const [live, setLive] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('simba-theme') || 'paper');
  const nav = useMemo(
    () => [
      ['today', 'Today'],
      ['talk', 'Talk'],
      ['inbox', 'Inbox'],
      ['work', 'Work'],
      ['settings', 'Settings'],
    ],
    [],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('simba-theme', theme);
  }, [theme]);

  return (
    <div className="shell" data-theme={theme}>
      <aside>
        <div className="brand">
          <span className={`mark${live ? ' on' : ''}`} />
          Simba
        </div>
        {nav.map(([id, label]) => (
          <button key={id} className={view === id ? 'sel' : ''} onClick={() => setView(id)}>
            {label}
          </button>
        ))}
        <p className="hint">Ctrl+Shift+Space overlay<br />Ctrl+Shift+T talk</p>
      </aside>
      <main>
        {view === 'today' ? <Today goTalk={() => setView('talk')} /> : null}
        {view === 'talk' ? <Talk onLiveTick={setLive} /> : null}
        {view === 'inbox' ? <Inbox /> : null}
        {view === 'work' ? <Work /> : null}
        {view === 'settings' ? <Settings theme={theme} onTheme={setTheme} /> : null}
      </main>
      {theme === 'ledger' ? <LedgerPeek /> : null}
    </div>
  );
}
