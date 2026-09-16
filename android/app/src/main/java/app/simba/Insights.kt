package app.simba

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Everything the gateway already knew and the phone never asked.
 *
 * The backend exposes fifty-three routes; the app called twenty-nine. The
 * twenty-four it ignored are not leftovers — they are the entire difference
 * between a list of statuses and something worth opening. A session's turns,
 * with the model and the duration and the cache reads for each. The structured
 * checkpoint an agent writes about its own work: what it was asked, what it did,
 * what is left, what it is unsure of. The lineage of a piece of work across
 * every brain swap. Two weeks of spend. The machine's memory, per process,
 * sampled since the beginning and never once read back.
 *
 * These are separated from [SimbaApi] because they are a different kind of
 * thing: [Api.kt] is the transport and the shapes the app cannot run without,
 * and this is the depth. Mixing them made a seven-hundred-line file that was
 * hard to find anything in.
 *
 * Every field is optional or defaulted, for the same reason as the rest of the
 * wire models: the gateway ships ahead of the app, and a strict parser turns an
 * added column into a blank screen with no explanation.
 */

// ---------------------------------------------------------------------------
// Sessions, in depth
// ---------------------------------------------------------------------------

/**
 * One turn of one session.
 *
 * The unit that actually costs money and time. A session row says "$1.03" and
 * "running"; the turns say a single turn took six and a half minutes, produced
 * twenty-one thousand output tokens against thirty-four input tokens, and read
 * six hundred thousand from cache — which is the difference between knowing a
 * number and understanding it.
 */
@Serializable
data class Turn(
    val seq: Int = 0,
    val status: String = "",
    val model: String? = null,
    @SerialName("model_tier") val modelTier: String? = null,
    @SerialName("cost_usd") val costUsd: Double = 0.0,
    @SerialName("input_tokens") val inputTokens: Long = 0,
    @SerialName("output_tokens") val outputTokens: Long = 0,
    @SerialName("cache_read_tokens") val cacheReadTokens: Long = 0,
    @SerialName("cache_creation_tokens") val cacheCreationTokens: Long = 0,
    @SerialName("duration_ms") val durationMs: Long? = null,
    @SerialName("stop_reason") val stopReason: String? = null,
    val error: String? = null,
    @SerialName("started_at") val startedAt: String? = null,
    /** Which account served this turn. Changes mid-session when a brain swaps. */
    val brain: String? = null,
) {
    val totalTokens: Long get() = inputTokens + outputTokens

    /** Seconds, for a chart axis that does not need millisecond precision. */
    val seconds: Double get() = (durationMs ?: 0L) / 1000.0
}

/**
 * An agent's own account of where it had got to.
 *
 * Written by the agent, not derived — which is what makes it worth reading.
 * `work_remaining` and `open_questions` in particular are the two things a
 * person actually wants at 3am, and neither can be reconstructed from a
 * transcript without reading the whole transcript.
 */
@Serializable
data class Checkpoint(
    val id: String = "",
    val reason: String = "",
    @SerialName("task_statement") val taskStatement: String? = null,
    @SerialName("work_done") val workDone: String? = null,
    @SerialName("work_remaining") val workRemaining: String? = null,
    val failures: String? = null,
    @SerialName("key_decisions") val keyDecisions: String? = null,
    @SerialName("open_questions") val openQuestions: String? = null,
    @SerialName("git_branch") val gitBranch: String? = null,
    @SerialName("git_head") val gitHead: String? = null,
    @SerialName("git_dirty") val gitDirty: Boolean = false,
    @SerialName("git_diffstat") val gitDiffstat: String? = null,
    @SerialName("recent_files") val recentFiles: List<String> = emptyList(),
    @SerialName("token_estimate") val tokenEstimate: Long = 0,
    @SerialName("created_at") val createdAt: String? = null,
)

/** One session in a chain of continuations. `depth` 0 is the one you asked about. */
@Serializable
data class LineageStep(
    val id: String = "",
    val depth: Int = 0,
    val title: String? = null,
    val status: String = "",
    @SerialName("swap_count") val swapCount: Int = 0,
    @SerialName("total_cost_usd") val cost: Double = 0.0,
    @SerialName("started_at") val startedAt: String? = null,
    val error: String? = null,
)

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

