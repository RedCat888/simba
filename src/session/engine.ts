import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { query, one, recordEvent } from '../db/index.js';
import { markBrainLimited, markBrainStatus, setSessionStatus } from '../db/repo.js';
import type { RunnerEvent, RunnerSession } from '../runner/types.js';

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
      try {
        await this.persist(event);
      } catch (err) {
        console.error('[engine] persist failed', event.kind, err);
      }
      this.emit('event', event);
    }
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
        const exhausted = e.status !== 'allowed';

        await recordEvent({
          type: 'brain.rate_limit',
          severity: exhausted ? 'warn' : 'debug',
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
          // Only the observed nominal value is trusted. Any other status is
          // treated as non-nominal and the literal string is preserved rather
          // than mapped onto an enum guessed at in advance.
          await markBrainLimited(this.brainAccountId, e.resetsAt);
          this.emit('limitReached', {
            resetsAt: e.resetsAt,
            limitType: e.limitType,
            status: e.status,
          });
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

        await query(
          `UPDATE sessions
              SET total_cost_usd = total_cost_usd + $2,
                  total_input_tokens = total_input_tokens + $3,
                  total_output_tokens = total_output_tokens + $4,
                  status = CASE WHEN status = 'running' THEN 'idle' ELSE status END,
                  last_activity_at = now()
            WHERE id = $1`,
          [this.sessionId, turnCost, u?.inputTokens ?? 0, u?.outputTokens ?? 0],
        );

        const turnId = this.currentTurnId;
        this.currentTurnId = null;
        this.turnStartedAt = null;
        this.emit('turnEnd', { turnId, isError: e.isError, costUsd: turnCost });
        return;
      }

      case 'error': {
        await recordEvent({
          type: e.authFailure ? 'brain.auth_failure' : 'session.error',
          severity: 'error',
          sessionId: this.sessionId,
          agentId: this.agentId,
          brainAccountId: this.brainAccountId,
          message: e.message.slice(0, 2000),
        });
        if (e.authFailure) {
          await markBrainStatus(this.brainAccountId, 'logged_out', e.message.slice(0, 500));
          this.emit('authFailure', { message: e.message });
        }
        return;
      }

      case 'exit': {
        const row = await one<{ status: string }>(`SELECT status FROM sessions WHERE id = $1`, [
          this.sessionId,
        ]);
        // A process exit is only terminal if nothing else has already claimed a
        // more specific outcome (a swap, a deliberate kill).
        if (row && ['running', 'idle', 'pending'].includes(row.status)) {
          await setSessionStatus(this.sessionId, e.code === 0 ? 'completed' : 'failed');
        }
        await recordEvent({
          type: 'session.exit',
          severity: e.code === 0 ? 'info' : 'warn',
          sessionId: this.sessionId,
          agentId: this.agentId,
          message: `process exited code=${e.code} signal=${e.signal ?? 'none'}`,
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
