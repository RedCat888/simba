import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { one, query, recordEvent } from '../db/index.js';
import { getSurface } from '../policy/surface.js';
import { config } from '../config.js';
import { googleAccessToken, microsoftAccessToken } from './oauth.js';

const run = promisify(execFile);

export type IntakeStatus = {
  source: string;
  connected: boolean;
  lastError?: string;
  lastPollAt?: string;
  ingested?: number;
  note?: string;
};

let lastStatuses: IntakeStatus[] = [];

export function intakeStatuses(): IntakeStatus[] {
  return lastStatuses;
}

/**
 * Pull mail, chat, and notifications into `captures` so Today/Inbox see them.
 *
 * Each source is optional and silent when unconfigured. Tokens are read from
 * the environment — nothing here invents credentials or writes secrets.
 */
export async function pollIntakes(): Promise<{ ingested: number; statuses: IntakeStatus[] }> {
  const at = new Date().toISOString();
  const statuses: IntakeStatus[] = [];
  let ingested = 0;

  const github = await pollGithub();
  statuses.push({ ...github.status, lastPollAt: at });
  ingested += github.ingested;

  const discord = await pollDiscord();
  statuses.push({ ...discord.status, lastPollAt: at });
  ingested += discord.ingested;

  const google = await pollGoogle();
  statuses.push({ ...google.status, lastPollAt: at });
  ingested += google.ingested;

  const microsoft = await pollMicrosoft();
  statuses.push({ ...microsoft.status, lastPollAt: at });
  ingested += microsoft.ingested;

  const instagram = await pollInstagram();
  statuses.push({ ...instagram.status, lastPollAt: at });
  ingested += instagram.ingested;

  lastStatuses = statuses;
  if (ingested > 0) {
    await recordEvent({
      type: 'capture.received',
      message: `intake pulled ${ingested} item${ingested === 1 ? '' : 's'}`,
      data: { ingested, sources: statuses.filter((s) => (s.ingested ?? 0) > 0).map((s) => s.source) },
    });
  }
  return { ingested, statuses };
}

async function pollGithub(): Promise<{ ingested: number; status: IntakeStatus }> {
  try {
    const { stdout } = await run('gh', ['api', 'notifications?per_page=20'], {
      timeout: 12_000,
      windowsHide: true,
    });
    const notes = JSON.parse(stdout) as Array<{
      id: string;
      reason?: string;
      updated_at?: string;
      subject?: { title?: string; url?: string; type?: string };
      repository?: { full_name?: string };
    }>;
    let ingested = 0;
    for (const n of notes.slice(0, 20)) {
      const repo = n.repository?.full_name ?? 'github';
      const title = n.subject?.title ?? 'GitHub notification';
      const url = n.subject?.url ?? `simba://github/${n.id}`;
      const content = `${repo}: ${title}${n.reason ? ` (${n.reason})` : ''}`;
      if (await ingest({ source: 'github', content, url, title: `${repo} — ${title}` })) ingested += 1;
    }
    return { ingested, status: { source: 'github', connected: true, ingested } };
  } catch (err) {
    const lastError = shortErr(err);
    const needsAuth = /auth|login|401|403|gh:.*not logged/i.test(lastError);
    return {
      ingested: 0,
      status: {
        source: 'github',
        connected: false,
        lastError,
        note: needsAuth
          ? 'Needs `gh auth login` on this machine.'
          : 'GitHub did not answer; will retry on the next poll.',
      },
    };
  }
}