/**
 * One bucket of machine memory.
 *
 * Agents are CLI processes on a home PC, so the failure that actually happens is
 * the box running out of memory overnight. It shows up here — free falling while
 * one process climbs — hours before anything else notices.
 */
@Serializable
data class MemorySample(
    val at: String = "",
    val ts: Long = 0,
    @SerialName("free_mb") val freeMb: Int = 0,
    @SerialName("total_mb") val totalMb: Int = 0,
    @SerialName("claude_desktop_mb") val claudeDesktopMb: Int = 0,
    @SerialName("claude_code_mb") val claudeCodeMb: Int = 0,
    @SerialName("simba_mb") val simbaMb: Int = 0,
    @SerialName("ollama_mb") val ollamaMb: Int = 0,
    @SerialName("postgres_mb") val postgresMb: Int = 0,
    @SerialName("process_count") val processCount: Int = 0,
) {
    val usedMb: Int get() = (totalMb - freeMb).coerceAtLeast(0)

    /** 0..1, for a bar that does not need to know about megabytes. */
    val pressure: Float get() = if (totalMb > 0) usedMb.toFloat() / totalMb else 0f
}

/** One day's spend and volume for one brain. Two weeks of these make a chart. */
@Serializable
data class UsageDay(
    val day: String = "",
    val brain: String = "",
    val cost: Double = 0.0,
    val tokens: Long = 0,
)

// ---------------------------------------------------------------------------
// Configuration and consent
// ---------------------------------------------------------------------------

/**
 * Where a request can come from, and how much it is trusted.
 *
 * This is the security model made visible. The phone is a lower-trust surface
 * than the desktop by design, and `max_model_tier` is the cap that enforces it —
 * facts worth being able to see from the surface being capped.
 */
@Serializable
data class Surface(
    val slug: String = "",
    val name: String = "",
    @SerialName("trust_level") val trustLevel: Int = 0,
    val enabled: Boolean = true,
    @SerialName("max_model_tier") val maxModelTier: String? = null,
    @SerialName("active_sessions") val activeSessions: Int = 0,
    @SerialName("total_sessions") val totalSessions: Int = 0,
    @SerialName("awaiting_confirmation") val awaitingConfirmation: Int = 0,
)

/**
 * Something an agent wants to do that needs a person to say yes.
 *
 * The queue existed on the gateway with no caller, which meant the consent
 * mechanism was real and unreachable — an agent could be blocked waiting for an
 * approval the owner had no way to give from the device they carry.
 */
