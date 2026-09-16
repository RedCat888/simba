package app.simba

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/**
 * What actually happened in one session.
 *
 * This screen is the argument for the whole rebuild. Everything it shows was
 * already in Postgres and already served by the gateway; the app had simply
 * never asked, so a session was a row saying "completed · $1.03" and there was
 * no way to find out what that meant.
 *
 * It is deliberately not a list. Six kinds of thing appear here and they are not
 * peers, so they do not get peer treatment:
 *
 *   1. **The shape of the session**, as a proportional timeline. This is the
 *      lead because it is the only thing that answers "where did the time go"
 *      in under a second — a typical session turns out to be one turn that took
 *      six minutes and four that took seconds, which no list of turns reveals.
 *   2. **Four numbers**, as tiles rather than a sentence. Duration, cost,
 *      tokens, cache. A tile can be read without reading; a comma-separated run
 *      of metadata cannot.
 *   3. **The agent's own account of its work** — the checkpoint. Prose the agent
 *      wrote about what it was asked, what it did, what remains and what it is
 *      unsure of. The most valuable text in the system and the least visible.
 *   4. **Git state**, because unattended work that touched files is only
 *      trustworthy if you can see which.
 *   5. **The turns themselves**, for when the timeline raises a question.
 *   6. **Lineage**, when the work has moved between brains.
 *
 * Sections 3 and 4 are absent for most sessions and the screen must not look
 * broken when they are, which is why nothing here reserves space for something
 * that might not arrive.
 */
@Composable
fun SessionScreen(
    vm: SimbaVm,
    sessionId: String,
    title: String,
    onBack: () -> Unit,
    onOpenChat: () -> Unit,
    onOpenDiff: () -> Unit,
) {
    var turns by remember(sessionId) { mutableStateOf<List<Turn>>(emptyList()) }
    var checkpoint by remember(sessionId) { mutableStateOf<Checkpoint?>(null) }
    var lineage by remember(sessionId) { mutableStateOf<List<LineageStep>>(emptyList()) }
    var loading by remember(sessionId) { mutableStateOf(true) }
    var failure by remember(sessionId) { mutableStateOf<String?>(null) }

    LaunchedEffect(sessionId) {
        val api = vm.api
        // Each is optional. A session with no checkpoint is normal, not an
        // error, and one missing section must not blank the screen.
        runCatching { api?.turns(sessionId).orEmpty() }
            .onSuccess { turns = it }
            .onFailure { failure = it.message }
        runCatching { api?.checkpoints(sessionId).orEmpty() }
            .onSuccess { checkpoint = it.firstOrNull() }
        runCatching { api?.lineage(sessionId).orEmpty() }
            .onSuccess { lineage = it }
        loading = false
    }

    val row = vm.sessions.firstOrNull { it.id == sessionId }

    SessionDetail(
        title = row?.title ?: title,
        agent = row?.agent,
        status = row?.status ?: "",
        brain = row?.brain,
        sessionError = row?.error,
        turns = turns,
        checkpoint = checkpoint,
        lineage = lineage,
        loading = loading,
        failure = failure,
        onBack = onBack,
        onOpenChat = onOpenChat,
        onOpenDiff = onOpenDiff,
    )
}

/**
 * The screen itself, given everything it needs.
 *
 * Split from the loader above so it can be rendered — and therefore looked at —
 * without a gateway behind it. A screen that can only be seen by running the
 * whole system against live data is a screen nobody checks, which is most of how
 * the previous version of this app got the way it did.
 */
