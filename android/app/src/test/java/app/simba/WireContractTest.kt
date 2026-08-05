package com.operator.simba

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Every model, against what the gateway actually sends.
 *
 * The fixtures in `resources/wire` are real responses captured from the running
 * gateway, not hand-written examples — which matters, because the failures worth
 * catching are the ones nobody would think to write down: a column that is null
 * on one row out of eighty, a numeric id where a string was assumed, a field
 * added server-side that the app has never seen.
 *
 * The app and the gateway ship independently. The gateway is redeployed by
 * editing a file; the app requires building an APK, uploading it and installing
 * it. So the app is routinely older than the server it is talking to, and the
 * contract these tests pin is not "the shapes match" — it is "the app survives
 * the shapes not matching", which is what `ignoreUnknownKeys` and defaulted
 * fields are for.
 */
class WireContractTest {

    /** The exact configuration SimbaApi uses. A different one proves nothing. */
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        coerceInputValues = true
    }

    private fun load(name: String): String =
        checkNotNull(javaClass.classLoader?.getResourceAsStream("wire/$name.json")) {
            "missing fixture: wire/$name.json"
        }.bufferedReader().readText()

    private inline fun <reified T> decodes(name: String): T =
        json.decodeFromString<T>(load(name))

    @Test
    fun `every captured response decodes into its model`() {
        // Listing them one per line rather than in a loop so a failure names the
        // endpoint that broke instead of "something in the list".
        decodes<Stats>("stats")
        decodes<List<Mission>>("missions")
        decodes<List<Agent>>("agents")
        decodes<List<Brain>>("brains")
        decodes<List<SessionRow>>("sessions")
        decodes<List<Brief>>("briefs")
        decodes<List<SystemEvent>>("events")
        decodes<List<Skill>>("skills")
        decodes<List<Decision>>("decisions")
        decodes<MemoryView>("memory")
        decodes<StorePressure>("curation")
        decodes<List<HeldWorktree>>("worktrees")
        decodes<List<Surface>>("surfaces")
        decodes<List<UsageDay>>("usage_timeline")
        decodes<List<MemorySample>>("system_memory")
        decodes<List<PendingAction>>("actions_pending")
        decodes<List<Capture>>("captures")
        decodes<ContextBudget>("context")
    }

    @Test
    fun `nulls in the real data do not become the word null`() {
        // The websocket parser had exactly this defect: JsonNull read as the
        // string "null" and rendered as a message body. The REST path uses
        // kotlinx directly, so it should be immune — but the fixtures contain
        // real nulls, so it is worth proving rather than assuming.
        val sessions = decodes<List<SessionRow>>("sessions")
        val offenders = sessions.filter { s ->
            s.title == "null" || s.brain == "null" || s.error == "null" || s.agent == "null"
        }
        assertTrue("a null decoded as the literal string: $offenders", offenders.isEmpty())

        val missions = decodes<List<Mission>>("missions")
        assertTrue(
            "a null decoded as the literal string",
            missions.none { it.currentStep == "null" || it.blockedReason == "null" || it.agent == "null" },
        )
    }

    @Test
    fun `the fixtures actually contain nulls, so the check above means something`() {
        // A test that would pass against data with no nulls in it is a test that
        // proves nothing. This asserts the corpus is adversarial enough to be
        // worth running against.
        val withNulls = listOf("sessions", "missions", "brains", "events").count { name ->
            json.parseToJsonElement(load(name)).let { root ->
                (root as? JsonArray).orEmpty().any { row ->
                    (row as? JsonObject)?.values?.any { it is JsonNull } == true
                }
            }
        }
        assertTrue("no fixture contained a null; the null checks are vacuous", withNulls > 0)
    }

    @Test
    fun `a field the app has never seen is ignored rather than fatal`() {
        // The gateway ships ahead of the app as a matter of routine — it is
        // redeployed by editing a file, the app needs an APK built and
        // installed. An added column must not blank a screen.
        val future = """
            [{"id":"m1","title":"Ahead of the app","status":"running",
              "quantum_readiness":0.94,"nested":{"whatever":[1,2,3]}}]
        """.trimIndent()
        val decoded = json.decodeFromString<List<Mission>>(future)
        assertTrue(decoded.single().title == "Ahead of the app")
    }

    @Test
    fun `a field the app expects and the gateway drops falls back to a default`() {
        // The other direction: a rollback, or a column removed. Every field in
        // every model is defaulted for this reason.
        val sparse = """[{"id":"m1"}]"""
        val m = json.decodeFromString<List<Mission>>(sparse).single()
        assertTrue(m.title.isEmpty() && m.totalSteps == 0 && m.status.isEmpty())
    }
}

private fun JsonArray?.orEmpty(): List<kotlinx.serialization.json.JsonElement> = this ?: emptyList()
