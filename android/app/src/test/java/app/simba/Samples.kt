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

/**
 * The Now screen's two states that matter: something needs you, and nothing does.
 *
 * Both have to be checked. A landing screen is judged on the quiet case as much
 * as the busy one — an ops surface that looks empty and broken when everything
 * is fine is worse than no landing screen, and it is the state it will be in
 * most of the time.
 */
@Composable
fun NowBusyFixture() {
    NowBody(
        needsYou = 3,
        runningMissions = 2,
        liveSessions = 1,
        connected = true,
        pending = listOf(
            PendingAction(
                id = "a1", actionClass = "write_outside_worktree",
                target = "C:/workspace/OneDrive/Documents/Obsidian Vault/Daily/2026-08-05.md",
                summary = "Append today's brief to the vault daily note",
                status = "pending", agent = "simba",
            ),
            PendingAction(
                id = "a2", actionClass = "network_egress",
                target = "api.github.com",
                summary = "Create a release and upload the built APK",
                status = "pending", attempts = 2, agent = "mobile-app",
                error = "previous attempt refused: token lacked repo scope",
            ),
        ),
        blocked = listOf(
            Mission(
                id = "m1", title = "Port the Hermes self-improvement loop",
                status = "blocked", doneSteps = 3, totalSteps = 9,
                blockedReason = "session budget exhausted after 40 sessions",
            ),
        ),
        running = listOf(
            Mission(
                id = "m2", title = "Nightly repo snapshot and vault sync",
                status = "running", currentStep = "Writing the digest", doneSteps = 4,
                totalSteps = 6, costUsed = 0.0,
            ),
            Mission(
                id = "m3", title = "Rebuild the Android app to product quality",
                status = "running", currentStep = "Rendering screens for review",
                doneSteps = 11, totalSteps = 18, costUsed = 4.82,
            ),
        ),
        live = listOf(
            SessionRow(
                id = "s1", agent = "mobile-app", status = "running",
                title = "Now screen and four-tab navigation", brain = "claude-b",
                cost = 1.24, lastActivityAt = "2026-08-05T00:04:00Z",
            ),
        ),
        memory = (0..71).map { i ->
            // A slow decline overnight, which is exactly the shape worth seeing.
            MemorySample(
                at = "08-04 %02d:00".format(i / 3), freeMb = 16800 - i * 120 + (i % 7) * 260,
                totalMb = 32768, processCount = 412 + i,
            )
        },
        brains = listOf(
            Brain(slug = "claude-a", status = "limited", enabled = true),
            Brain(slug = "claude-b", status = "available", enabled = true),
            Brain(slug = "codex", status = "available", enabled = true),
            Brain(slug = "opencode", status = "available", enabled = true),
        ),
        // Shared in from other apps and not yet triaged. The share sheet has
        // worked since the beginning and what it produced had no surface.
        captures = listOf(
            Capture(
                id = "c1", source = "android-share", status = "pending",
                title = "Compose: SharedTransitionLayout is stable in 1.7",
                content = "SharedTransitionLayout graduated in Compose 1.7.0. sharedBounds and " +
                    "sharedElement are usable without an opt-in now.",
                url = "https://developer.android.com/develop/ui/compose/animation/shared-elements",
                kind = "link", routedTo = "mobile-app",
                createdAt = "2026-08-04T23:12:00Z",
            ),
            Capture(
                id = "c2", source = "process-text", status = "pending",
                content = "remember: the emulator on this box crashes at startup, WHPX is fine, " +
                    "it is the 2024 build on a 2026 Windows",
                kind = "note", createdAt = "2026-08-05T00:31:00Z",
            ),
        ),
        events = listOf(
            SystemEvent(id = 2841, ts = "2026-08-05T00:02:00Z", type = "skill.learned",
                message = "wrote raw-postgres-wire-protocol-in-node after solving it twice"),
            SystemEvent(id = 2839, ts = "2026-08-04T23:31:00Z", type = "mission.blocked",
                severity = "warn", message = "Port the Hermes loop: session budget exhausted"),
            SystemEvent(id = 2833, ts = "2026-08-04T22:58:00Z", type = "brain.limit_reached",
                severity = "warn", message = "claude-a hit its 5-hour ceiling; failed over to claude-b"),
        ),
    )
}

