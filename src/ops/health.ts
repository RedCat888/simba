import { query } from '../db/index.js';
import { workerStatus } from '../voice/index.js';
import { config } from '../config.js';

/**
 * What Simba depends on, and whether each of those things is actually there.
 *
 * Written because two dependencies were dead for an unknown stretch while every
 * surface reported the system healthy. Neither failure is loud: Ollama down
 * makes knowledge search answer "No matches" against thirty thousand vectors,
 * and the voice worker down makes speech quietly take two seconds instead of
 * 0.16s. A system that only reports what it *is* doing cannot show either.
 *
 * So each dependency reports three things: whether it is up, what it costs when
 * it is not, and — when down — the reason. `degraded` rather than `down` is the
 * common case here, because Simba keeps serving without any of these; it just
 * serves worse, in ways nobody would notice from the outside.
 */

export type DependencyState = 'up' | 'degraded' | 'down' | 'unknown';

export type Dependency = {
  name: string;
  state: DependencyState;
  detail: string | null;
  /** What stops working, or works worse, while this is not up. */
  impact: string;
};

export type Health = {
  ok: boolean;
  checkedAt: string;
  dependencies: Dependency[];
};

const TIMEOUT_MS = 2500;

/** A fetch that cannot hang the health check itself. */
async function reach(url: string): Promise<{ ok: boolean; detail: string | null }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: abort.signal });
    return { ok: res.ok, detail: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: abort.signal.aborted ? `no response in ${TIMEOUT_MS}ms` : msg };
  } finally {
    clearTimeout(timer);
  }
}

async function checkPostgres(): Promise<Dependency> {
  try {
    await query('SELECT 1');
    return { name: 'postgres', state: 'up', detail: null, impact: 'Everything. Postgres is the only source of truth.' };
  } catch (err) {
    return {
      name: 'postgres',
      state: 'down',
      detail: err instanceof Error ? err.message : String(err),
      impact: 'Everything. Postgres is the only source of truth.',
    };
  }
}

async function checkOllama(): Promise<Dependency> {
  const impact = 'Knowledge search cannot embed a query, so it finds nothing in thirty thousand vectors.';
  const { ok, detail } = await reach(`${config.embedding.endpoint}/api/tags`);
  if (!ok) return { name: 'ollama', state: 'degraded', detail, impact };

  // Running is not the same as usable, and the difference is not academic.
  //
  // On 22 August Ollama was serving /api/tags perfectly while the embedding
  // model was simply absent from the model store - so this check said "up",
  // and every knowledge search failed. Only two models were installed and
  // neither could embed. The dependency worth reporting is the model, not the
  // process that would serve it if it were there.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${config.embedding.endpoint}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.embedding.model }),
      signal: abort.signal,
    });
    if (!res.ok) {
      return {
        name: 'ollama',
        state: 'degraded',
        detail: `running, but the embedding model "${config.embedding.model}" is not installed ` +
                `(ollama pull ${config.embedding.model})`,
        impact,
      };
    }
    return { name: 'ollama', state: 'up', detail: `serving ${config.embedding.model}`, impact };
  } catch (err) {
    return {
      name: 'ollama',
      state: 'degraded',
      detail: err instanceof Error ? err.message : String(err),
      impact,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkVoiceWorker(): Promise<Dependency> {
  try {
    const s = await workerStatus();
    if (!s.up) {
      return {
        name: 'voice-worker',
        state: 'degraded',
        detail: 'not listening on 4878',
        impact: 'Speech still works but pays a model load per sentence: ~2s instead of ~0.16s.',
      };
    }
    return {
      name: 'voice-worker',
      state: s.loaded ? 'up' : 'degraded',
      detail: s.loaded ? `whisper warm on ${s.device ?? 'unknown device'}` : 'listening but model not loaded yet',
      impact: 'Speech still works but pays a model load per sentence: ~2s instead of ~0.16s.',
    };
  } catch (err) {
    return {
      name: 'voice-worker',
      state: 'unknown',
      detail: err instanceof Error ? err.message : String(err),
      impact: 'Speech still works but pays a model load per sentence: ~2s instead of ~0.16s.',
    };
  }
}

export async function systemHealth(): Promise<Health> {
  const dependencies = await Promise.all([checkPostgres(), checkOllama(), checkVoiceWorker()]);
  // `ok` tracks whether anything is actually broken, not whether everything is
  // perfect — a degraded dependency is a real answer, and flipping ok to false
  // for a slow voice worker would make the flag useless for spotting an outage.
  return {
    ok: dependencies.every((d) => d.state !== 'down'),
    checkedAt: new Date().toISOString(),
    dependencies,
  };
}
