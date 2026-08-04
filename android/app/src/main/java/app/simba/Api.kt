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
data class Decision(
    val id: String = "",
    val statement: String = "",
    val rationale: String? = null,
    val topic: String? = null,
    val confidence: String = "",
    val status: String = "",
    @SerialName("decided_at") val decidedAt: String? = null,
)

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
    private val json = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true }

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

    private fun req(path: String): Request.Builder {
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

    private suspend fun call(request: Request): String = withContext(Dispatchers.IO) {
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

    private suspend inline fun <reified T> get(path: String): T =
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
    suspend fun sessions(): List<SessionRow> = get("/api/sessions")
    suspend fun messages(id: String): List<Message> = get("/api/sessions/$id/messages")
    suspend fun tools(id: String): List<ToolCallRow> = get("/api/sessions/$id/tools")

    suspend fun search(q: String): List<MemoryHit> =
        get("/api/knowledge/search?q=" + java.net.URLEncoder.encode(q, "UTF-8"))

    suspend fun sessionDiff(id: String): SessionDiff = get("/api/sessions/$id/diff")
    suspend fun worktrees(): List<HeldWorktree> = get("/api/worktrees")
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

    suspend fun send(sessionId: String, text: String): String =
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

    suspend fun createMission(title: String, objective: String, criteria: String?): String =
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