@Serializable
data class PendingAction(
    val id: String = "",
    @SerialName("action_class") val actionClass: String = "",
    val target: String? = null,
    val summary: String = "",
    val status: String = "",
    val attempts: Int = 0,
    val error: String? = null,
    val agent: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

/** Something shared into Simba from another app, awaiting triage. */
@Serializable
data class Capture(
    val id: String = "",
    val source: String = "",
    val content: String = "",
    val url: String? = null,
    val note: String? = null,
    val status: String = "",
    val kind: String? = null,
    val title: String? = null,
    val summary: String? = null,
    @SerialName("routed_to") val routedTo: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

/** reject, done, or requeue. The gateway refuses anything else. */
suspend fun SimbaApi.resolveCapture(id: String, action: String): String =
    call(req("/api/captures/$id/$action").post("{}".toRequestBody("application/json".toMediaType())).build())

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

suspend fun SimbaApi.turns(sessionId: String): List<Turn> =
    get("/api/sessions/$sessionId/turns")

suspend fun SimbaApi.checkpoints(sessionId: String): List<Checkpoint> =
    get("/api/sessions/$sessionId/checkpoints")

suspend fun SimbaApi.lineage(sessionId: String): List<LineageStep> =
    get("/api/sessions/$sessionId/lineage")

/** [hours] is capped at a week server-side; a phone chart cannot use more. */
suspend fun SimbaApi.memory(hours: Int = 24): List<MemorySample> =
    get("/api/system/memory?hours=$hours")

suspend fun SimbaApi.usageTimeline(): List<UsageDay> = get("/api/usage/timeline")

suspend fun SimbaApi.surfaces(): List<Surface> = get("/api/surfaces")

suspend fun SimbaApi.pendingActions(): List<PendingAction> = get("/api/actions/pending")

suspend fun SimbaApi.captures(): List<Capture> = get("/api/captures")

// ---------------------------------------------------------------------------
// Reels
// ---------------------------------------------------------------------------

/**
 * One item the reel pipeline has taken in.
 *
 * The intake is an Instagram DM: the operator shares a reel to the bot account, and a
 * headless Claude session downloads it, pulls keyframes, transcribes the audio,
 * works out what it actually is, and writes it up. This is the summary shape —
 * enough for a list — with the writeup itself fetched only when one is opened,
 * because notes can run to thousands of words.
 */
@Serializable
data class Reel(
    val id: String = "",
    val title: String = "",
    /** `YYYYMMDD-HHMMSS`, from the folder name. */
    val received: String = "",
    /** A writeup exists. False means still working, or died before finishing. */
    val done: Boolean = false,
    val summary: String? = null,
    @SerialName("has_notes") val hasNotes: Boolean = false,
    @SerialName("has_media") val hasMedia: Boolean = false,
    val frames: Int = 0,
    @SerialName("source_url") val sourceUrl: String? = null,
)

/** The pipeline's own view of itself: what it is holding and what it owes. */
@Serializable
data class ReelHealth(
    @SerialName("logged_in_as") val loggedInAs: String? = null,
    val agents: Int = 0,
    val working: Int = 0,
    /** Events seen but not finished — the backlog, including anything replayed. */
    val owed: Int = 0,
    val items: Int = 0,
)

@Serializable
data class ReelFeed(
    val items: List<Reel> = emptyList(),
    val health: ReelHealth? = null,
    /**
     * The pipeline runs as its own process on the PC. It being off is an
     * ordinary thing to display — and the thing most worth displaying, since
     * that is exactly the state in which reels pile up unanswered.
     */
    val reachable: Boolean = false,
)

/** The full writeup, fetched on open. */
@Serializable
data class ReelDetail(
    val id: String = "",
    @SerialName("source_url") val sourceUrl: String? = null,
    /** The short version, as DM'd back. */
    val status: String? = null,
    /** The long version. */
    val notes: String? = null,
    val caption: String? = null,
    val transcript: String? = null,
    val comments: String? = null,
)

// ---------------------------------------------------------------------------
// Find
// ---------------------------------------------------------------------------

/**
 * One result from the one box.
 *
 * Deliberately flat and untyped-by-kind: the whole value of a command palette is
 * that you do not have to know which of five things you are looking for before
 * you start typing. Modelling five result shapes would push that decision back
 * onto the caller and undo the point.
 */
@Serializable
data class Found(
    /** request | capture | project | session | mission */
    val kind: String = "",
    val id: String = "",
    val title: String = "",
    val subtitle: String? = null,
    val status: String? = null,
    @SerialName("when_at") val whenAt: String? = null,
    /**
     * Still outstanding — open, running, pending, or holding unpublished work.
     *
     * Sorts above a better textual match on purpose: the question behind a
     * search here is nearly always "what happened to X", and a finished thing
     * that matches the words more closely is rarely the answer.
     */
    val live: Boolean = false,
    val score: Double? = null,
)

suspend fun SimbaApi.find(q: String): List<Found> =
    get("/api/find?q=" + java.net.URLEncoder.encode(q, "UTF-8"))

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/**
 * A project, and whether the work in it exists anywhere but here.
 *
 * The two numbers are the entire point. Everything a project inventory might
 * record about what something *is* goes stale the week it is written; how much
 * of it is unpublished does not, and is the only thing here that can cost you
 * something. A repository with no remote at all is the sharpest case — its
 * whole history is on one disk — which is why [hasRemote] is surfaced rather
 * than left as a detail of the URL.
 */
@Serializable
data class Project(
    val id: String = "",
    val slug: String = "",
    /** The human name where one was given, not the directory name. */
    val name: String = "",
    val kind: String = "repo",
    @SerialName("root_path") val rootPath: String? = null,
    @SerialName("git_remote") val gitRemote: String? = null,
    val branch: String? = null,
    @SerialName("dirty_files") val dirtyFiles: Int = 0,
    val unpushed: Int = 0,
    @SerialName("last_commit_at") val lastCommitAt: String? = null,
    @SerialName("last_scanned_at") val lastScannedAt: String? = null,
    /**
     * Set when a scan could not read the repository at all.
     *
     * Carried separately from the counts so "nothing at risk" and "could not
     * tell" never render the same — the value of a zero is entirely in being
     * able to trust it.
     */
    @SerialName("scan_error") val scanError: String? = null,
    @SerialName("at_risk") val atRisk: Boolean = false,
    /** The agent that owns this scope, if one does. */
    val owner: String? = null,
) {
    val hasRemote: Boolean get() = !gitRemote.isNullOrBlank()

    /** How much is here and nowhere else. Orders the list. */
    val exposure: Int get() = dirtyFiles + unpushed
}

suspend fun SimbaApi.projects(): List<Project> = get("/api/projects")

/** Walks the disk and runs git in every repo it finds — asked for, never automatic. */
suspend fun SimbaApi.scanProjects(): String =
    call(req("/api/projects/scan").post("{}".toRequestBody("application/json".toMediaType())).build())

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * Something the operator asked for, kept until it is actually done.
 *
 * The distinction from a [Capture] is the one that went missing: a capture is
 * "this arrived" and is finished when it has been read; a request is "you said
 * you'd do this" and is finished when the thing exists. He attached "can you
 * download and setup the project that lets wifi thru walls work" to a reel, the
 * reel was processed and marked done, and the ask went with it — so when he
 * asked for progress days later he was told no such project was tracked.
 */
@Serializable
data class Request(
    val id: String = "",
    /** Verbatim, never a summary — he searches for it in his own words. */
    val ask: String = "",
    val source: String = "",
    /** open | done | dropped */
    val status: String = "open",
    val outcome: String? = null,
    @SerialName("capture_url") val captureUrl: String? = null,
    val agent: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("closed_at") val closedAt: String? = null,
)

suspend fun SimbaApi.requests(): List<Request> = get("/api/requests")

/** [action] is one of done, drop, reopen. */
suspend fun SimbaApi.decideRequest(id: String, action: String): String =
    call(req("/api/requests/$id/$action").post("{}".toRequestBody("application/json".toMediaType())).build())

suspend fun SimbaApi.reels(): ReelFeed = get("/api/reels")

suspend fun SimbaApi.reel(id: String): ReelDetail = get("/api/reels/$id")

/** Send a link into the pipeline from the phone, without going via Instagram. */
suspend fun SimbaApi.queueReel(url: String, note: String = ""): String = call(
    req("/api/reels").post(
        json.encodeToString(
            kotlinx.serialization.json.JsonObject.serializer(),
            kotlinx.serialization.json.buildJsonObject {
                put("url", kotlinx.serialization.json.JsonPrimitive(url))
                if (note.isNotBlank()) put("note", kotlinx.serialization.json.JsonPrimitive(note))
            },
        ).toRequestBody("application/json".toMediaType()),
    ).build(),
)

/**
 * Answer an approval request.
 *
 * Deliberately explicit rather than a boolean: `confirm(id, false)` at a call
 * site reads as "confirm, false" and is exactly the kind of thing that gets
 * inverted in a refactor.
 */
suspend fun SimbaApi.decideAction(id: String, approve: Boolean): String = call(
    req("/api/actions/$id/confirm").post(
        json.encodeToString(
            kotlinx.serialization.json.JsonObject.serializer(),
            kotlinx.serialization.json.buildJsonObject {
                put("approve", kotlinx.serialization.json.JsonPrimitive(approve))
            },
        ).toRequestBody("application/json".toMediaType()),
    ).build(),
)

/** Change which model tier an agent runs at. */
suspend fun SimbaApi.setAgentModel(slug: String, tier: String): String = call(
    req("/api/agents/$slug/model").post(
        json.encodeToString(
            kotlinx.serialization.json.JsonObject.serializer(),
            kotlinx.serialization.json.buildJsonObject {
                put("modelTier", kotlinx.serialization.json.JsonPrimitive(tier))
            },
        ).toRequestBody("application/json".toMediaType()),
    ).build(),
)
