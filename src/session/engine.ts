import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { query, one, recordEvent } from '../db/index.js';
import { markBrainLimited, markBrainStatus, setSessionStatus } from '../db/repo.js';
import { isAuthFailureMessage, isHardAuthFailure, isRateLimitedMessage, parseUsageResetAt } from '../policy/brains.js';
import type { RunnerEvent, RunnerSession } from '../runner/types.js';

/**
 * Retry a durable write a few times before giving up.
 *
 * Exported and standalone so it can be tested against directly. The previous
 * version of this policy lived inline inside the engine, which meant the only
 * way to check it was to reimplement it in a test — and a test that
 * reimplements the thing it checks verifies nothing about the code that ships.
 *
 * Three attempts with a short backoff. The failures worth surviving here are
 * momentary — a restart, a saturated pool, a lock — and anything durable will
 * still be broken a second later, so retrying longer only delays the report.
 */
export async function withRetry(
  attempt: () => Promise<void>,
  opts: { attempts?: number; backoffMs?: number } = {},
): Promise<{ attemptsUsed: number; error: unknown | null }> {
  const attempts = opts.attempts ?? 3;
  const backoff = opts.backoffMs ?? 150;
  let lastErr: unknown = null;

  for (let i = 0; i < attempts; i++) {
    try {
      await attempt();
      return { attemptsUsed: i + 1, error: null };
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1 && backoff > 0) {
        await new Promise((r) => setTimeout(r, backoff * (i + 1)));
      }
    }
  }
  return { attemptsUsed: attempts, error: lastErr };
}

/**
 * Turns a process exit code into something a human can act on.
 *
 * Windows reports crashes as huge unsigned NTSTATUS values, so the audit log
 * carried lines like `code=3221226505` — technically complete and practically
 * useless. That number is 0xC0000409, a fatal runtime check failure, and
 * knowing that is the difference between "the CLI crashed" and "no idea".
 */