@Composable
fun NowQuietFixture() {
    NowBody(
        needsYou = 0, runningMissions = 0, liveSessions = 0, connected = true,
        pending = emptyList(), blocked = emptyList(), running = emptyList(), live = emptyList(),
        memory = (0..71).map { MemorySample(freeMb = 14200, totalMb = 32768, processCount = 388) },
        brains = List(4) { Brain(status = "available", enabled = true) },
        events = emptyList(),
    )
}

/**
 * A mission stopped on budget — the state the detail screen exists for.
 *
 * Blocked is the only state where a person must act, so it is the one where the
 * payload has to lead with the reason and carry the fix. A failed step sits in
 * the middle of the plan so the rail has something to locate.
 */
@Composable
fun MissionBlockedFixture() {
    MissionScreen(
        detail = MissionDetail(
            mission = MissionFull(
                id = "m1",
                title = "Port the Hermes self-improvement loop so agents write their own skills",
                objective = "Carry over the behaviours from Hermes that make an agent improve " +
                    "between sessions: skills it writes for itself, bounded memory, and " +
                    "curation that removes what stopped earning its place.",
                acceptanceCriteria = "An agent writes a skill unprompted and a later session uses it.",
                status = "blocked",
                blockedReason = "session budget exhausted after 40 sessions",
                sessionsUsed = 40, maxSessions = 40,
                costUsed = 18.42, maxCost = 25.0,
                consecutiveFailures = 2, maxConsecutiveFailures = 3,
                agent = "simba",
            ),
            steps = listOf(
                step(1, "Read the Hermes skill format", "succeeded"),
                step(2, "Design the skills table", "succeeded"),
                step(3, "Write the index that loads into every prompt", "succeeded"),
                step(4, "Teach the supervisor to harvest skills", "failed",
                    failures = "the harvest prompt returned prose instead of JSON three times"),
                step(5, "Bound the memory store with a trigger", "succeeded"),
                step(6, "Curation pass for unused skills", "running"),
                step(7, "Verify a skill is written unprompted", "pending"),
                step(8, "Verify a later session uses it", "pending"),
                step(9, "Record the outcome", "pending"),
            ),
            log = listOf(
                MissionLogEntry("2026-08-05T00:31:00Z", "warn", "blocked: session budget exhausted after 40 sessions"),
                MissionLogEntry("2026-08-05T00:12:00Z", "error", "step 4 failed for the third time; circuit opened"),
                MissionLogEntry("2026-08-04T22:40:00Z", "info", "step 6 started"),
                MissionLogEntry("2026-08-04T21:05:00Z", "info", "plan recorded: 9 steps"),
                MissionLogEntry("2026-08-04T21:02:00Z", "info", "mission created from desktop"),
            ),
        ),
        busy = false, onBack = {}, onAction = {}, onRaiseBudget = {},
    )
}

/** A finished mission: what it produced, and how it knows that worked. */
@Composable
fun MissionDoneFixture() {
    MissionScreen(
        detail = MissionDetail(
            mission = MissionFull(
                id = "m2",
                title = "Nightly repo snapshot and vault sync",
                objective = "Commit anything uncommitted, push, and write the day's digest " +
                    "into the Obsidian vault.",
                status = "completed",
                result = "Committed 6 changes across 4 repositories, pushed all of them, and " +
                    "appended a 400-word digest to Daily/2026-08-04.md.",
                verification = "git status clean in every repo; the vault note exists and its " +
                    "modified time is after the run started.",
                sessionsUsed = 2, maxSessions = 10,
                costUsed = 0.0, maxCost = 5.0,
                scheduleNote = "every day at 07:00",
                agent = "simba",
            ),
            steps = List(4) { step(it + 1, "Step ${it + 1}", "succeeded") },
            log = listOf(
                MissionLogEntry("2026-08-04T07:04:00Z", "info", "completed and verified"),
                MissionLogEntry("2026-08-04T07:00:00Z", "info", "woken by schedule"),
            ),
        ),
        busy = false, onBack = {}, onAction = {}, onRaiseBudget = {},
    )
}