async function pollDiscord(): Promise<{ ingested: number; status: IntakeStatus }> {
  const token = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN;
  const channels = (process.env.DISCORD_INTAKE_CHANNELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!token) {
    await remindOnce(
      'discord-setup',
      'Discord is not connected. Set DISCORD_BOT_TOKEN and DISCORD_INTAKE_CHANNELS (comma-separated channel ids) so Simba can pull messages into Today.',
    );
    return {
      ingested: 0,
      status: { source: 'discord', connected: false, note: 'Set DISCORD_BOT_TOKEN and DISCORD_INTAKE_CHANNELS.' },
    };
  }
  if (channels.length === 0) {
    return {
      ingested: 0,
      status: { source: 'discord', connected: false, note: 'DISCORD_BOT_TOKEN is set, but DISCORD_INTAKE_CHANNELS is empty.' },
    };
  }

  let ingested = 0;
  try {
    for (const channelId of channels.slice(0, 8)) {
      const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=15`, {
        headers: { authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`Discord ${r.status}: ${(await r.text()).slice(0, 160)}`);
      const msgs = (await r.json()) as Array<{
        id: string;
        content?: string;
        timestamp?: string;
        author?: { username?: string };
      }>;
      for (const m of msgs) {
        const text = (m.content ?? '').trim();
        if (!text) continue;
        const url = `https://discord.com/channels/@me/${channelId}/${m.id}`;
        const title = `${m.author?.username ?? 'Discord'}: ${text.slice(0, 80)}`;
        if (await ingest({ source: 'discord', content: text, url, title })) ingested += 1;
      }
    }
    return { ingested, status: { source: 'discord', connected: true, ingested } };
  } catch (err) {
    return { ingested, status: { source: 'discord', connected: false, lastError: shortErr(err), ingested } };
  }
}

async function pollGoogle(): Promise<{ ingested: number; status: IntakeStatus }> {
  // A refresh token where there is one, a pasted access token otherwise. The
  // second is fine for checking a scope and useless for running: it lapses in
  // an hour and then every poll 401s, which reads as a broken integration.
  const auth = await googleAccessToken();
  if (!auth.ok) {
    await remindOnce(
      'google-setup',
      'Google (Gmail + Calendar) is not connected. ' + auth.reason,
    );
    return {
      ingested: 0,
      status: { source: 'google', connected: false, note: auth.reason },
    };
  }
  const token = auth.token;

  let ingested = 0;
  try {
    const mail = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=is:unread newer_than:2d',
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!mail.ok) throw new Error(`Gmail ${mail.status}: ${(await mail.text()).slice(0, 160)}`);
    const list = (await mail.json()) as { messages?: Array<{ id: string }> };
    for (const m of list.messages ?? []) {
      const oneMsg = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
        { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
      );
      if (!oneMsg.ok) continue;
      const body = (await oneMsg.json()) as {
        snippet?: string;
        payload?: { headers?: Array<{ name: string; value: string }> };
      };
      const headers = body.payload?.headers ?? [];
      const subject = headers.find((h) => h.name.toLowerCase() === 'subject')?.value ?? 'Mail';
      const from = headers.find((h) => h.name.toLowerCase() === 'from')?.value ?? '';
      const url = `https://mail.google.com/mail/u/0/#inbox/${m.id}`;
      const content = `${from}: ${subject}\n${body.snippet ?? ''}`.trim();
      if (await ingest({ source: 'gmail', content, url, title: subject })) ingested += 1;
    }

    const cal = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=8&singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(new Date().toISOString())}`,
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (cal.ok) {
      const events = (await cal.json()) as {
        items?: Array<{ id?: string; summary?: string; htmlLink?: string; start?: { dateTime?: string; date?: string } }>;
      };
      for (const ev of events.items ?? []) {
        const when = ev.start?.dateTime ?? ev.start?.date ?? '';
        const title = ev.summary ?? 'Calendar event';
        const url = ev.htmlLink ?? `simba://gcal/${ev.id ?? title}`;
        if (await ingest({ source: 'gcal', content: `${title} — ${when}`, url, title })) ingested += 1;
      }
    }

    return { ingested, status: { source: 'google', connected: true, ingested } };
  } catch (err) {
    return { ingested, status: { source: 'google', connected: false, lastError: shortErr(err), ingested } };
  }
}

