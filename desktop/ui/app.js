const $ = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content;
};

let view = 'today';
let homeId = null;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------
//
// The model writes markdown; the thread was printing it as source, so a reply
// arrived with its asterisks showing and its emphasis missing. Everything below
// runs on already-escaped text — esc() first, tags second, always — so a message
// can never inject markup no matter what an agent puts in it.

function inlineMd(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) =>
      // Only schemes that mean "open a page". Anything else stays literal text,
      // because javascript: in a link is a message that runs code.
      /^(https?:|mailto:)/i.test(url)
        ? `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`
        : m)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    // Underscores only at a word boundary. Half the identifiers in this system
    // are snake_case — mission_steps, acceptance_criteria — and treating _ as
    // emphasis anywhere italicised their middles and ate the underscores, so
    // the name on screen stopped matching the name in the database.
    .replace(/(^|[^\w*])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}

// Prose between fences: headings, lists, quotes, rules, paragraphs.
function proseMd(chunk) {
  const out = [];
  let list = null;
  let para = [];

  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const closePara = () => {
    if (para.length) out.push(`<p>${inlineMd(para.join(' '))}</p>`);
    para = [];
  };
  const openList = (tag) => {
    if (list !== tag) {
      closeList();
      out.push(`<${tag}>`);
      list = tag;
    }
  };

  for (const line of chunk.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d{1,9}[.)]\s+(.*)$/.exec(line);
    const quote = /^\s*>\s?(.*)$/.exec(line);

    if (!line.trim()) {
      closePara();
      closeList();
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closePara();
      closeList();
      out.push('<hr>');
    } else if (heading) {
      closePara();
      closeList();
      const level = Math.min(6, heading[1].length + 2);
      out.push(`<h${level}>${inlineMd(heading[2].trim())}</h${level}>`);
    } else if (bullet) {
      closePara();
      openList('ul');
      out.push(`<li>${inlineMd(bullet[1])}</li>`);
    } else if (numbered) {
      closePara();
      openList('ol');
      out.push(`<li>${inlineMd(numbered[1])}</li>`);
    } else if (quote) {
      closePara();
      closeList();
      out.push(`<blockquote>${inlineMd(quote[1])}</blockquote>`);
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  closePara();
  closeList();
  return out.join('');
}

function md(src) {
  // Split on fences first so nothing inside a code block is read as markdown —
  // ** in a shell snippet is a glob, not bold.
  return String(src ?? '')
    .split(/```/)
    .map((chunk, i) => {
      if (i % 2 === 0) return proseMd(chunk);
      const nl = chunk.indexOf('\n');
      const lang = nl < 0 ? '' : chunk.slice(0, nl).trim();
      const code = nl < 0 ? chunk : chunk.slice(nl + 1);
      return `<pre data-lang="${esc(lang || 'code')}"><code>${esc(code.replace(/\n+$/, ''))}</code></pre>`;
    })
    .join('');
}

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

document.querySelectorAll('aside button[data-view]').forEach((b) => {
  b.onclick = () => {
    view = b.dataset.view;
    document.querySelectorAll('aside button').forEach((x) => x.classList.toggle('sel', x === b));
    render();
  };
});

async function render() {
  const main = document.getElementById('main');
  try {
    if (view === 'today') await today(main);
    else if (view === 'talk') await talk(main);
    else if (view === 'inbox') await inbox(main);
    else if (view === 'work') await work(main);
  } catch (e) {
    main.innerHTML = `<h1>Simba</h1><p class="err">${esc(e.message)}</p><p class="sub">Is the gateway running on 127.0.0.1:8787?</p>`;
  }
}

function composer(onSend) {
  const wrap = document.createElement('div');
  wrap.className = 'composer';
  wrap.innerHTML = `<textarea placeholder="Talk to Simba…"></textarea><button class="go">Send</button>`;
  const ta = wrap.querySelector('textarea');
  const send = async () => {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    await onSend(text);
  };
  wrap.querySelector('button').onclick = send;
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  return wrap;
}

function cards(items) {
  if (!items?.length) return '<p class="empty">Nothing here.</p>';
  return items
    .map(
      (it) => `<article class="card">
      <div class="row"><h3>${esc(it.title || it.kind)}</h3><span class="pill">${esc(it.kind)}</span></div>
      ${it.detail ? `<p class="sub">${esc(it.detail)}</p>` : ''}
      <p class="sub">${esc(ago(it.at))}</p>
    </article>`,
    )
    .join('');
}

async function today(main) {
  const data = await window.simba.today();
  main.innerHTML = '';
  main.appendChild($(`<h1>Today</h1>`));
  main.appendChild($(`<div class="sec">Needs you</div>`));
  main.insertAdjacentHTML('beforeend', cards(data.needsMe));
  main.appendChild($(`<div class="sec">Running</div>`));
  main.insertAdjacentHTML('beforeend', cards(data.running));
  main.appendChild($(`<div class="sec">Overnight</div>`));
  main.insertAdjacentHTML('beforeend', cards(data.overnight));
  main.appendChild(
    composer(async (text) => {
      await window.simba.say(text);
      view = 'talk';
      document.querySelectorAll('aside button').forEach((x) => x.classList.toggle('sel', x.dataset.view === 'talk'));
      await render();
    }),
  );
}

async function talk(main) {
  const home = await window.simba.home();
  homeId = home.sessionId;
  main.innerHTML = '<h1>Talk</h1><div id="thread"></div>';
  const thread = main.querySelector('#thread');
  const paint = async () => {
    if (!homeId) {
      thread.innerHTML = '<p class="empty">Say something to start the home thread.</p>';
      return;
    }
    const msgs = await window.simba.messages(homeId);
    thread.innerHTML = (msgs || [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `<div class="msg ${m.role}">${md(m.content || m.text || '')}</div>`)
      .join('');
    thread.lastElementChild?.scrollIntoView({ block: 'end' });
  };
  await paint();
  main.appendChild(
    composer(async (text) => {
      const r = await window.simba.say(text);
      homeId = r.sessionId || homeId;
      await paint();
      let n = 0;
      const tick = setInterval(async () => {
        n += 1;
        if (view !== 'talk' || n > 30) return clearInterval(tick);
        await paint();
      }, 2000);
    }),
  );
}

async function inbox(main) {
  const data = await window.simba.today();
  const pending = await window.simba.pending().catch(() => []);
  const intakes = await window.simba.intakes().catch(() => ({ sources: [] }));
  main.innerHTML = '<h1>Inbox</h1>';
  main.appendChild($(`<div class="sec">Approvals</div>`));
  if (!pending.length) main.insertAdjacentHTML('beforeend', '<p class="empty">No pending approvals.</p>');
  for (const a of pending) {
    const el = document.createElement('article');
    el.className = 'card';
    el.innerHTML = `<div class="row"><h3>${esc(a.summary || a.action_class || a.id)}</h3>
      <span><button class="go" data-ok="1">Approve</button>
      <button data-ok="0" style="margin-left:6px">Deny</button></span></div>`;
    el.querySelectorAll('button').forEach((b) => {
      b.onclick = async () => {
        await window.simba.confirm(a.id, b.dataset.ok === '1');
        await render();
      };
    });
    main.appendChild(el);
  }
  main.appendChild($(`<div class="sec">Accounts</div>`));
  const sources = intakes.sources || [];
  if (!sources.length) {
    main.insertAdjacentHTML('beforeend', '<p class="empty">Intake has not polled yet. It runs every five minutes.</p>');
  } else {
    main.insertAdjacentHTML(
      'beforeend',
      sources
        .map(
          (s) => `<article class="card"><div class="row"><h3>${esc(s.source)}</h3>
          <span class="pill">${s.connected ? 'connected' : 'not connected'}</span></div>
          <p class="sub">${esc(s.note || s.lastError || '')}</p></article>`,
        )
        .join(''),
    );
  }
  const poll = document.createElement('button');
  poll.className = 'go';
  poll.textContent = 'Check accounts now';
  poll.onclick = async () => {
    poll.textContent = 'Checking…';
    await window.simba.pollIntakes().catch((e) => {
      poll.textContent = e.message;
    });
    await render();
  };
  main.appendChild(poll);
  main.appendChild($(`<div class="sec">Needs you</div>`));
  main.insertAdjacentHTML('beforeend', cards(data.needsMe));
}

async function work(main) {
  const missions = await window.simba.missions().catch(() => []);
  const list = Array.isArray(missions) ? missions : missions.items || missions.missions || [];
  main.innerHTML = '<h1>Work</h1>';
  main.appendChild(
    composer(async (text) => {
      const title = text.split('\n')[0].slice(0, 80);
      await window.simba.startMission(title, text);
      await render();
    }),
  );
  main.querySelector('textarea').placeholder = 'Go do this — Simba will keep going…';
  if (!list.length) {
    main.insertAdjacentHTML('beforeend', '<p class="empty">No missions yet.</p>');
    return;
  }
  main.insertAdjacentHTML(
    'beforeend',
    list
      .map(
        (m) => `<article class="card"><div class="row"><h3>${esc(m.title || m.goal || m.id)}</h3>
        <span class="pill">${esc(m.status || '')}</span></div>
        <p class="sub">${esc(m.summary || m.detail || m.blocked_reason || '')}</p></article>`,
      )
      .join(''),
  );
}

render();
setInterval(() => {
  if (view === 'today' || view === 'inbox') render().catch(() => {});
}, 20000);