private fun step(seq: Int, title: String, status: String, failures: String? = null) = MissionStep(
    seq = seq, title = title, status = status, kind = "work",
    instruction = "Do the thing described by the title, and record what happened.",
    attempts = if (status == "failed") 3 else 1,
    failures = failures,
)

/**
 * A session diff, with a patch that has all four line kinds in it.
 *
 * The patch matters: the diff colours were five hardcoded hex values until
 * recently and are now theme-derived, and the only way to know added and removed
 * are still legible against each design's background is to draw them.
 */
@Composable
fun DiffFixture() {
    DiffView(
        diff = SessionDiff(
            branch = "master",
            head = "5ae0e80",
            totalAdditions = 412,
            totalDeletions = 96,
            commits = listOf(
                DiffCommit("5ae0e80", "Lists grouped by what you would do about them", ""),
                DiffCommit("2cd6cf0", "Rebuild the palette on arithmetic, not taste", ""),
            ),
            files = listOf(
                FileDiff(
                    path = "android/app/src/main/java/com/operator/simba/Session.kt",
                    status = "modified", additions = 298, deletions = 12,
                    patch = """diff --git a/Session.kt b/Session.kt
index 8f2a1c4..b91de07 100644
--- a/Session.kt
+++ b/Session.kt
@@ -118,9 +118,14 @@ private fun StatGrid(turns: List<Turn>) {
-        StatTile("Elapsed", duration(totalSeconds), Modifier.weight(1f))
-        StatTile("Cost", cost, Modifier.weight(1f))
+    Column(verticalArrangement = Arrangement.spacedBy(space.snug)) {
+        Row(horizontalArrangement = Arrangement.spacedBy(space.snug)) {
+            StatTile("Elapsed", duration(totalSeconds), Modifier.weight(1f))
+            StatTile("Cost", cost, Modifier.weight(1f))
+        }
     }
""",
                ),
                FileDiff(
                    path = "android/app/src/main/java/com/operator/simba/Now.kt",
                    status = "untracked", additions = 114, deletions = 0,
                ),
                FileDiff(
                    path = "migrations/040_schedule_note.sql",
                    status = "modified", additions = 0, deletions = 84,
                    truncated = true,
                ),
            ),
        ),
        loading = false,
        error = null,
        onBack = {},
    )
}

/**
 * The memory pane with its add form open — the state that had two controls
 * which did not look like controls, and had never been rendered.
 *
 * Pressure is set at 21 of 24 on purpose: past 85% the copy changes from
 * "loaded every turn" to saying that new facts will be refused, and that is the
 * line worth checking, because the cap is enforced by a database trigger rather
 * than by trimming.
 */
@Composable
fun MemoryFixture() {
    MemoryPane(
        view = MemoryView(
            pressure = MemoryPressure(global = MemoryScope(used = 21, cap = 24)),
            entries = listOf(
                MemoryEntry(
                    id = "1", kind = "environment",
                    content = "Postgres runs on the scoop install at " +
                        "C:/workspace/scoop/apps/postgresql/current, not a service.",
                    source = "session 5b970b4d", confirmations = 3,
                ),
                MemoryEntry(
                    id = "2", kind = "convention",
                    content = "Never write state, plans or handoffs to markdown — Postgres is " +
                        "the only source of truth. Research notes are the sole exception.",
                    source = "stated by the operator", confirmations = 7,
                ),
                MemoryEntry(
                    id = "3", kind = "preference",
                    content = "Subscriptions only. No API-key spending; free tiers and local " +
                        "models are fine.",
                    source = "stated by the operator",
                ),
                MemoryEntry(
                    id = "4", kind = "person",
                    content = "the operator drives Simba mostly from a Galaxy S24, one-handed.",
                ),
            ),
        ),
        error = null,
        startAdding = true,
    )
}