async function pollMicrosoft(): Promise<{ ingested: number; status: IntakeStatus }> {
  const auth = await microsoftAccessToken();
  if (!auth.ok) {
    await remindOnce(
      'microsoft-setup',
      'Outlook and Teams are not connected. ' + auth.reason,
    );
    return {
      ingested: 0,
      status: { source: 'microsoft', connected: false, note: auth.reason },
    };
  }
  const token = auth.token;

  let ingested = 0;
  try {
    const mail = await fetch(
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=10&$filter=isRead eq false&$select=id,subject,from,bodyPreview,webLink',
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!mail.ok) throw new Error(`Outlook ${mail.status}: ${(await mail.text()).slice(0, 160)}`);
    const list = (await mail.json()) as {
      value?: Array<{
        id: string;
        subject?: string;
        bodyPreview?: string;
        webLink?: string;
        from?: { emailAddress?: { name?: string; address?: string } };
      }>;
    };
    for (const m of list.value ?? []) {
      const who = m.from?.emailAddress?.name ?? m.from?.emailAddress?.address ?? 'Outlook';
      const title = m.subject ?? 'Mail';
      const url = m.webLink ?? `simba://outlook/${m.id}`;
      const content = `${who}: ${title}\n${m.bodyPreview ?? ''}`.trim();
      if (await ingest({ source: 'outlook', content, url, title })) ingested += 1;
    }

    const chats = await fetch(
      'https://graph.microsoft.com/v1.0/me/chats?$top=8&$select=id,topic,lastUpdatedDateTime',
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (chats.ok) {
      const rooms = (await chats.json()) as { value?: Array<{ id: string; topic?: string }> };
      for (const room of rooms.value ?? []) {
        const msgs = await fetch(
          `https://graph.microsoft.com/v1.0/me/chats/${room.id}/messages?$top=5`,
          { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
        );
        if (!msgs.ok) continue;
        const body = (await msgs.json()) as {
          value?: Array<{ id: string; body?: { content?: string }; from?: { user?: { displayName?: string } } }>;
        };
        for (const m of body.value ?? []) {
          const text = stripHtml(m.body?.content ?? '').trim();
          if (!text) continue;
          const who = m.from?.user?.displayName ?? room.topic ?? 'Teams';
          const url = `simba://teams/${room.id}/${m.id}`;
          if (await ingest({ source: 'teams', content: `${who}: ${text}`, url, title: `${who}: ${text.slice(0, 80)}` })) {
            ingested += 1;
          }
        }
      }
    }

    return { ingested, status: { source: 'microsoft', connected: true, ingested } };
  } catch (err) {
    return { ingested, status: { source: 'microsoft', connected: false, lastError: shortErr(err), ingested } };
  }
}

async function pollInstagram(): Promise<{ ingested: number; status: IntakeStatus }> {
  try {
    const r = await fetch(`${config.reels.url}/health`, {
      signal: AbortSignal.timeout(config.reels.timeoutMs),
      headers: config.reels.token ? { authorization: `Bearer ${config.reels.token}` } : {},
    });
    if (!r.ok) throw new Error(`ReelAgent ${r.status}`);
    return {
      ingested: 0,
      status: {
        source: 'instagram',
        connected: true,
        note: 'ReelAgent is up. Shared reels already land in captures.',
      },
    };
  } catch (err) {
    return {
      ingested: 0,
      status: {
        source: 'instagram',
        connected: false,
        lastError: shortErr(err),
        note: 'Start ReelAgent on :4877 so Instagram shares keep arriving.',
      },
    };
  }
}

async function ingest(item: { source: string; content: string; url: string; title: string }): Promise<boolean> {
  const recent = await one<{ id: string }>(
    `SELECT id FROM captures
      WHERE (url = $1 OR (source = $2 AND content = $3))
        AND created_at > now() - interval '14 days'
      LIMIT 1`,
    [item.url, item.source, item.content],
  );
  if (recent) return false;

  const intake = await getSurface('automation');
  await query(
    `INSERT INTO captures (source, content, url, title, origin_surface_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [item.source, item.content, item.url, item.title, intake?.id ?? null],
  );
  return true;
}

async function remindOnce(source: string, content: string): Promise<void> {
  const existing = await one<{ id: string }>(
    `SELECT id FROM captures
      WHERE source = $1 AND created_at > now() - interval '7 days'
      LIMIT 1`,
    [source],
  );
  if (existing) return;
  const intake = await getSurface('automation');
  await query(
    `INSERT INTO captures (source, content, title, origin_surface_id)
     VALUES ($1, $2, $3, $4)`,
    [source, content, content.slice(0, 120), intake?.id ?? null],
  );
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

function shortErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, ' ').slice(0, 180);
}