@Composable
fun SessionDetail(
    title: String,
    agent: String?,
    status: String,
    brain: String?,
    sessionError: String?,
    turns: List<Turn>,
    checkpoint: Checkpoint?,
    lineage: List<LineageStep>,
    loading: Boolean = false,
    failure: String? = null,
    onBack: () -> Unit = {},
    onOpenChat: () -> Unit = {},
    onOpenDiff: () -> Unit = {},
) {
    LazyColumn(
        Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(bottom = space.page),
    ) {
        item {
            SessionHeader(
                title = title,
                agent = agent,
                status = status,
                brain = brain,
                turns = turns,
                onBack = onBack,
            )
        }

        if (loading && turns.isEmpty()) {
            item { LoadingState(2) }
        }
        failure?.let { item { FailureState(it) } }

        sessionError?.takeIf { it.isNotBlank() }?.let {
            item {
                Box(Modifier.padding(horizontal = space.gutter, vertical = space.snug)) {
                    ErrorBlock(it, label = "Session failed")
                }
            }
        }

        if (turns.isNotEmpty()) {
            item { StatGrid(turns) }
        } else if (!loading && failure == null) {
            // A session that exists but has not taken a turn — started seconds
            // ago, or spawned and never prompted. Everything below is absent for
            // it, so without this the screen is a title and two buttons.
            item {
                EmptyState(
                    "No turns yet",
                    "This session has not produced a turn, so there is nothing to measure.",
                )
            }
        }

        // Two things a person wants to do from here, and they are actions on the
        // session rather than more of it — so they sit above the reading, not
        // buried under it.
        item {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = space.gutter, vertical = space.base),
                horizontalArrangement = Arrangement.spacedBy(space.snug),
            ) {
                QuietAction("Open conversation", Modifier.weight(1f), onOpenChat)
                QuietAction("Review changes", Modifier.weight(1f), onOpenDiff)
            }
        }

        checkpoint?.let { cp ->
            item { CheckpointBlock(cp) }
            if (cp.gitBranch != null || cp.gitDiffstat != null) item { GitBlock(cp) }
        }

        if (turns.isNotEmpty()) {
            item {
                SectionHeading("Turns") {
                    Text("${turns.size}", style = type.caption, color = Faint)
                }
            }
            items(turns, key = { it.seq }) { TurnRow(it) }
        }

        // Depth 1+ means this work has been continued from somewhere. Only shown
        // when it happened, because "1 session in this chain" is not information.
        if (lineage.size > 1) {
            item { SectionHeading("Carried over from") }
            items(lineage.drop(1), key = { it.id }) { LineageRow(it) }
        }
    }
}

/**
 * The lead.
 *
 * Title, one line of identity, and immediately the timeline — no card around it,
 * no label above it. The shape of the session is the headline fact and it is
 * given the space a headline gets.
 */
