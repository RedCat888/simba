/**
 * Write the vision down where it cannot be lost again.
 *
 * It was stated clearly on 7 August, in a follow-up to a reel about a
 * voice-routed personal AI OS, and it lived in exactly one place: a notes.md
 * inside an item folder under ReelAgent. Nothing in Simba knew about it, so
 * every session since has been rediscovering intent from the code instead of
 * reading it — which is the same failure as the wifi request, one level up.
 *
 *   npx tsx scripts/write-vision.ts
 */
import { transaction } from '../src/db/index.js';

const SLUG = 'simba-vision';
const TITLE = 'What Simba is for';

const CONTENT = `# What Simba is for

Stated by the operator on 2026-08-07, as a follow-up to the JARVIS OS reel
(instagram.com/p/DbmO7iVnPkA). Recorded here because it previously existed only
in \`ReelAgent/items/20260807-094401_.../notes.md\`, which nothing in Simba read.

## The shape

A **voice-routed personal operating system**. You speak; it routes the request
to the right capability; the answer comes back aloud. One voice layer over
everything, instead of tabs and context switching.

    voice -> route -> agent/skill -> spoken answer

The reel's version has four parts. Simba already has two of them:

| Part | JARVIS OS | Simba today |
|---|---|---|
| Engine | Claude Code + SKILL.md files | Claude Code sessions, agents, skills, missions — **have it** |
| Memory | Obsidian vault | Postgres + 30k embeddings + the vault — **have it** |
| Voice | local STT + TTS, push-to-talk | **missing** |
| Face | terminal HUD | web UI + Android app — **have it, differently** |

## Where the operator's version is bigger

He was explicit that Simba is the reel's idea plus four things:

1. **A project-manager layer** — not just a personal assistant, something that
   runs projects.
2. **A multi-agent trading team** — agents that trade, improving from outcomes.
3. **Connected to everything** — every account, email, message, platform.
4. **Voice from the phone**, not only desktop push-to-talk.

## Accounts it should reach

From the knowledge base, not guessed:

- **Google** sample-account@gmail.com (the operator Operator) — mail, calendar, drive
- **ProtonMail** PROJECT_OWNER@proton.me
- **Discord** PROJECT_OWNER — active; the *Colonies -> Effect* server is about half
  his activity
- **GitHub** PROJECT_OWNER, Education member
- **Instagram** — personal, plus the @sample-account bot that already feeds ReelAgent
- **YouTube** PROJECT_OWNER
- **Cloudflare** (Workers, Pages, Access, tunnels), **Supabase** (two projects)
- **An M4 MacBook Pro**, alongside this Windows machine
- Interest in **Matrix/Element** for decentralised messaging

## What already exists for the missing pieces

Nothing here needs new infrastructure:

- **STT**: \`faster_whisper\` 1.2.1 is installed in ReelAgent's venv and already
  transcribes every reel's audio.
- **TTS**: Windows SAPI, two voices, no install.
- **Local models**: Ollama holds ten, including qwen2.5-coder:32b.
- **Reach**: \`repos/Agent-Reach\` is already cloned — read/search access to
  YouTube, Twitter, Reddit, GitHub, LinkedIn, Instagram, RSS and Exa. It was
  captured from a reel on 7 August for exactly this purpose.

## Order of work

1. **Voice** — the only named-missing piece, and the one that changes how the
   whole system is used. Desktop push-to-talk first because it is testable
   locally, then the phone.
2. **Connect to everything** — Agent-Reach for read/search; then mail, calendar
   and Discord as first-class intakes beside the existing Instagram one.
3. **PM layer** — missions already do part of this; what is missing is a view
   across projects rather than across sessions.
4. **Trading team** — last, because it is the only part that risks money, and
   the approval path it needs is the one thing here that must not be rushed.
`;

const result = await transaction(async (client) => {
  const existing = await client.query<{ id: string; current_revision: number }>(
    `SELECT id, current_revision FROM documents WHERE slug = $1 AND scope = 'global'`,
    [SLUG],
  );

  let docId: string;
  let revision: number;

  if (existing.rows.length > 0) {
    docId = existing.rows[0]!.id;
    revision = existing.rows[0]!.current_revision + 1;
    await client.query(
      `UPDATE documents SET current_revision = $2, title = $3, updated_at = now() WHERE id = $1`,
      [docId, revision, TITLE],
    );
  } else {
    revision = 1;
    const created = await client.query<{ id: string }>(
      `INSERT INTO documents (slug, kind, scope, title, current_revision)
       VALUES ($1, 'note', 'global', $2, 1) RETURNING id`,
      [SLUG, TITLE],
    );
    docId = created.rows[0]!.id;
  }

  await client.query(
    `INSERT INTO document_revisions (document_id, revision, content) VALUES ($1,$2,$3)`,
    [docId, revision, CONTENT],
  );
  return { docId, revision };
});

console.log(`wrote ${SLUG} revision ${result.revision} (${result.docId})`);
process.exit(0);
