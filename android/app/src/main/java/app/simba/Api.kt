package com.operator.simba

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

// ---------------------------------------------------------------------------
// Wire models.
//
// Every field is optional or defaulted. The gateway evolves faster than the
// app can be reinstalled, and a strict parser turns an added column into a
// blank screen with no explanation.
// ---------------------------------------------------------------------------

@Serializable
data class Stats(
    val agents: Int = 0,
    @SerialName("active_sessions") val activeSessions: Int = 0,
    @SerialName("total_sessions") val totalSessions: Int = 0,
    val messages: Int = 0,
    val embeddings: Int = 0,
    @SerialName("total_cost") val totalCost: Double = 0.0,
    @SerialName("brains_available") val brainsAvailable: Int = 0,
    @SerialName("brains_limited") val brainsLimited: Int = 0,
)

@Serializable
data class Mission(
    val id: String = "",
    val title: String = "",
    val status: String = "",
    val agent: String? = null,
    @SerialName("current_step") val currentStep: String? = null,
    @SerialName("blocked_reason") val blockedReason: String? = null,
    @SerialName("done_steps") val doneSteps: Int = 0,
    @SerialName("total_steps") val totalSteps: Int = 0,
    @SerialName("failed_steps") val failedSteps: Int = 0,
    @SerialName("sessions_used") val sessionsUsed: Int = 0,
    @SerialName("max_sessions") val maxSessions: Int = 0,
    @SerialName("cost_used") val costUsed: Double = 0.0,
    @SerialName("max_cost_usd") val maxCost: Double = 0.0,
    /** A script mission runs a command directly: no model, no session, no steps. */
    @SerialName("is_script") val isScript: Boolean = false,
    val cron: String? = null,
    /**
     * The schedule as a person would say it — "every day at 07:00".
     *
     * Stored rather than derived: the cron is what the phrase compiled to, and
     * a round-trip back from `0 7 * * *` cannot recover "every morning". Null on
     * missions created before the column existed, which is why the row falls
     * back to the cron rather than showing nothing.
     */
    @SerialName("schedule_note") val scheduleNote: String? = null,
    @SerialName("last_exit_code") val lastExitCode: Int? = null,
    @SerialName("last_output") val lastOutput: String? = null,
    @SerialName("last_run_at") val lastRunAt: String? = null,
)

@Serializable
data class MissionStep(
    val seq: Int = 0,
    val title: String = "",
    val instruction: String = "",
    val kind: String = "work",
    val status: String = "pending",
    val attempts: Int = 0,
    val result: String? = null,
    val failures: String? = null,
)

@Serializable
data class MissionDetail(
    val mission: MissionFull = MissionFull(),
    val steps: List<MissionStep> = emptyList(),
    /**
     * The mission's own history.
     *
     * Returned by the gateway since this route was written and never modelled,
     * so a mission's detail screen could say what state it was in but nothing
     * about how it got there — which is the question anyone opening a blocked
     * mission at 3am is actually asking.
     */
    val log: List<MissionLogEntry> = emptyList(),
)

@Serializable
data class MissionLogEntry(
    val ts: String = "",
    val level: String = "info",
    val message: String = "",
)

@Serializable
data class MissionFull(
    val id: String = "",
    val title: String = "",
    val objective: String = "",
    val status: String = "",
    @SerialName("acceptance_criteria") val acceptanceCriteria: String? = null,
    @SerialName("blocked_reason") val blockedReason: String? = null,
    @SerialName("sessions_used") val sessionsUsed: Int = 0,
    @SerialName("max_sessions") val maxSessions: Int = 0,
    /** Needed to offer a sensible raised ceiling when a budget block happens. */
    @SerialName("max_cost_usd") val maxCost: Double = 0.0,

    /**
     * What it produced, and the evidence that it worked.
     *
     * The two most valuable fields on a finished mission and neither reached the
     * phone, so "completed" was a word with nothing behind it. A mission that
     * claims success without stating what it verified is exactly the thing
     * unattended work has to be able to answer for.
     */
    val result: String? = null,
    val verification: String? = null,

    @SerialName("cost_used_usd") val costUsed: Double = 0.0,
    @SerialName("consecutive_failures") val consecutiveFailures: Int = 0,
    @SerialName("max_consecutive_failures") val maxConsecutiveFailures: Int = 0,
    @SerialName("working_dir") val workingDir: String? = null,
    @SerialName("started_at") val startedAt: String? = null,
    @SerialName("completed_at") val completedAt: String? = null,
    @SerialName("next_run_at") val nextRunAt: String? = null,
    @SerialName("schedule_note") val scheduleNote: String? = null,
    val cadence: String? = null,
    val script: String? = null,
    @SerialName("last_output") val lastOutput: String? = null,
    @SerialName("last_exit_code") val lastExitCode: Int? = null,
    val agent: String? = null,
)