/**
 * Skills, with a mix that makes the grouping do work.
 *
 * Three that have never been opened and four that have. The never-used group
 * leads because every skill costs prompt space on every turn of every session,
 * so an unopened one is a standing tax — and the list that surfaces those first
 * is the one that gets them removed.
 */
@Composable
fun SkillsFixture() {
    SkillsPane(
        skills = listOf(
            Skill(
                name = "raw-postgres-wire-protocol-in-node", source = "learned",
                description = "Speak the v3 protocol directly when no driver is installed.",
                useCount = 0, bodyChars = 1420,
            ),
            Skill(
                name = "opencode-runner-stdin", source = "learned",
                description = "OpenCode blocks forever on stdin without a TTY; spawn and close it.",
                useCount = 0, version = 2, bodyChars = 640,
            ),
            Skill(
                name = "windows-taskkill-tree",
                description = "Kill a process and its children on Windows from a POSIX shell.",
                useCount = 0, bodyChars = 310,
            ),
            Skill(
                name = "verify-brain-before-trusting-it", source = "learned",
                description = "Ask a brain to say OK and check which model answered.",
                useCount = 34, version = 3, bodyChars = 980,
            ),
            Skill(
                name = "compose-render-tests-without-a-device", source = "learned",
                description = "Robolectric draws the real tree to a bitmap; PixelCopy does not.",
                useCount = 12, bodyChars = 2210,
            ),
            Skill(
                name = "migration-notice-aborts-powershell",
                description = "PowerShell 5.1 turns psql NOTICE lines into terminating errors.",
                useCount = 5, bodyChars = 470,
            ),
            Skill(
                name = "cloudflare-access-service-token",
                description = "Header pair the gateway verifies at the edge before the origin sees it.",
                useCount = 2, bodyChars = 520,
            ),
        ),
    )
}

/** Decisions, including one that has been superseded. */
@Composable
fun DecisionsFixture() {
    DecisionsPane(
        decisions = listOf(
            Decision(
                id = "d1",
                statement = "Keep Jetpack Compose for the Android rebuild; replace the UI layer, not the toolkit.",
                topic = "android", confidence = "acted_on", status = "current",
                rationale = "The fault was never the toolkit — a LazyColumn on every screen " +
                    "reproduces identically in React Native or Flutter. Switching would have " +
                    "discarded the websocket stream, keystore-sealed credentials, WorkManager " +
                    "polling and the share-target Activity to fix a problem none of them cause.",
            ),
            Decision(
                id = "d2",
                statement = "Postgres is the only source of truth; never write state or plans to markdown.",
                topic = "architecture", confidence = "acted_on", status = "current",
                rationale = "Research notes are the sole exception.",
            ),
            Decision(
                id = "d3",
                statement = "Store the schedule phrase rather than re-deriving it from cron.",
                topic = "missions", confidence = "decided", status = "current",
            ),
            Decision(
                id = "d4",
                statement = "Amber is the brand accent.",
                topic = "design", confidence = "stated", status = "superseded",
                rationale = "Superseded once the contrast was computed: amber on near-black is " +
                    "semantically pre-committed to warning, and spending it on the selected tab " +
                    "and the primary button destroyed its operational meaning.",
            ),
        ),
    )
}

/**
 * A fresh install, before any credentials exist.
 *
 * The state a new phone is in for the first thirty seconds, and previously the
 * one that told you to go check a PC that was fine. Rendered because it is
 * literally the first impression the app makes.
 */
@Composable
fun NotSetUpFixture() {
    NowBody(
        needsYou = 0, runningMissions = 0, liveSessions = 0, connected = false,
        pending = emptyList(), blocked = emptyList(), running = emptyList(), live = emptyList(),
        memory = emptyList(), brains = emptyList(), events = emptyList(),
        notSetUp = true,
    )
}