@Composable
private fun SessionHeader(
    title: String,
    agent: String?,
    status: String,
    brain: String?,
    turns: List<Turn>,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = space.gutter)) {
        Row(Modifier.padding(top = space.snug), verticalAlignment = Alignment.CenterVertically) {
            BackButton(onBack)
        }

        Text(
            title,
            style = type.title,
            color = Fg,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = space.snug),
        )

        Row(
            Modifier.padding(top = space.tight),
            horizontalArrangement = Arrangement.spacedBy(space.snug),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusDot(status)
            Text(statusLabel(status), style = type.caption, color = toneFor(status).color())
            agent?.let { Text("· $it", style = type.caption, color = Faint) }
            brain?.let { Text("· $it", style = type.caption, color = Faint) }
        }

        if (turns.isNotEmpty()) {
            TurnTimeline(turns, Modifier.padding(top = space.base))
            // The legend earns its place only when there is more than one tier
            // in the bar; otherwise it explains a single colour.
            val tiers = turns.mapNotNull { it.modelTier }.distinct()
            if (tiers.size > 1) {
                Row(
                    Modifier.padding(top = space.snug),
                    horizontalArrangement = Arrangement.spacedBy(space.base),
                ) {
                    tiers.forEach { tier ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                Modifier.size(7.dp)
                                    .clip(RoundedCornerShape(radius.pill))
                                    .background(defaultTierColor(tier)),
                            )
                            Text(
                                tier,
                                style = type.micro,
                                color = Faint,
                                modifier = Modifier.padding(start = space.tight),
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * Four numbers, as tiles.
 *
 * A tile is readable without being read — the eye lands on the value and the
 * label is there if the value surprises. The same four facts written as
 * "6m 39s · $1.03 · 21.6k tokens · 681k cached" is a sentence, and a sentence
 * has to be parsed.
 *
 * Cache reads get a tile of their own because they are the number that explains
 * the others: 681k cached against 34 input tokens is why a six-minute turn cost
 * a dollar rather than twenty.
 */
@Composable
private fun StatGrid(turns: List<Turn>) {
    val totalSeconds = turns.sumOf { it.seconds }
    val cost = turns.sumOf { it.costUsd }
    val out = turns.sumOf { it.outputTokens }
    val cached = turns.sumOf { it.cacheReadTokens }

    Column(
        Modifier.fillMaxWidth().padding(horizontal = space.gutter, vertical = space.snug),
        verticalArrangement = Arrangement.spacedBy(space.snug),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(space.snug)) {
            StatTile("Elapsed", duration(totalSeconds), Modifier.weight(1f))
            StatTile(
                "Cost",
                if (cost <= 0.0) "free" else "$" + "%.2f".format(cost),
                Modifier.weight(1f),
                tone = if (cost <= 0.0) Ok else Fg,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(space.snug)) {
            StatTile("Output", tokens(out), Modifier.weight(1f))
            // Cache reads are the number that explains the others: 818k read
            // against 34 sent is why a seven-minute session cost a dollar
            // rather than twenty.
            StatTile("Cached", tokens(cached), Modifier.weight(1f), tone = if (cached > 0) Info else Faint)
        }
    }
}

@Composable
private fun StatTile(label: String, value: String, modifier: Modifier = Modifier, tone: Color = Fg) {
    Column(
        modifier
            .clip(RoundedCornerShape(radius.small))
            .background(Raised)
            .padding(horizontal = space.base, vertical = space.base),
    ) {
        Text(value, style = type.title, color = tone, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
            label,
            style = type.micro,
            color = Faint,
            modifier = Modifier.padding(top = space.hair),
        )
    }
}

/**
 * The agent's account of its own work.
 *
 * Every field here is prose an agent wrote about itself, and they are ordered by
 * what a person woken at 3am actually needs: what is left, then what is unclear,
 * then what went wrong, and only then what was achieved. That is the reverse of
 * how the record is written and the right order to read it in.
 */
@Composable
private fun CheckpointBlock(cp: Checkpoint) {
    SectionHeading("Where it got to") {
        Text(cp.reason, style = type.micro, color = Faint)
    }
    Column(
        Modifier.fillMaxWidth()
            .padding(horizontal = space.gutter)
            .clip(RoundedCornerShape(radius.medium))
            .background(Raised)
            .padding(space.roomy),
        verticalArrangement = Arrangement.spacedBy(space.base),
    ) {
        cp.taskStatement?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = type.body, color = Fg)
        }
        Field("Still to do", cp.workRemaining, Warn)
        Field("Open questions", cp.openQuestions, Info)
        Field("Failures", cp.failures, Err)
        Field("Decisions taken", cp.keyDecisions, Faint)
        Field("Done", cp.workDone, Faint)

        if (cp.tokenEstimate > 0) {
            Text(
                "context at checkpoint · ${tokens(cp.tokenEstimate)} tokens",
                style = type.micro,
                color = Faint,
            )
        }
    }
}

/** One labelled paragraph, absent entirely when there is nothing to say. */
@Composable
private fun Field(label: String, value: String?, accent: Color) {
    val text = value?.takeIf { it.isNotBlank() } ?: return
    Column {
        Text(label.uppercase(), style = type.micro, color = accent)
        Text(
            text,
            style = type.bodySmall,
            color = Dim,
            modifier = Modifier.padding(top = space.hair),
        )
    }
}

/**
 * What it touched.
 *
 * A dirty worktree is the single most actionable fact on this screen — it means
 * work exists that nothing has collected — so it is stated as a word rather than
 * inferred from a diffstat nobody reads carefully.
 */
@Composable
private fun GitBlock(cp: Checkpoint) {
    SectionHeading("Working tree") {
        if (cp.gitDirty) {
            Text("uncommitted", style = type.micro, color = Warn)
        }
    }
    Column(
        Modifier.fillMaxWidth()
            .padding(horizontal = space.gutter)
            .clip(RoundedCornerShape(radius.medium))
            .background(Raised)
            .padding(space.base),
        verticalArrangement = Arrangement.spacedBy(space.snug),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(space.snug)) {
            cp.gitBranch?.let { Text(it, style = type.mono, color = Accent) }
            cp.gitHead?.let { Text(it.take(8), style = type.mono, color = Faint) }
        }
        cp.gitDiffstat?.takeIf { it.isNotBlank() }?.let {
            Text(
                it,
                style = type.mono,
                color = Dim,
                modifier = Modifier.horizontalScroll(rememberScrollState()),
            )
        }
        if (cp.recentFiles.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(space.hair)) {
                // Paths matter at the end, not the start: a phone-width row that
                // truncates on the right shows only directories.
                cp.recentFiles.take(6).forEach {
                    Text(shortPath(it, pathBudget(40)), style = type.mono, color = Faint, maxLines = 1)
                }
                if (cp.recentFiles.size > 6) {
                    Text(
                        "+${cp.recentFiles.size - 6} more",
                        style = type.micro,
                        color = Faint,
                    )
                }
            }
        }
    }
}

