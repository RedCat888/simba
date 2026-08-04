import { randomUUID } from 'node:crypto';
import { mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { EventEmitter } from 'node:events';

import { query, one, recordEvent } from '../db/index.js';
import {
  getAgent,
  getBrain,
  resolveBrainChain,
  nextChainResetAt,
  setSessionStatus,
  getPermissionProfile,
  toBrainAccount,
  type AgentRow,
  type BrainRow,
} from '../db/repo.js';
import { ClaudeRunner, findTranscript, readTranscript } from '../runner/claude.js';
import { CodexRunner } from '../runner/codex.js';
import { CursorRunner } from '../runner/cursor.js';
import { OllamaRunner } from '../runner/ollama.js';
import { OpenCodeRunner } from '../runner/opencode.js';
import type { LaunchSpec, ModelTier, Runner } from '../runner/types.js';
import { SessionEngine } from './engine.js';
import { createWorktree } from './worktree.js';
import { claimSessionSlot, getSurfaceById } from '../policy/surface.js';
import { writeCheckpoint } from '../hydration/checkpoint.js';
import { buildHydrationBrief } from '../hydration/bundle.js';
import { writeSessionSettings } from './settings.js';
import { mcpConfigPathFor } from '../mcp/config.js';
import { config } from '../config.js';

/**
 * Owns live sessions and the brain-failover policy.
 *
 * The failover ladder, in order of preference:
 *
 *   1. Same CLI, different account — copy the transcript file into the target
 *      account's config directory and resume. Near-lossless: the full
 *      conversation carries over, only the credential changes.
 *   2. Cross-tool — a fresh session seeded with the hydration bundle. Lossy by
 *      nature, so it is the fallback, never the first move.
 *   3. Nothing available — sleep until the earliest reset and resume then.
 *
 * Step 1 is why both Claude accounts sit at the front of every brain chain.
 */

interface LiveSession {
  sessionId: string;
  agentId: string;
  agentSlug: string;
  engine: SessionEngine;
  brainId: string;
  cli: string;
  modelTier: ModelTier;
  cwd: string;
  swapping: boolean;
}

const runners: Record<string, Runner> = {
  claude: new ClaudeRunner(),
  codex: new CodexRunner(),
  'cursor-agent': new CursorRunner(),
  ollama: new OllamaRunner(),
  opencode: new OpenCodeRunner(),
};

export class SessionManager extends EventEmitter {
  private readonly live = new Map<string, LiveSession>();

  getLive(sessionId: string): LiveSession | undefined {
    return this.live.get(sessionId);
  }

  listLive(): LiveSession[] {
    return [...this.live.values()];
  }

  /** Starts a new session for an agent, choosing the first usable brain. */
  async start(opts: {
    agent: string;
    prompt?: string;
    cwd?: string;
    projectId?: string | null;
    continuingSessionId?: string | null;
    modelTier?: ModelTier;
    /** Force a specific brain, bypassing the chain. Failover still applies after. */
    brain?: string;
    /** Which surface this originated from. Recorded so actions inherit its authority. */
    surfaceId?: string | null;
    /**
     * Demand an isolated checkout even when nothing else is running.
     *
     * Concurrency is not the only reason to isolate. Unattended work in a
     * repository someone is *using* collides with them just as badly as with
     * another agent, and far more confusingly: a mission rewriting the Android
     * client while the operator had it open looked like ten interfering agents when
     * it was one mission running strictly one session at a time.
     */
    isolate?: boolean;
  }): Promise<{ sessionId: string } | { error: string; sleepUntil?: Date }> {
    const agent = await getAgent(opts.agent);
    if (!agent) return { error: `unknown agent: ${opts.agent}` };

    if (opts.brain) {
      const forced = await getBrain(opts.brain);
      if (!forced) return { error: `unknown brain: ${opts.brain}` };
      if (!runners[forced.cli]) return { error: `no runner for cli: ${forced.cli}` };
      return this.launch(agent, forced, {
        prompt: opts.prompt,
        cwd: opts.cwd,
        projectId: opts.projectId ?? agent.project_id,
        continuingSessionId: opts.continuingSessionId ?? null,
        modelTier: opts.modelTier ?? agent.model_tier,
        surfaceId: opts.surfaceId ?? null,
        isolate: opts.isolate ?? false,
      });
    }

    const chain = await resolveBrainChain(agent, Object.keys(runners));
    if (chain.length === 0) {
      const sleepUntil = await nextChainResetAt(agent);
      await recordEvent({
        type: 'agent.no_brain_available',
        severity: 'warn',
        agentId: agent.id,
        message: sleepUntil
          ? `all brains exhausted; earliest reset ${sleepUntil.toISOString()}`
          : 'all brains exhausted and no reset time known',
      });
      return { error: 'no brain available', sleepUntil: sleepUntil ?? undefined };
    }

    const brain = chain[0]!;
    return this.launch(agent, brain, {
      prompt: opts.prompt,
      cwd: opts.cwd,
      projectId: opts.projectId ?? agent.project_id,
      continuingSessionId: opts.continuingSessionId ?? null,
      modelTier: opts.modelTier ?? agent.model_tier,
      surfaceId: opts.surfaceId ?? null,
      isolate: opts.isolate ?? false,
    });
  }

  private async launch(
    agent: AgentRow,
    brain: BrainRow,
    opts: {
      prompt?: string;
      cwd?: string;
      projectId?: string | null;
      continuingSessionId?: string | null;
      resumeNativeId?: string | null;
      modelTier: ModelTier;
      swapCount?: number;
      surfaceId?: string | null;
      isolate?: boolean;
    },
  ): Promise<{ sessionId: string } | { error: string }> {
    const runner = runners[brain.cli];
    if (!runner) return { error: `no runner for cli: ${brain.cli}` };

    const cwd =
      opts.cwd ??
      (await this.resolveProjectPath(opts.projectId)) ??
      config.root;

    const sessionId = randomUUID();

    // Claim the concurrency slot in the same statement that creates the row.
    //
    // The pre-flight check in canReachAgent is check-then-act: two starts
    // arriving together both count, both see room, and both proceed. On a phone
    // limited to one session that is the difference between the ceiling meaning
    // something and not. Where a surface is known, the insert itself enforces
    // it; where none is (an internal launch, a supervisor revival) there is no
    // ceiling to enforce and a plain insert is correct.
    const surface = opts.surfaceId ? await getSurfaceById(opts.surfaceId) : null;
    const rowData = {
      sessionId,
      agentId: agent.id,
      cli: brain.cli,
      brainId: brain.id,
      nodeId: agent.node_id,
      projectId: opts.projectId ?? null,
      cwd,
      continuingSessionId: opts.continuingSessionId ?? null,
      swapCount: opts.swapCount ?? 0,
    };

    if (surface) {
      const claimed = await claimSessionSlot(surface, rowData);
      if (!claimed) {
        return {
          error:
            `${surface.slug} is at its concurrent session limit ` +
            `(${surface.max_concurrent_sessions}). Finish or stop one first.`,
        };
      }
    } else {
      await query(
        `INSERT INTO sessions
           (id, agent_id, cli, brain_account_id, node_id, project_id, cwd, status,
            hydrated_from_session_id, swap_count, origin_surface_id, started_at, last_activity_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,now(),now())`,
        [
          sessionId,
          agent.id,
          brain.cli,
          brain.id,
          agent.node_id,
          opts.projectId ?? null,
          cwd,
          opts.continuingSessionId ?? null,
          opts.swapCount ?? 0,
          // Inherited across failover and revival: authority is a property of
          // where the work came from, not of which brain happens to run it now.
          opts.surfaceId ?? null,
        ],
      );
    }

    // Isolate the working tree when anything else is already running.
    //
    // Two sessions sharing one checkout edit the same files, and the second to
    // start silently invalidates whatever the first has half-finished. Rather
    // than always paying for a worktree, this isolates only when there is
    // something to be isolated *from* — a lone session in an empty system has
    // nothing to collide with, and the shared checkout is what the user is
    // actually looking at.
    //
    // A continuation deliberately keeps the directory it inherited: the whole
    // value of a hot handoff is the working tree the previous brain left.
    let workdir = cwd;
    const others = this.listLive().filter((s) => s.sessionId !== sessionId).length;
    // Isolate when something else is running, or when the caller demands it.
    // Mission work demands it: the person who asked for the change is usually
    // also using the repository, and colliding with them is indistinguishable
    // from colliding with another agent except that it is more alarming.
    if ((others > 0 || opts.isolate) && !opts.continuingSessionId) {
      const wt = await createWorktree({ repo: cwd, agentSlug: agent.slug, sessionId });
      // createWorktree returns null outside a git repo. Falling back to the
      // shared cwd is correct there — isolation that silently does nothing
      // would be worse than none, and the event log records the attempt.
      if (wt) workdir = wt.path;
    }

    // A continuation gets the hydration bundle; a fresh session gets the
    // agent's standing context only.
    const brief = await buildHydrationBrief(agent.id, {
      continuingSessionId: opts.continuingSessionId ?? null,
      incomingMessage: opts.prompt ?? null,
    });

    const settingsPath = await writeSessionSettings(sessionId, agent.permission_profile_id);

    // CLI runners get the deny-list via the generated PreToolUse hook; runners
    // that own their own agent loop need the patterns directly.
    const profile = await getPermissionProfile(agent.permission_profile_id);

    const spec: LaunchSpec = {
      sessionId,
      agentId: agent.id,
      agentSlug: agent.slug,
      brain: toBrainAccount(brain),
      modelTier: opts.modelTier,
      // The isolated checkout when there is one. Passing the shared `cwd` here
      // while the session row records a worktree would have the agent editing
      // the very files the isolation exists to protect.
      cwd: workdir,
      // The opening prompt is deliberately not handed to the runner. All user
      // input goes through the engine so it is persisted and sequenced the same
      // way regardless of whether it is the first message or the fiftieth.
      resumeSessionId: opts.resumeNativeId ?? undefined,
      systemPromptAppend: brief || undefined,
      settingsPath: settingsPath ?? undefined,
      denyPatterns: profile?.deny_patterns ?? [],
      mcpConfigPath: await mcpConfigPathFor(sessionId, agent.id),
      effort: agent.tier === 0 ? 'high' : 'medium',
    };

    const runnerSession = await runner.launch(spec);
    const engine = new SessionEngine(sessionId, agent.id, brain.id, runnerSession);

    const liveEntry: LiveSession = {
      sessionId,
      agentId: agent.id,
      agentSlug: agent.slug,
      engine,
      brainId: brain.id,
      cli: brain.cli,
      modelTier: opts.modelTier,
      cwd: workdir,
      swapping: false,
    };
    this.live.set(sessionId, liveEntry);

    engine.on('event', (e) => this.emit('event', { sessionId, agentId: agent.id, event: e }));
    engine.on('limitReached', (info) => void this.onLimitReached(liveEntry, info.resetsAt));
    engine.on('authFailure', () => void this.onAuthFailure(liveEntry));
    engine.on('turnEnd', () => void this.onTurnEnd(liveEntry));
    engine.on('exit', () => this.live.delete(sessionId));

    await engine.beginTurn(brain.tier_models?.[opts.modelTier] ?? null, opts.modelTier);
    void engine.consume();

    if (opts.prompt) {
      // Wait for the child's stdin to be ready before the first write; a prompt
      // written too early is silently dropped and the session sits idle.
      await new Promise((r) => setTimeout(r, 400));
      await engine.sendUserMessage(opts.prompt);
    }

    await query(`UPDATE agents SET status = 'running', last_active_at = now() WHERE id = $1`, [
      agent.id,
    ]);
    await recordEvent({
      type: 'session.started',
      sessionId,
      agentId: agent.id,
      brainAccountId: brain.id,
      message: `${agent.slug} started on ${brain.slug} (${opts.modelTier})`,
      data: { cwd, continuing: opts.continuingSessionId ?? null },
    });

    return { sessionId };
  }

  /** Checkpoint after every turn, so recovery never depends on prediction. */
  private async onTurnEnd(live: LiveSession): Promise<void> {
    const brain = await getBrain(live.brainId);
    await writeCheckpoint(live.sessionId, 'periodic', {
      turnId: live.engine.activeTurnId,
      configDir: brain?.config_dir ?? null,
    });
  }

  private async onAuthFailure(live: LiveSession): Promise<void> {
    await recordEvent({
      type: 'brain.logged_out',
      severity: 'error',
      sessionId: live.sessionId,
      agentId: live.agentId,
      brainAccountId: live.brainId,
      message: 'brain is not logged in; failing over',
    });
    await this.failover(live, 'auth');
  }

  private async onLimitReached(live: LiveSession, resetsAt: Date | null): Promise<void> {
    await recordEvent({
      type: 'brain.limit_reached',
      severity: 'warn',
      sessionId: live.sessionId,
      agentId: live.agentId,
      brainAccountId: live.brainId,
      message: resetsAt
        ? `limit reached; resets ${resetsAt.toISOString()}`
        : 'limit reached; no reset time reported',
    });
    await this.failover(live, 'limit');
  }

  /**
   * Moves a session to the next usable brain.
   *
   * Failover happens at a turn boundary, never mid-turn: a turn that is already
   * executing tool calls cannot be spliced onto another brain, so the current
   * turn is allowed to finish (or die) and the handover happens after it.
   */
  async failover(live: LiveSession, cause: 'limit' | 'auth' | 'manual'): Promise<void> {
    if (live.swapping) return;
    live.swapping = true;

    try {
      const agent = await getAgent(live.agentId);
      if (!agent) return;

      const fromBrain = await getBrain(live.brainId);

      // Checkpoint before tearing anything down.
      await writeCheckpoint(live.sessionId, cause === 'limit' ? 'limit_hit' : 'brain_swap', {
        turnId: live.engine.activeTurnId,
        configDir: fromBrain?.config_dir ?? null,
      });

      await live.engine.kill();
      this.live.delete(live.sessionId);
      await setSessionStatus(live.sessionId, 'superseded');

      const chain = await resolveBrainChain(agent, Object.keys(runners));
      const next = chain.find((b) => b.id !== live.brainId);

      if (!next) {
        const sleepUntil = await nextChainResetAt(agent);
        await query(
          `UPDATE sessions SET status = 'waiting_limit' WHERE id = $1`,
          [live.sessionId],
        );
        await query(`UPDATE agents SET status = 'waiting_limit' WHERE id = $1`, [agent.id]);
        await recordEvent({
          type: 'session.sleeping_until_reset',
          severity: 'warn',
          sessionId: live.sessionId,
          agentId: agent.id,
          message: sleepUntil
            ? `every brain exhausted; sleeping until ${sleepUntil.toISOString()}`
            : 'every brain exhausted; no reset time known',
          data: { sleepUntil },
        });
        this.emit('exhausted', { sessionId: live.sessionId, agentId: agent.id, sleepUntil });
        return;
      }

      const nativeId = await this.nativeSessionIdOf(live.sessionId);
      const sameFamily = fromBrain && next.cli === fromBrain.cli;

      // --- Path 1: same CLI. Copy the transcript, resume under the new login.
      if (sameFamily && nativeId && fromBrain?.config_dir && next.config_dir) {
        const copied = await copyTranscript(fromBrain.config_dir, next.config_dir, nativeId);
        if (copied) {
          await recordEvent({
            type: 'brain.swap',
            sessionId: live.sessionId,
            agentId: agent.id,
            brainAccountId: next.id,
            message: `swapped ${fromBrain.slug} -> ${next.slug} via transcript resume (lossless)`,
            data: { mode: 'resume', transcript: copied },
          });

          const result = await this.launch(agent, next, {
            cwd: live.cwd,
            projectId: agent.project_id,
            continuingSessionId: live.sessionId,
            resumeNativeId: nativeId,
            modelTier: live.modelTier,
            swapCount: (await this.swapCountOf(live.sessionId)) + 1,
            surfaceId: await this.surfaceOf(live.sessionId),
          });
          this.emit('swapped', { from: live.sessionId, to: result, mode: 'resume' });
          return;
        }
      }

      // --- Path 2: cross-tool. Fresh session seeded with the hydration bundle.
      await recordEvent({
        type: 'brain.swap',
        sessionId: live.sessionId,
        agentId: agent.id,
        brainAccountId: next.id,
        message: `swapped ${fromBrain?.slug ?? '?'} -> ${next.slug} via rehydration (lossy)`,
        data: { mode: 'rehydrate' },
      });

      const result = await this.launch(agent, next, {
        cwd: live.cwd,
        projectId: agent.project_id,
        continuingSessionId: live.sessionId,
        modelTier: live.modelTier,
        swapCount: (await this.swapCountOf(live.sessionId)) + 1,
        surfaceId: await this.surfaceOf(live.sessionId),
        prompt: 'Continue the work described in your brief. Report what you are picking up first.',
      });
      this.emit('swapped', { from: live.sessionId, to: result, mode: 'rehydrate' });
    } finally {
      live.swapping = false;
    }
  }

  /**
   * Returns the session the message actually went to.
   *
   * Reviving or failing over creates a *new* session id, and this used to
   * return void — so the caller kept its original id. The phone then filtered
   * the event stream for a session that would never speak again: the
   * continuation's output was invisible, and a second follow-up to the old id
   * forked another child off the same parent, silently losing the first one's
   * context. Handing back the live id is what lets a client follow the work
   * across a swap.
   */
  async send(sessionId: string, text: string): Promise<{ sessionId: string }> {
    let live = this.live.get(sessionId);

    // No process attached: the gateway restarted, the machine slept, or the
    // session simply ended. None of that should be visible from the phone —
    // the process is a cache and the transcript is the truth, so bring a
    // process back and carry on. This is the same rehydration path failover
    // uses, which is why it costs nothing extra to support.
    if (!live) {
      const revived = await this.revive(sessionId, text);
      if ('error' in revived) throw new Error(revived.error);
      live = this.live.get(revived.sessionId);
      if (!live) throw new Error('failed to revive session');
      // Launched with this text as its prompt, so the message is delivered —
      // but the caller needs the new id to keep following the conversation.
      return { sessionId: revived.sessionId };
    }

    const brain = await getBrain(live.brainId);
    await live.engine.beginTurn(brain?.tier_models?.[live.modelTier] ?? null, live.modelTier);
    await live.engine.sendUserMessage(text);
    return { sessionId: live.sessionId };
  }

  /**
   * Reattaches to a session with no running process. Prefers a native resume
   * (the transcript is still on disk under that account) and falls back to a
   * fresh, hydrated continuation.
   */
  private async revive(
    sessionId: string,
    prompt: string,
  ): Promise<{ sessionId: string } | { error: string }> {
    const row = await one<{
      agent_id: string;
      cwd: string | null;
      worktree_path: string | null;
      native_session_id: string | null;
      brain_account_id: string | null;
      swap_count: number;
    }>(
      `SELECT agent_id, cwd, worktree_path, native_session_id, brain_account_id, swap_count
         FROM sessions WHERE id = $1`,
      [sessionId],
    );
    if (!row) return { error: `unknown session ${sessionId}` };

    const agent = await getAgent(row.agent_id);
    if (!agent) return { error: 'agent no longer exists' };

    const chain = await resolveBrainChain(agent, Object.keys(runners));
    if (chain.length === 0) {
      const sleepUntil = await nextChainResetAt(agent);
      return {
        error: sleepUntil
          ? `no brain available; resets ${sleepUntil.toISOString()}`
          : 'no brain available',
      };
    }

    // Resuming natively requires the transcript to exist under the chosen
    // account, so prefer the brain that already has it.
    const previous = row.brain_account_id ? await getBrain(row.brain_account_id) : null;
    const preferred =
      previous && chain.some((b) => b.id === previous.id) ? previous : chain[0]!;

    const runner = runners[preferred.cli];
    const canResume =
      runner && row.native_session_id
        ? await runner.canResume(toBrainAccount(preferred), row.native_session_id)
        : false;

    await setSessionStatus(sessionId, 'superseded');
    await recordEvent({
      type: 'session.revived',
      sessionId,
      agentId: agent.id,
      brainAccountId: preferred.id,
      message: canResume
        ? 'reattached via native resume'
        : 'no process and no resumable transcript; continuing from checkpoint',
    });

    return this.launch(agent, preferred, {
      // worktree_path first: an isolated session's work lives there, not in cwd.
      // Resuming from cwd silently drops it — the continuation starts in the
      // shared checkout without the changes, while the only copy stays stranded
      // in a worktree nothing points at any more. That is the one failure mode
      // worktrees were introduced to prevent.
      cwd: row.worktree_path ?? row.cwd ?? undefined,
      projectId: agent.project_id,
      continuingSessionId: sessionId,
      resumeNativeId: canResume ? row.native_session_id! : undefined,
      modelTier: agent.model_tier,
      swapCount: row.swap_count,
      surfaceId: await this.surfaceOf(sessionId),
      prompt,
    });
  }

  /**
   * Startup reconciliation. Sessions recorded as running cannot be, because no
   * process survives a gateway restart; leaving them marked running makes the
   * roster lie and hides genuinely stalled work.
   */
  async reconcileOnStartup(): Promise<number> {
    const rows = await query<{ id: string }>(
      `UPDATE sessions SET status = 'idle'
        WHERE status IN ('running', 'pending')
        RETURNING id`,
    );
    await query(`UPDATE agents SET status = 'idle' WHERE status = 'running'`);
    if (rows.length > 0) {
      await recordEvent({
        type: 'gateway.reconciled',
        message: `marked ${rows.length} orphaned session(s) idle after restart`,
      });
    }
    return rows.length;
  }

  async kill(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return;
    await live.engine.kill();
    this.live.delete(sessionId);
    await setSessionStatus(sessionId, 'killed');
  }

  /** Panic button: stop everything, immediately. */
  async killAll(): Promise<number> {
    const ids = [...this.live.keys()];
    await Promise.all(ids.map((id) => this.kill(id)));
    await query(`UPDATE agents SET status = 'idle' WHERE status = 'running'`);
    await recordEvent({
      type: 'system.panic',
      severity: 'critical',
      message: `panic stop: killed ${ids.length} live sessions`,
    });
    return ids.length;
  }

  private async nativeSessionIdOf(sessionId: string): Promise<string | null> {
    const row = await one<{ native_session_id: string | null }>(
      `SELECT native_session_id FROM sessions WHERE id = $1`,
      [sessionId],
    );
    return row?.native_session_id ?? null;
  }

  /**
   * The surface a session originated from. Carried across failover and revival
   * so a phone-initiated task cannot quietly gain desktop authority by being
   * resumed later by the supervisor.
   */
  private async surfaceOf(sessionId: string): Promise<string | null> {
    const row = await one<{ origin_surface_id: string | null }>(
      `SELECT origin_surface_id FROM sessions WHERE id = $1`,
      [sessionId],
    );
    return row?.origin_surface_id ?? null;
  }

  private async swapCountOf(sessionId: string): Promise<number> {
    const row = await one<{ swap_count: number }>(
      `SELECT swap_count FROM sessions WHERE id = $1`,
      [sessionId],
    );
    return row?.swap_count ?? 0;
  }

  private async resolveProjectPath(projectId: string | null | undefined): Promise<string | null> {
    if (!projectId) return null;
    const row = await one<{ root_path: string | null }>(
      `SELECT root_path FROM projects WHERE id = $1`,
      [projectId],
    );
    return row?.root_path ?? null;
  }
}

/**
 * Copies a Claude Code transcript between account config directories.
 *
 * This is the mechanism that makes same-tool failover near-lossless: the
 * conversation is a plain JSONL file on disk and credentials are separate, so
 * moving accounts is a file copy plus a resume rather than a context rebuild.
 */
export async function copyTranscript(
  fromConfigDir: string,
  toConfigDir: string,
  nativeSessionId: string,
): Promise<string | null> {
  const source = await findTranscript(fromConfigDir, nativeSessionId);
  if (!source) return null;

  // The transcript format is the CLI's private business and can change under
  // us at any update. Validating before relying on it converts a silent
  // failure — resuming into an empty or unparseable conversation, which looks
  // like the agent simply forgot everything — into a clean fallback to
  // rehydration, which always works. Postgres is the canonical record; this
  // path is an optimization and is treated as one.
  if (!(await transcriptLooksValid(source))) {
    await recordEvent({
      type: 'failover.transcript_rejected',
      severity: 'warn',
      message: `transcript for ${nativeSessionId} did not validate; falling back to rehydration`,
      data: { source },
    });
    return null;
  }

  // Preserve the project-slug directory name so the target CLI associates the
  // transcript with the same working directory.
  const projectSlug = basename(dirname(source));
  const targetDir = join(toConfigDir, 'projects', projectSlug);
  const target = join(targetDir, `${nativeSessionId}.jsonl`);

  if (existsSync(target)) return target;

  await mkdir(targetDir, { recursive: true });
  await copyFile(source, target);
  return target;
}

/**
 * Structural sanity check on a transcript before a resume is attempted.
 *
 * Deliberately loose: it asserts only what any conceivable version of the
 * format must have — parseable JSON lines carrying recognisable conversation
 * turns. A stricter check would itself break on harmless format changes, which
 * would defeat the purpose by rejecting transcripts that would have resumed
 * fine.
 */
async function transcriptLooksValid(path: string): Promise<boolean> {
  let lines: string[];
  try {
    lines = await readTranscript(path);
  } catch {
    return false;
  }

  if (lines.length < 2) return false;

  let parsed = 0;
  let conversational = 0;

  for (const line of lines.slice(0, 200)) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    parsed += 1;

    const type = typeof obj.type === 'string' ? obj.type : '';
    const hasMessage = obj.message !== undefined || obj.content !== undefined;
    if (hasMessage || type === 'user' || type === 'assistant') conversational += 1;
  }

  // Most lines should parse, and the file should contain actual turns rather
  // than only metadata.
  return parsed >= Math.min(2, lines.length) && conversational >= 1;
}
