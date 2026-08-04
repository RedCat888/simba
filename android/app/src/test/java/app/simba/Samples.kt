package com.operator.simba

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable

/**
 * Fixtures for the render test.
 *
 * Deliberately not fetched and not faked at the API layer: these exist to
 * exercise the *drawing*, and a screen that needs a gateway to be looked at is
 * a screen nobody looks at. The values are chosen to hit the cases that
 * actually break layouts — a title long enough to wrap, an empty subtitle, a
 * badge on a row that also has metadata, an expansion.
 */
@Composable
fun SampleRows() {
    Column(Modifier7, verticalArrangement = Arrangement.Top) {
        SectionHeading("Missions")
        ItemRow(
            title = "Port the Hermes self-improvement loop so agents write their own skills",
            subtitle = "Planning · deciding which of the fourteen behaviours are worth carrying over",
            meta = listOf(
                ItemMeta("3/9 steps"),
                ItemMeta("2 failed", Tone.Warn),
                ItemMeta("$0.00", Tone.Good),
            ),
            badge = ItemMeta("running", Tone.Good),
            onClick = {},
        )
        ItemRow(
            title = "Nightly Obsidian sync",
            meta = listOf(ItemMeta("exit 0", Tone.Good), ItemMeta("every day at 07:00")),
            badge = ItemMeta("script", Tone.Accented),
            onClick = {},
        )
        ItemRow(
            title = "raw-postgres-wire-protocol-in-node",
            subtitle = "How to speak the v3 protocol directly when no driver is installed.",
            meta = listOf(ItemMeta("never used", Tone.Warn), ItemMeta("1420 chars")),
            badge = ItemMeta("learned", Tone.Accented),
            expanded = { SectionHeading("Body") },
        )
    }
}

@Composable
fun SampleChat() {
    Column(Modifier7) {
        SectionHeading("Conversation")
        ItemRow(
            title = "Simba",
            subtitle = "The tunnel is up and three brains verified clean. One mission is blocked on budget.",
            meta = listOf(ItemMeta("claude"), ItemMeta("live", Tone.Good)),
        )
        EmptyState("Nothing else yet", "Send a message and it will appear here.")
    }
}

/** Named rather than inlined so both fixtures share one width contract. */
private val Modifier7 = androidx.compose.ui.Modifier.fillMaxWidth()

/**
 * A real session, with the numbers a real session produced.
 *
 * Taken from session 5b970b4d on this machine rather than invented: one turn of
 * 399 seconds against four short ones, 34 input tokens against 21,581 out, and
 * 681,418 read from cache. Invented data would have been evenly distributed and
 * would have hidden the exact thing this screen exists to reveal.
 */
@Composable
fun SessionFixture() {
    SessionDetail(
        title = "Confirm the Android new-mission dialog payload is accepted end to end",
        agent = "simba",
        status = "completed",
        brain = "claude-b",
        sessionError = null,
        turns = listOf(
            Turn(
                seq = 1, status = "completed", model = "claude-opus-5", modelTier = "high",
                costUsd = 1.033491, inputTokens = 34, outputTokens = 21581,
                cacheReadTokens = 681418, cacheCreationTokens = 12044,
                durationMs = 399482, stopReason = "end_turn", brain = "claude-b",
            ),
            Turn(
                seq = 2, status = "completed", model = "opencode/big-pickle", modelTier = "free",
                inputTokens = 12551, outputTokens = 312, cacheReadTokens = 16768,
                durationMs = 23513, stopReason = "end_turn", brain = "opencode",
            ),
            Turn(
                seq = 3, status = "completed", model = "opencode/big-pickle", modelTier = "free",
                durationMs = 13914, stopReason = "error",
                error = "provider returned no content", brain = "opencode",
            ),
            Turn(
                seq = 4, status = "running", model = "claude-opus-5", modelTier = "high",
                costUsd = 0.21, inputTokens = 90, outputTokens = 3100,
                cacheReadTokens = 120400, durationMs = 41000, brain = "claude-a",
            ),
        ),
        checkpoint = Checkpoint(
            reason = "periodic",
            taskStatement = "Write a step-by-step plan for a smoke test that confirms the Android " +
                "new-mission dialog payload is accepted end-to-end, resulting in a mission row " +
                "with a populated plan.",
            workDone = "Read the Android mission-creation code and the backend route. Confirmed " +
                "the payload shape matches, including the plain-English schedule field.",
            workRemaining = "Run the create against the live gateway and confirm a plan is " +
                "generated on the next supervisor tick.",
            openQuestions = "Should an unparseable schedule fail the create, or create the " +
                "mission unscheduled and say so?",
            failures = "First attempt posted to /action instead of the action path and got a 400.",
            keyDecisions = "Store the schedule phrase rather than re-deriving it from cron.",
            gitBranch = "master",
            gitHead = "f832e61c9a4b",
            gitDirty = true,
            gitDiffstat = " android/app/src/main/java/com/operator/simba/Session.kt | 412 ++++++++++\n" +
                " android/app/src/main/java/com/operator/simba/Charts.kt  | 298 +++++",
            recentFiles = listOf(
                "android/app/src/main/java/com/operator/simba/Session.kt",
                "android/app/src/main/java/com/operator/simba/Charts.kt",
                "android/app/src/main/java/com/operator/simba/Insights.kt",
                "src/gateway/server.ts",
                "migrations/040_schedule_note.sql",
            ),
            tokenEstimate = 48200,
        ),
        lineage = listOf(
            LineageStep(id = "5b970b4d", depth = 0, status = "completed"),
            LineageStep(
                id = "19ca077f", depth = 1, title = "Android new-mission dialog",
                status = "failed", swapCount = 2, cost = 0.42,
                error = "usage limit reached on claude-a",
            ),
        ),
    )
}