@Serializable
data class Agent(
    val id: String = "",
    val slug: String = "",
    val name: String = "",
    val tier: Int = 1,
    val domain: String? = null,
    val description: String? = null,
    val status: String = "idle",
    @SerialName("model_tier") val modelTier: String = "mid",
    @SerialName("active_sessions") val activeSessions: Int = 0,
    @SerialName("total_cost") val totalCost: Double = 0.0,
)

@Serializable
data class Brain(
    val slug: String = "",
    val label: String = "",
    val provider: String = "",
    val status: String = "",
    @SerialName("limit_resets_at") val limitResetsAt: String? = null,
    @SerialName("cost_7d") val cost7d: Double? = 0.0,
    /** Why a brain is unusable. Without it the UI shows a bare status and looks broken. */
    @SerialName("last_error") val lastError: String? = null,
    /** Position in the failover ladder — the phone should show the order, not just the set. */
    val priority: Int = 0,
    val enabled: Boolean = true,
    val cli: String = "",
    /**
     * Rolling usage. Headroom is the scarce resource on a subscription-only
     * setup, so the 5-hour window is the number that actually predicts whether
     * a brain is about to become unavailable.
     */
    @SerialName("input_5h") val input5h: Long = 0,
    @SerialName("output_5h") val output5h: Long = 0,
    @SerialName("cost_5h") val cost5h: Double? = 0.0,
    @SerialName("input_7d") val input7d: Long = 0,
    @SerialName("output_7d") val output7d: Long = 0,
)

/** Result of asking a brain, live, whether it actually works. */
@Serializable
data class VerifyResult(
    val slug: String = "",
    val ok: Boolean = false,
    val detail: String = "",
    val ms: Long = 0,
    val model: String? = null,
)

@Serializable
data class Skill(
    val name: String = "",
    val description: String = "",
    val tags: List<String> = emptyList(),
    val source: String = "",
    val version: Int = 1,
    @SerialName("use_count") val useCount: Int = 0,
    @SerialName("last_used_at") val lastUsedAt: String? = null,
    /** Size of the body, so the list can show weight without carrying it. */
    @SerialName("body_chars") val bodyChars: Int = 0,
)