/**
 * One turn.
 *
 * The bar is not decoration — it is this turn's share of the session's elapsed
 * time, so the rows visually reproduce the timeline above and a long turn is
 * recognisable in both places as the same thing.
 */
@Composable
private fun TurnRow(t: Turn) {
    ItemRow(
        title = "${t.seq}. ${t.model ?: t.modelTier ?: "unknown"}",
        subtitle = t.error,
        badge = when {
            t.error != null -> ItemMeta("error", Tone.Bad)
            t.status == "completed" -> null
            else -> ItemMeta(statusLabel(t.status), Tone.Warn)
        },
        meta = buildList {
            t.durationMs?.let { add(ItemMeta(duration(it / 1000.0))) }
            if (t.outputTokens > 0) add(ItemMeta("${tokens(t.outputTokens)} out"))
            if (t.costUsd > 0) add(ItemMeta("$" + "%.3f".format(t.costUsd)))
            else add(ItemMeta("free", Tone.Good))
        },
        expanded = {
            Column(verticalArrangement = Arrangement.spacedBy(space.tight)) {
                TokenLine("input", t.inputTokens)
                TokenLine("output", t.outputTokens)
                TokenLine("cache read", t.cacheReadTokens)
                TokenLine("cache written", t.cacheCreationTokens)
                t.stopReason?.let {
                    Text("stopped: $it", style = type.caption, color = Faint)
                }
                t.brain?.let {
                    Text("served by $it", style = type.caption, color = Faint)
                }
            }
        },
    )
}

@Composable
private fun TokenLine(label: String, n: Long) {
    if (n <= 0) return
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = type.caption, color = Faint)
        Text(tokens(n), style = type.mono, color = Dim)
    }
}

@Composable
private fun LineageRow(step: LineageStep) {
    ItemRow(
        title = step.title ?: "session ${step.id.take(8)}",
        subtitle = step.error,
        badge = ItemMeta(statusLabel(step.status), toneFor(step.status)),
        meta = buildList {
            add(ItemMeta("${step.depth} back"))
            if (step.swapCount > 0) add(ItemMeta("${step.swapCount} swaps", Tone.Accented))
            if (step.cost > 0) add(ItemMeta("$" + "%.2f".format(step.cost)))
        },
    )
}

/** A button that does not shout. Used where two actions are peers. */
@Composable
private fun QuietAction(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(
        modifier
            .clip(RoundedCornerShape(radius.small))
            .background(Raised)
            .clickable { onClick() }
            .padding(vertical = space.snug),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = type.label, color = Accent, maxLines = 1)
    }
}

@Composable
private fun StatusDot(status: String) {
    Box(
        Modifier.size(7.dp)
            .clip(RoundedCornerShape(radius.pill))
            .background(toneFor(status).color()),
    )
}

/**
 * Seconds as something a person reads.
 *
 * Deliberately never "399s". Above a minute people think in minutes, and a
 * three-digit second count is a number you have to do arithmetic on to
 * understand — which is the opposite of what a stat tile is for.
 */
fun duration(seconds: Double): String = when {
    seconds < 1 -> "<1s"
    seconds < 60 -> "${seconds.toInt()}s"
    seconds < 3600 -> "${(seconds / 60).toInt()}m ${(seconds % 60).toInt()}s"
    else -> "${(seconds / 3600).toInt()}h ${((seconds % 3600) / 60).toInt()}m"
}