export function describeExit(code: number | null, signal: string | null): string {
  if (signal) return `killed by signal ${signal}`;
  if (code === null) return 'process ended without an exit code (killed or timed out)';
  if (code === 0) return 'exited cleanly';

  // Node surfaces these unsigned; the same value as a signed int is often the
  // more recognisable form (4294967295 is -1).
  const signed = code > 0x7fffffff ? code - 0x100000000 : code;
  const hex = `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

  const NTSTATUS: Record<number, string> = {
    0xc0000005: 'access violation — the CLI crashed',
    0xc0000409: 'stack buffer overrun / fatal runtime check — the CLI crashed',
    0xc000013a: 'terminated by Ctrl+C',
    0xc0000374: 'heap corruption — the CLI crashed',
    0xc00000fd: 'stack overflow — the CLI crashed',
    // Seen in this system's own history: a debugger trap or failed assertion
    // inside the CLI, which exits without saying anything useful on stderr.
    0x80000003: 'breakpoint / assertion trap in the CLI',
  };
  const known = NTSTATUS[code >>> 0];
  if (known) return `${known} (${hex})`;

  if (signed === -1) return 'exited -1 — generic failure, no diagnostic given';
  return `exited with code ${signed}${code > 0x7fffffff ? ` (${hex})` : ''}`;
}

/**
 * Owns one live session: consumes the normalized runner stream, persists it,
 * and re-broadcasts for live consumers (the gateway's websockets).
 *
 * Persistence is deliberately not batched. A crash mid-turn must leave the
 * transcript recoverable up to the last event, because recovery-from-anywhere
 * is what makes the rest of the design (brain swapping, sleeping machines,
 * process-as-cache) safe.
 */

export interface EngineEvents {
  event: (e: RunnerEvent) => void;
  /** The brain reported it is out of headroom; the manager should fail over. */
  limitReached: (info: { resetsAt: Date | null; limitType: string | null; status: string }) => void;
  /** The brain is not logged in. Not recoverable by retrying. */
  authFailure: (info: { message: string }) => void;
  turnEnd: (info: { turnId: string | null; isError: boolean; costUsd: number }) => void;
  exit: (info: { code: number | null }) => void;
}

export declare interface SessionEngine {
  on<K extends keyof EngineEvents>(event: K, listener: EngineEvents[K]): this;
  emit<K extends keyof EngineEvents>(event: K, ...args: Parameters<EngineEvents[K]>): boolean;
}

export class SessionEngine extends EventEmitter {
  private seq = 0;
  private turnSeq = 0;
  private currentTurnId: string | null = null;
  private turnStartedAt: Date | null = null;
  /** tool_use_id -> tool_calls row id, so results can be matched to their call. */
  private readonly pendingTools = new Map<string, string>();
  private lastRateLimit: RunnerEvent | null = null;
  private consuming = false;
  /** Running total reported by the CLI, used to derive per-turn cost deltas. */
  private cumulativeCostUsd = 0;

  constructor(
    readonly sessionId: string,
    readonly agentId: string,
    readonly brainAccountId: string,
    private readonly runner: RunnerSession,
  ) {
    super();
  }

  /** Begins consuming the runner stream. Resolves when the stream closes. */
  async consume(): Promise<void> {
    if (this.consuming) return;
    this.consuming = true;

    for await (const event of this.runner.events()) {
      await this.persistWithRetry(event);
      this.emit('event', event);
    }
  }

  /**
   * Persist an event, retrying briefly before giving up loudly.
   *
   * Every persistence error used to be logged to the console and discarded. A
   * transient database hiccup therefore lost transcript, tool and usage rows
   * while the live client saw the event arrive perfectly — so the session looked
   * healthy and its record was quietly incomplete. Postgres is the source of
   * truth here, which makes a dropped write a correctness bug rather than a
   * logging one: checkpoints, hydration and cost accounting all read what
   * survived.
   *
   * Three attempts with a short backoff. The failures worth surviving are
   * momentary — a restart, a saturated pool, a lock — and anything durable will
   * still be broken in a second, so retrying longer only delays the report.
   */
  private async persistWithRetry(e: RunnerEvent): Promise<void> {
    const { attemptsUsed, error } = await withRetry(() => this.persist(e));

    if (!error) {
      if (attemptsUsed > 1) {
        await recordEvent({
          type: 'session.persist_recovered',
          severity: 'warn',
          sessionId: this.sessionId,
          agentId: this.agentId,
          message: `persisted ${e.kind} on attempt ${attemptsUsed}`,
        });
      }
      return;
    }
    const lastErr = error;

    // Out of attempts. Say so in the audit log rather than only the console:
    // the whole point of an append-only log is that data loss leaves a trace,
    // and a console line in a background process is not a trace anyone finds.
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
    console.error('[engine] persist failed after retries', e.kind, message);
    await recordEvent({
      type: 'session.persist_failed',
      severity: 'critical',
      sessionId: this.sessionId,
      agentId: this.agentId,
      message: `lost a ${e.kind} event: ${message.slice(0, 300)}`,
      data: { kind: e.kind },
    }).catch(() => {
      // If even the audit log is unreachable the database is down, and there is
      // nowhere durable left to complain to.
    });
  }

  private async persist(e: RunnerEvent): Promise<void> {
    switch (e.kind) {
      case 'init':
        await query(
          `UPDATE sessions
              SET native_session_id = $2, status = 'running',
                  started_at = COALESCE(started_at, now()), last_activity_at = now()
            WHERE id = $1`,
          [this.sessionId, e.nativeSessionId],
        );
        await recordEvent({
          type: 'session.init',
          sessionId: this.sessionId,
          agentId: this.agentId,
          brainAccountId: this.brainAccountId,
          message: `session started on ${e.model ?? 'unknown model'}`,
          data: { model: e.model, apiKeySource: e.apiKeySource, tools: e.tools.length },
        });
        // apiKeySource "none" means subscription auth is in play, which is the
        // only mode this system is designed for. Anything else is worth noting.
        if (e.apiKeySource && e.apiKeySource !== 'none') {
          await recordEvent({
            type: 'brain.unexpected_auth',
            severity: 'warn',
            brainAccountId: this.brainAccountId,
            message: `expected subscription auth, saw apiKeySource=${e.apiKeySource}`,
          });
        }
        return;

      case 'text': {
        // Partial deltas are for live display only; the assembled message
        // arrives separately and is what gets persisted.
        if (e.partial) return;
        if (!e.text.trim()) return;
        await this.insertMessage(e.role, e.text, null, e.raw);
        return;
      }

      case 'reasoning':
        if (!e.text.trim()) return;
        await this.insertMessage('assistant', null, e.text, e.raw);
        return;

      case 'tool_call': {
        const id = randomUUID();
        this.pendingTools.set(e.toolUseId, id);
        await query(
          `INSERT INTO tool_calls (id, session_id, turn_id, agent_id, tool_use_id, name, args)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            id,
            this.sessionId,
            this.currentTurnId,
            this.agentId,
            e.toolUseId,
            e.name,
            JSON.stringify(e.args ?? null),
          ],
        );
        await this.touch();
        return;
      }

      case 'tool_result': {
        const id = this.pendingTools.get(e.toolUseId);
        if (!id) {
          // A result without a recorded call means we attached mid-stream.
          // Record it standalone rather than dropping it.
          await query(
            `INSERT INTO tool_calls (session_id, turn_id, agent_id, tool_use_id, name,
                                     result, result_text, is_error)
             VALUES ($1, $2, $3, $4, 'unknown', $5, $6, $7)`,
            [
              this.sessionId,
              this.currentTurnId,
              this.agentId,
              e.toolUseId,
              JSON.stringify(e.result ?? null),
              e.resultText,
              e.isError,
            ],
          );
          return;
        }
        this.pendingTools.delete(e.toolUseId);
        await query(
          `UPDATE tool_calls
              SET result = $2, result_text = $3, is_error = $4,
                  duration_ms = EXTRACT(MILLISECONDS FROM (now() - created_at))::int
            WHERE id = $1`,
          [id, JSON.stringify(e.result ?? null), e.resultText, e.isError],
        );
        await this.touch();
        return;
      }

      case 'rate_limit': {
        this.lastRateLimit = e;

        // Observed values so far: "allowed" and "allowed_warning". The warning
        // means headroom is running low but the account still works — swapping
        // on it burns a perfectly usable brain and, with a short chain, walks
        // straight into the next one. Only a status that is not an allow of
        // some kind is treated as exhausted.
        //
        // The match stays prefix-based rather than an exact enum: the full set
        // of statuses is not documented, and the failure mode of guessing wrong
        // is either premature swapping or a session dying mid-task.
        const allowed = e.status === 'allowed' || e.status.startsWith('allowed');
        const warning = allowed && e.status !== 'allowed';
        const exhausted = !allowed;

        await recordEvent({
          type: 'brain.rate_limit',
          severity: exhausted ? 'warn' : warning ? 'info' : 'debug',
          sessionId: this.sessionId,
          agentId: this.agentId,
          brainAccountId: this.brainAccountId,
          message: `rate limit status=${e.status} type=${e.limitType ?? 'n/a'}`,
          data: {
            status: e.status,
            limitType: e.limitType,
            resetsAt: e.resetsAt,
            isUsingOverage: e.isUsingOverage,
          },
        });

        if (exhausted) {
          // The literal status string is preserved in the event log rather than
          // mapped onto an enum, so an unfamiliar value stays diagnosable.
          await markBrainLimited(
            this.brainAccountId,
            e.resetsAt,
            'limited',
            `rate limit status=${e.status} type=${e.limitType ?? 'n/a'}`,
          );
          this.emit('limitReached', {
            resetsAt: e.resetsAt,
            limitType: e.limitType,
            status: e.status,
          });
        } else if (warning) {
          // Still usable. Recorded so the roster can show the account is close
          // and so a scheduler could prefer a fresher brain for new work, but
          // the running session is left alone.
          await query(
            `UPDATE brain_accounts
                SET status = 'available', limit_resets_at = $2,
                    last_checked_at = now(), last_error = $3
              WHERE id = $1 AND status <> 'logged_out'`,
            [this.brainAccountId, e.resetsAt, `low headroom (${e.status})`],
          );
        } else {
          await query(
            `UPDATE brain_accounts
                SET status = 'available', limit_resets_at = $2, last_checked_at = now()
              WHERE id = $1 AND status <> 'logged_out'`,
            [this.brainAccountId, e.resetsAt],
          );
        }
        return;
      }

      case 'turn_end': {
        const u = e.usage;

        // The CLI reports total_cost_usd cumulatively for the whole session,
        // not per turn. Charging the raw figure to each turn would double-count
        // everything from turn two onward, so the per-turn cost is the delta.
        const cumulative = u?.costUsd ?? 0;
        const turnCost = Math.max(0, cumulative - this.cumulativeCostUsd);
        this.cumulativeCostUsd = Math.max(this.cumulativeCostUsd, cumulative);

        if (this.currentTurnId) {
          await query(
            `UPDATE turns
                SET status = $2, stop_reason = $3, error = $4, ended_at = now(),
                    duration_ms = $5,
                    input_tokens = $6, output_tokens = $7,
                    cache_read_tokens = $8, cache_creation_tokens = $9, cost_usd = $10
              WHERE id = $1`,
            [
              this.currentTurnId,
              e.isError ? 'failed' : 'completed',
              e.stopReason,
              e.error,
              e.durationMs,
              u?.inputTokens ?? 0,
              u?.outputTokens ?? 0,
              u?.cacheReadTokens ?? 0,
              u?.cacheCreationTokens ?? 0,
              turnCost,
            ],
          );

          if (u) {
            await query(
              `INSERT INTO usage (brain_account_id, agent_id, session_id, turn_id, model,
                                  input_tokens, output_tokens, cache_read_tokens,
                                  cache_creation_tokens, cost_usd)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [
                this.brainAccountId,
                this.agentId,
                this.sessionId,
                this.currentTurnId,
                u.model,
                u.inputTokens,
                u.outputTokens,
                u.cacheReadTokens,
                u.cacheCreationTokens,
                turnCost,
              ],
            );
          }
        }

        // Cache tokens are input tokens, and leaving them out made the totals
        // contradict the cost sitting beside them.
        //
        // A live test sent "reply with the word ACKNOWLEDGED" to the home
        // thread. The session recorded total_input_tokens = 2 and
        // total_cost_usd = 1.7758, which reads as a billing fault. It was not:
        // reviving that thread wrote 177,547 tokens of cache, and cache
        // creation is billed and was being counted nowhere. The usage row had
        // the truth all along; the session summary that the CLI, the UI and
        // mission cost roll-ups all read did not.
        const inputTotal =
          (u?.inputTokens ?? 0) + (u?.cacheCreationTokens ?? 0) + (u?.cacheReadTokens ?? 0);
        await query(
          `UPDATE sessions
              SET total_cost_usd = total_cost_usd + $2,
                  total_input_tokens = total_input_tokens + $3,
                  total_output_tokens = total_output_tokens + $4,
                  status = CASE WHEN status = 'running' THEN 'idle' ELSE status END,
                  last_activity_at = now()
            WHERE id = $1`,
          [this.sessionId, turnCost, inputTotal, u?.outputTokens ?? 0],
        );

        const turnId = this.currentTurnId;
        this.currentTurnId = null;
        this.turnStartedAt = null;
        this.emit('turnEnd', { turnId, isError: e.isError, costUsd: turnCost });
        return;
      }

      case 'error': {
        const msg = e.message ?? '';
        const limited = isRateLimitedMessage(msg) && !isHardAuthFailure(msg);
        const authFailure = !limited && Boolean(e.authFailure || isAuthFailureMessage(msg));
        await recordEvent({
          type: authFailure ? 'brain.auth_failure' : limited ? 'brain.rate_limit' : 'session.error',
          severity: 'error',
          sessionId: this.sessionId,
          agentId: this.agentId,
          brainAccountId: this.brainAccountId,
          message: e.message.slice(0, 2000),
        });
        if (authFailure) {
          await markBrainStatus(this.brainAccountId, 'logged_out', e.message.slice(0, 500));
          this.emit('authFailure', { message: e.message });
        } else if (limited) {
          const resetsAt = parseUsageResetAt(msg);
          await markBrainLimited(this.brainAccountId, resetsAt, 'limited', e.message.slice(0, 500));
          this.emit('limitReached', {
            resetsAt,
            limitType: null,
            status: 'exhausted',
          });
        }
        return;
      }

      case 'exit': {
        const row = await one<{ status: string }>(`SELECT status FROM sessions WHERE id = $1`, [
          this.sessionId,
        ]);
        const reason = describeExit(e.code, e.signal);

        // A process exit is only terminal if nothing else has already claimed a
        // more specific outcome (a swap, a deliberate kill).
        if (row && ['running', 'idle', 'pending'].includes(row.status)) {
          await setSessionStatus(this.sessionId, e.code === 0 ? 'completed' : 'failed');
          // The reason goes on the session, not only into the event log.
          // Six sessions were sitting at status 'failed' with a null error
          // because the exit code was recorded as an event and nowhere else —
          // so the app showed "failed" with no explanation, which reads as a
          // bug in Simba rather than a thing that happened to a process.
          if (e.code !== 0) {
            await query(`UPDATE sessions SET error = $2 WHERE id = $1 AND error IS NULL`, [
              this.sessionId,
              reason,
            ]);
          }
        }
        await recordEvent({
          type: 'session.exit',
          severity: e.code === 0 ? 'info' : 'warn',
          sessionId: this.sessionId,
          agentId: this.agentId,
          message: `process exited: ${reason}`,
          data: { code: e.code, signal: e.signal ?? null },
        });
        this.emit('exit', { code: e.code });
        return;
      }

      default:
        return;
    }
  }

  /** Opens a turn. Called by the manager immediately before sending input. */
  async beginTurn(model: string | null, modelTier: string | null): Promise<string> {
    this.turnSeq += 1;
    const id = randomUUID();
    await query(
      `INSERT INTO turns (id, session_id, seq, brain_account_id, model, model_tier, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'running')`,
      [id, this.sessionId, this.turnSeq, this.brainAccountId, model, modelTier],
    );
    this.currentTurnId = id;
    this.turnStartedAt = new Date();
    return id;
  }

  get activeTurnId(): string | null {
    return this.currentTurnId;
  }

  get rateLimitState(): RunnerEvent | null {
    return this.lastRateLimit;
  }

  private async insertMessage(
    role: 'user' | 'assistant' | 'system' | 'tool',
    content: string | null,
    reasoning: string | null,
    raw: unknown,
  ): Promise<void> {
    this.seq += 1;
    await query(
      `INSERT INTO messages (session_id, turn_id, agent_id, seq, role, content, reasoning, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        this.sessionId,
        this.currentTurnId,
        this.agentId,
        this.seq,
        role,
        content,
        reasoning,
        JSON.stringify(raw ?? null),
      ],
    );
    await this.touch();
  }

  private async touch(): Promise<void> {
    await query(`UPDATE sessions SET last_activity_at = now() WHERE id = $1`, [this.sessionId]);
  }

  async sendUserMessage(text: string): Promise<void> {
    this.seq += 1;
    await query(
      `INSERT INTO messages (session_id, turn_id, agent_id, seq, role, content)
       VALUES ($1,$2,$3,$4,'user',$5)`,
      [this.sessionId, this.currentTurnId, this.agentId, this.seq, text],
    );
    await this.runner.send(text);
  }

  async kill(): Promise<void> {
    await this.runner.kill();
  }
}