@Serializable
data class SkillRevision(
    val version: Int = 0,
    val note: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class SkillDetail(
    val name: String = "",
    val description: String = "",
    val body: String = "",
    val tags: List<String> = emptyList(),
    val related: List<String> = emptyList(),
    val source: String = "",
    val version: Int = 1,
    @SerialName("use_count") val useCount: Int = 0,
    val history: List<SkillRevision> = emptyList(),
)

@Serializable
data class FileDiff(
    val path: String = "",
    val status: String = "",
    val additions: Int = 0,
    val deletions: Int = 0,
    val patch: String? = null,
    /** The server withheld the patch because it is too large to send. */
    val truncated: Boolean = false,
)

@Serializable
data class DiffCommit(
    val sha: String = "",
    val subject: String = "",
    val at: String = "",
)

@Serializable
data class SessionDiff(
    val branch: String? = null,
    val head: String? = null,
    val files: List<FileDiff> = emptyList(),
    val commits: List<DiffCommit> = emptyList(),
    @SerialName("totalAdditions") val totalAdditions: Int = 0,
    @SerialName("totalDeletions") val totalDeletions: Int = 0,
)

@Serializable
data class WorktreeState(
    val path: String = "",
    val branch: String? = null,
    val dirty: Boolean = false,
    val ahead: Int = 0,
    /** Its repository is gone, so the changes cannot be recovered or merged. */
    val originMissing: Boolean = false,
)

@Serializable
data class HeldWorktree(
    val sessionId: String = "",
    val agent: String = "",
    val state: WorktreeState = WorktreeState(),
)

@Serializable
data class SendResult(
    val ok: Boolean = false,
    val sessionId: String = "",
    /** Set when the work moved to a new session - a revival or a brain swap. */
    val movedTo: String? = null,
)

@Serializable
data class MemoryEntry(
    val id: String = "",
    val kind: String = "",
    val content: String = "",
    val source: String? = null,
    val confirmations: Int = 0,
)

@Serializable
data class MemoryScope(val used: Int = 0, val cap: Int = 0)

@Serializable
data class MemoryPressure(
    val global: MemoryScope = MemoryScope(),
    val own: MemoryScope = MemoryScope(),
)

@Serializable
data class MemoryView(
    val entries: List<MemoryEntry> = emptyList(),
    val pressure: MemoryPressure = MemoryPressure(),
)

@Serializable
data class BudgetSlice(
    val category: String = "",
    val chars: Int = 0,
    val estTokens: Int = 0,
    val pct: Int = 0,
    val note: String? = null,
)

@Serializable
data class ContextBudget(
    val agent: String = "",
    val totalChars: Int = 0,
    val estTokens: Int = 0,
    val slices: List<BudgetSlice> = emptyList(),
)

@Serializable
data class SkillPressure(
    val enabled: Int = 0,
    val archived: Int = 0,
    val unused: Int = 0,
)

@Serializable
data class StorePressure(
    val memory: MemoryScopePct = MemoryScopePct(),
    val skills: SkillPressure = SkillPressure(),
)

@Serializable
data class MemoryScopePct(val used: Int = 0, val cap: Int = 0, val pct: Int = 0)

@Serializable
data class Decision(
    val id: String = "",
    val statement: String = "",
    val rationale: String? = null,
    val topic: String? = null,
    val confidence: String = "",
    val status: String = "",
    @SerialName("decided_at") val decidedAt: String? = null,
)

/**
 * One thing that happened.
 *
 * The gateway has recorded these from the start — brains swapping, skills being
 * written, missions blocking, worktrees kept — and nothing on the phone read
 * them, so the only visible history was whatever a brief happened to summarise.
 */
@Serializable
data class SystemEvent(
    /** A bigserial, not a uuid — the feed relies on it being monotonic. */
    val id: Long = 0,
    val ts: String = "",
    val type: String = "",
    val severity: String = "info",
    val message: String = "",
    val agent: String? = null,
    val brain: String? = null,
) {
    /**
     * Worth telling someone about.
     *
     * The feed is everything; a notification is an interruption. Only the events
     * that change what a person would do — work finished, work stuck, something
     * learned, nothing left to think with — earn one.
     */
    val notable: Boolean
        get() = type in NOTABLE

    /** A human-facing title. Event types are dotted machine names. */
    val label: String
        get() = type.substringAfterLast('.').replace('_', ' ')
            .replaceFirstChar { it.uppercase() }

    companion object {
        val NOTABLE = setOf(
            "mission.completed",
            "mission.blocked",
            "mission.stopped",
            "skill.learned",
            "skill.created",
            "agent.no_brain_available",
            "brain.limit_reached",
            "brain.logged_out",
            "system.panic",
            "system.leak_suspected",
        )
        // Deliberately absent: worktree.kept. It fires every time an agent
        // finishes holding changes, which during a night of autonomous work is
        // constantly, and System already lists held worktrees as their own
        // section — a notification per kept tree would train you to swipe the
        // whole channel away.
    }
}

@Serializable
data class Brief(
    val id: String = "",
    val headline: String = "",
    val body: String = "",
    @SerialName("needs_decision") val needsDecision: String? = null,
    val stuck: String? = null,
    @SerialName("created_at") val createdAt: String = "",
)

@Serializable
data class SessionRow(
    val id: String = "",
    val agent: String = "",
    val status: String = "",
    val title: String? = null,
    val brain: String? = null,
    @SerialName("total_cost_usd") val cost: Double = 0.0,
    @SerialName("swap_count") val swapCount: Int = 0,
    /** Why it failed. A bare "failed" with no reason looks like a Simba bug. */
    val error: String? = null,
    /**
     * When this session last did anything.
     *
     * The gateway has always returned it and the app never modelled it, so
     * "running" was indistinguishable from "running, but silent for forty
     * minutes" — which is usually the more urgent of the two. Freshness is the
     * signal that separates working from stuck, and no status string carries it.
     */
    @SerialName("last_activity_at") val lastActivityAt: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("total_input_tokens") val inputTokens: Long = 0,
    @SerialName("total_output_tokens") val outputTokens: Long = 0,
    val cli: String? = null,
    val tier: Int? = null,
)

@Serializable
data class Message(
    val seq: Long = 0,
    val role: String = "",
    val content: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
) {
    /** Epoch millis, so messages and tool calls can be merged into one ordered thread. */
    val at: Long get() = parseTs(createdAt) ?: seq
}

@Serializable
data class ToolCallRow(
    val name: String = "",
    @SerialName("result_text") val resultText: String? = null,
    @SerialName("is_error") val isError: Boolean = false,
    @SerialName("created_at") val createdAt: String? = null,
) {
    val seqHint: Long get() = parseTs(createdAt) ?: 0L
}

/**
 * Postgres timestamps arrive as ISO strings. Parsed leniently: a thread that
 * renders slightly out of order is far better than one that fails to render.
 */
private fun parseTs(s: String?): Long? {
    if (s.isNullOrBlank()) return null
    return runCatching { java.time.Instant.parse(s).toEpochMilli() }
        .recoverCatching {
            java.time.OffsetDateTime.parse(s).toInstant().toEpochMilli()
        }
        .recoverCatching {
            java.time.LocalDateTime.parse(s.replace(' ', 'T').substringBefore('+'))
                .toInstant(java.time.ZoneOffset.UTC).toEpochMilli()
        }
        .getOrNull()
}

@Serializable
data class MemoryHit(
    val source: String? = null,
    val title: String? = null,
    val relevance: Double = 0.0,
    val content: String = "",
)

@Serializable
data class StartResult(
    val sessionId: String? = null,
    val error: String? = null,
    val note: String? = null,
)

@Serializable
data class SimbaHome(
    val sessionId: String? = null,
)

@Serializable
data class SimbaSayResult(
    val sessionId: String? = null,
    val started: Boolean = false,
    val error: String? = null,
)

@Serializable
data class TodayItem(
    val kind: String = "",
    val id: String = "",
    val title: String = "",
    val detail: String? = null,
    val status: String? = null,
    val at: String? = null,
)

@Serializable
data class Today(
    val needsMe: List<TodayItem> = emptyList(),
    val running: List<TodayItem> = emptyList(),
    val overnight: List<TodayItem> = emptyList(),
    val simba: SimbaHome = SimbaHome(),
)

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

class SimbaApi(
    @Volatile var baseUrl: String,
    @Volatile var token: String = "",
    /**
     * Cloudflare Access service-token pair.
     *
     * A native client cannot complete Access's interactive login: Google
     * refuses OAuth inside embedded WebViews, and a Custom Tab's cookies live
     * in the browser's jar where OkHttp cannot reach them. A service token is
     * the supported non-interactive path, and it is also the only thing that
     * works for the headless brief poller, which runs with no UI attached.
     *
     * Treat it as an SSH key: it authenticates to a gateway that can start
     * agents holding a full shell. Stored encrypted, revocable from the
     * Cloudflare dashboard.
     */
    @Volatile var accessClientId: String = "",
    @Volatile var accessClientSecret: String = "",
) {
    internal val json = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true }

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        // Long: a request can be waiting on an agent turn, which legitimately
        // takes minutes. A short read timeout here shows as a spurious failure.
        .readTimeout(180, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /** `status` is carried so callers can tell "not authorised" from "unreachable". */
    class ApiException(message: String, val status: Int = 0) : Exception(message) {
        val isAuthFailure: Boolean get() = status == 401 || status == 403
    }

    internal fun req(path: String): Request.Builder {
        val b = Request.Builder().url(baseUrl.trimEnd('/') + path)
        if (token.isNotBlank()) b.header("Authorization", "Bearer $token")

        // Cloudflare validates these at the edge and, on success, injects a
        // signed assertion the gateway verifies. Requests without them never
        // reach the origin at all.
        if (accessClientId.isNotBlank() && accessClientSecret.isNotBlank()) {
            b.header("CF-Access-Client-Id", accessClientId)
            b.header("CF-Access-Client-Secret", accessClientSecret)
        }

        // X-Simba-Surface is deliberately no longer sent. The gateway derives
        // the surface from the verified Access identity; a client-asserted
        // surface was never a real constraint.
        return b
    }

    internal suspend fun call(request: Request): String = withContext(Dispatchers.IO) {
        client.newCall(request).execute().use { res ->
            val body = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                throw ApiException(
                    if (body.isNotBlank()) body.take(300) else "HTTP ${res.code}",
                    res.code,
                )
            }
            body
        }
    }

    /**
     * Internal rather than public: it is inline, and an inline function visible
     * outside the module may not touch module-internal members — which [json],
     * [call] and [req] all are. Nothing outside this app has any business
     * calling it anyway; the typed methods are the surface.
     */
    internal suspend inline fun <reified T> get(path: String): T =
        json.decodeFromString(call(req(path).get().build()))

    private suspend inline fun <reified T> post(path: String, bodyJson: String = "{}"): T =
        json.decodeFromString(
            call(req(path).post(bodyJson.toRequestBody("application/json".toMediaType())).build()),
        )

    suspend fun stats(): Stats = get("/api/stats")
    suspend fun missions(): List<Mission> = get("/api/missions")
    suspend fun mission(id: String): MissionDetail = get("/api/missions/$id")
    suspend fun agents(): List<Agent> = get("/api/agents")
    suspend fun brains(): List<Brain> = get("/api/brains")
    suspend fun briefs(): List<Brief> = get("/api/briefs")
    suspend fun events(): List<SystemEvent> = get("/api/events")
    suspend fun sessions(): List<SessionRow> = get("/api/sessions")
    suspend fun messages(id: String): List<Message> = get("/api/sessions/$id/messages")
    suspend fun tools(id: String): List<ToolCallRow> = get("/api/sessions/$id/tools")

    suspend fun search(q: String): List<MemoryHit> =
        get("/api/knowledge/search?q=" + java.net.URLEncoder.encode(q, "UTF-8"))

    suspend fun sessionDiff(id: String): SessionDiff = get("/api/sessions/$id/diff")
    suspend fun worktrees(): List<HeldWorktree> = get("/api/worktrees")
    suspend fun memory(): MemoryView = get("/api/memory")

    suspend fun addMemory(kind: String, content: String): String = call(
        req("/api/memory").post(
            json.encodeToString(
                kotlinx.serialization.json.JsonObject.serializer(),
                kotlinx.serialization.json.buildJsonObject {
                    put("kind", kotlinx.serialization.json.JsonPrimitive(kind))
                    put("content", kotlinx.serialization.json.JsonPrimitive(content))
                },
            ).toRequestBody("application/json".toMediaType()),
        ).build(),
    )

    suspend fun removeMemory(match: String): String = call(
        req("/api/memory?match=" + java.net.URLEncoder.encode(match, "UTF-8")).delete().build(),
    )

    suspend fun contextBudget(agent: String): ContextBudget = get("/api/agents/$agent/context")
    suspend fun storePressure(): StorePressure = get("/api/curation")
    suspend fun runCuration(): String = call(
        req("/api/curation").post("{}".toRequestBody("application/json".toMediaType())).build(),
    )

    suspend fun skills(): List<Skill> = get("/api/skills")
    suspend fun skill(name: String): SkillDetail = get("/api/skills/$name")
    suspend fun decisions(): List<Decision> = get("/api/decisions?limit=60")

    /**
     * Ask a brain, live, whether it works. Slow on purpose — it runs a real turn
     * rather than reading the stored status, which is the entire point: a status
     * is a claim about whenever something last changed it, and a stale one kept
     * two working subscriptions benched.
     */
    suspend fun verifyBrain(slug: String): VerifyResult = post("/api/brains/$slug/verify")

    suspend fun toggleBrain(slug: String): String = call(
        req("/api/brains/$slug/toggle").post("{}".toRequestBody("application/json".toMediaType())).build(),
    )

    /**
     * Sends a message and reports which session it reached.
     *
     * Reviving or failing over creates a new session id server-side. The reply
     * used to be a bare {ok:true}, so the app kept filtering the event stream
     * for a session that would never speak again - the continuation's output was
     * invisible, and a second message forked another child off the same parent.
     */
    suspend fun send(sessionId: String, text: String): SendResult =
        json.decodeFromString(
            call(
                req("/api/sessions/$sessionId/send")
                    .post(
                        json.encodeToString(
                            kotlinx.serialization.json.JsonObject.serializer(),
                            kotlinx.serialization.json.buildJsonObject {
                                put("text", kotlinx.serialization.json.JsonPrimitive(text))
                            },
                        ).toRequestBody("application/json".toMediaType()),
                    ).build(),
            ),
        )

    /** Stop a live session. The work stops; the transcript stays. */
    suspend fun killSession(sessionId: String): String =
        call(req("/api/sessions/$sessionId/kill").post("{}".toRequestBody("application/json".toMediaType())).build())

    /**
     * Move this conversation to the next brain in the ladder, now.
     *
     * The closest thing this architecture has to a model picker: you do not
     * choose a model, you choose to stop using the one that is stuck. Failover
     * already happens automatically on a limit or a crash — this is for the case
     * where a brain is technically alive and giving you nothing useful.
     */
    suspend fun failoverSession(sessionId: String): String =
        call(req("/api/sessions/$sessionId/failover").post("{}".toRequestBody("application/json".toMediaType())).build())

    suspend fun today(): Today = get("/api/today")

    suspend fun simba(): SimbaHome = get("/api/simba")

    suspend fun saySimba(text: String): SimbaSayResult =
        post(
            "/api/simba/say",
            json.encodeToString(
                kotlinx.serialization.json.JsonObject.serializer(),
                kotlinx.serialization.json.buildJsonObject {
                    put("text", kotlinx.serialization.json.JsonPrimitive(text))
                },
            ),
        )

    suspend fun startAgent(slug: String, prompt: String): StartResult =
        post(
            "/api/agents/$slug/start",
            json.encodeToString(
                kotlinx.serialization.json.JsonObject.serializer(),
                kotlinx.serialization.json.buildJsonObject {
                    put("prompt", kotlinx.serialization.json.JsonPrimitive(prompt))
                },
            ),
        )

    suspend fun missionAction(id: String, action: String): String =
        call(req("/api/missions/$id/$action").post("{}".toRequestBody("application/json".toMediaType())).build())

    /**
     * Raise a blocked mission's ceilings and let it continue.
     *
     * A mission that exhausts its session or cost budget stops with the reason
     * recorded, which is right — that limit is what keeps an unattended
     * objective bounded. Without this the only way to lift it was editing the
     * database, so from the phone a blocked mission was dead.
     */
    suspend fun missionBudget(id: String, maxSessions: Int, maxCostUsd: Double): String =
        call(
            req("/api/missions/$id/budget").post(
                json.encodeToString(
                    kotlinx.serialization.json.JsonObject.serializer(),
                    kotlinx.serialization.json.buildJsonObject {
                        put("maxSessions", kotlinx.serialization.json.JsonPrimitive(maxSessions))
                        put("maxCostUsd", kotlinx.serialization.json.JsonPrimitive(maxCostUsd))
                    },
                ).toRequestBody("application/json".toMediaType()),
            ).build(),
        )

    /**
     * [schedule] is plain English — "every morning", "weekdays at 9". The
     * gateway parses it and refuses what it cannot understand rather than
     * defaulting, so a mission never quietly runs at an hour nobody chose.
     */
    suspend fun createMission(
        title: String,
        objective: String,
        criteria: String?,
        schedule: String? = null,
    ): String =
        call(
            req("/api/missions").post(
                json.encodeToString(
                    kotlinx.serialization.json.JsonObject.serializer(),
                    kotlinx.serialization.json.buildJsonObject {
                        put("title", kotlinx.serialization.json.JsonPrimitive(title))
                        put("objective", kotlinx.serialization.json.JsonPrimitive(objective))
                        if (!criteria.isNullOrBlank()) {
                            put("acceptanceCriteria", kotlinx.serialization.json.JsonPrimitive(criteria))
                        }
                        if (!schedule.isNullOrBlank()) {
                            put("schedule", kotlinx.serialization.json.JsonPrimitive(schedule))
                        }
                    },
                ).toRequestBody("application/json".toMediaType()),
            ).build(),
        )

    /** The share-sheet path: capture something from another app into intake. */
    suspend fun capture(text: String, source: String): String =
        call(
            req("/api/capture").post(
                json.encodeToString(
                    kotlinx.serialization.json.JsonObject.serializer(),
                    kotlinx.serialization.json.buildJsonObject {
                        put("content", kotlinx.serialization.json.JsonPrimitive(text))
                        put("source", kotlinx.serialization.json.JsonPrimitive(source))
                    },
                ).toRequestBody("application/json".toMediaType()),
            ).build(),
        )

    suspend fun panic(): String =
        call(req("/api/panic").post("{}".toRequestBody("application/json".toMediaType())).build())
}
