/**
 * The tool-agnostic runner contract.
 *
 * Every backing CLI — Claude Code, Codex, cursor-agent — is driven through this
 * interface and normalized into the same event union before anything else in
 * the system sees it. The normalizer is load-bearing, not glue: it is what lets
 * a session move between tools at all.
 *
 * Capabilities are advertised per runner rather than assumed, because they
 * genuinely differ. Claude Code supports true mid-turn steering via streaming
 * stdin; the others may not. A UI that greys out a steer button it cannot
 * honour is telling the truth, one that silently queues is not.
 */

export type RunnerCapability = 'stream' | 'steer' | 'interrupt' | 'resume' | 'worktree' | 'budget';

export interface RunnerCapabilities {
  readonly capabilities: ReadonlySet<RunnerCapability>;
}

/**
 * 'free' is a budget class rather than a capability class: it routes to local
 * models that cost nothing and cannot be rate-limited, which is what makes it
 * the floor of the failover ladder.
 */
export type ModelTier = 'high' | 'mid' | 'cheap' | 'free';

export interface BrainAccount {
  id: string;
  slug: string;
  provider: string;
  cli: string;
  configDir: string | null;
  env: Record<string, string>;
  tierModels: Partial<Record<ModelTier, string>>;
}

export interface LaunchSpec {
  /** We assign session identity; the CLI adopts it. */
  sessionId: string;
  agentId: string;
  agentSlug: string;
  brain: BrainAccount;
  modelTier: ModelTier;
  cwd: string;

  /** First message. Omitted when resuming an existing conversation. */
  prompt?: string;

  /** Resume a native session rather than starting fresh. */
  resumeSessionId?: string;

  /**
   * The hydration bundle, injected as an appended system prompt. This is how a
   * rehydrated session is told it is continuing someone else's work.
   */
  systemPromptAppend?: string;

  /** Absolute path to an MCP config exposing the Simba tools. */
  mcpConfigPath?: string;

  /**
   * Absolute path to a generated settings file. Carries the PreToolUse guard
   * that enforces the deny list — the only safety gate in a bypassPermissions
   * session, so it must be passed whenever the profile defines one.
   */
  settingsPath?: string;

  /** Hard spend ceiling for this session, enforced by the CLI where supported. */
  maxBudgetUsd?: number;

  /** Thinking effort. Simba runs high; workers run low. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  /** Extra environment, merged over the brain account's own. */
  env?: Record<string, string>;

  /**
   * Deny-list regexes from the agent's permission profile.
   *
   * CLI-backed runners enforce these through a PreToolUse hook, which the CLI
   * applies for us. A runner that owns its own agent loop has no hook to hang
   * them on and must check them itself before executing anything.
   */
  denyPatterns?: string[];
}

// ---------------------------------------------------------------------------
// Normalized event union
// ---------------------------------------------------------------------------

export interface RunnerEventBase {
  sessionId: string;
  /** The provider payload, verbatim. Retained so lossy normalization is recoverable. */
  raw: unknown;
  at: Date;
}

export interface InitEvent extends RunnerEventBase {
  kind: 'init';
  nativeSessionId: string;
  model: string | null;
  cwd: string | null;
  permissionMode: string | null;
  /** "none" indicates subscription auth rather than an API key. */
  apiKeySource: string | null;
  tools: string[];
}

export interface TextEvent extends RunnerEventBase {
  kind: 'text';
  role: 'assistant' | 'user' | 'system';
  text: string;
  /** True for incremental deltas that should not be persisted as their own row. */
  partial: boolean;
}

export interface ReasoningEvent extends RunnerEventBase {
  kind: 'reasoning';
  text: string;
}

export interface ToolCallEvent extends RunnerEventBase {
  kind: 'tool_call';
  toolUseId: string;
  name: string;
  args: unknown;
}

export interface ToolResultEvent extends RunnerEventBase {
  kind: 'tool_result';
  toolUseId: string;
  result: unknown;
  resultText: string | null;
  isError: boolean;
}

/**
 * Rate-limit state, reported by the CLI during normal operation rather than
 * discovered by parsing a failure. `resetsAt` is what sleep-until-reset
 * schedules against.
 */
export interface RateLimitEvent extends RunnerEventBase {
  kind: 'rate_limit';
  status: string;
  limitType: string | null;
  resetsAt: Date | null;
  overageStatus: string | null;
  overageResetsAt: Date | null;
  isUsingOverage: boolean;
}

export interface UsageEvent extends RunnerEventBase {
  kind: 'usage';
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface TurnEndEvent extends RunnerEventBase {
  kind: 'turn_end';
  isError: boolean;
  stopReason: string | null;
  resultText: string | null;
  error: string | null;
  durationMs: number | null;
  usage: Omit<UsageEvent, 'kind' | 'sessionId' | 'raw' | 'at'> | null;
}

export interface ProcessExitEvent extends RunnerEventBase {
  kind: 'exit';
  code: number | null;
  signal: string | null;
}

export interface RunnerErrorEvent extends RunnerEventBase {
  kind: 'error';
  message: string;
  /** Set when the failure is specifically an auth problem — a logged-out brain. */
  authFailure?: boolean;
}

export type RunnerEvent =
  | InitEvent
  | TextEvent
  | ReasoningEvent
  | ToolCallEvent
  | ToolResultEvent
  | RateLimitEvent
  | UsageEvent
  | TurnEndEvent
  | ProcessExitEvent
  | RunnerErrorEvent;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunnerSession {
  readonly sessionId: string;
  readonly nativeSessionId: string | null;
  readonly capabilities: ReadonlySet<RunnerCapability>;
  readonly alive: boolean;

  /** Normalized event stream for the life of the process. */
  events(): AsyncIterableIterator<RunnerEvent>;

  /** Queue a message for the next turn, or steer mid-turn where supported. */
  send(text: string): Promise<void>;

  /** Stop the current turn without killing the session, where supported. */
  interrupt(): Promise<void>;

  /** Terminate the process. The transcript in Postgres is unaffected. */
  kill(): Promise<void>;
}

export interface Runner extends RunnerCapabilities {
  readonly cli: string;
  launch(spec: LaunchSpec): Promise<RunnerSession>;
  /** Whether this runner can resume `nativeSessionId` under `brain`. */
  canResume(brain: BrainAccount, nativeSessionId: string): Promise<boolean>;
}
