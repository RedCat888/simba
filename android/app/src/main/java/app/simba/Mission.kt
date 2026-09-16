package app.simba

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * A mission, in enough depth to decide what to do about it.
 *
 * The screen this replaces was the clearest illustration of what was wrong with
 * the app: its title was set at 16sp, and the row you tapped to reach it was
 * also set at 16sp. Drilling in changed the size of nothing. Worse, its steps
 * rendered through the same `ItemRow` as every list in the app — so the detail
 * view was not merely *like* a list row that got bigger, it was literally the
 * same component, and the screen was a list of them.
 *
 * What a detail view owes you is a payload that changes with the state, because
 * the question you are asking changes with the state:
 *
 *   **blocked** — why, and what clears it. Nothing else matters until that is
 *   answered, so it is the first thing and it carries its own action.
 *   **running** — which step, how far through, and how much budget is left
 *   before it stops on its own.
 *   **completed** — what it produced and how it knows that worked. Both fields
 *   have existed on the mission since the beginning and neither ever reached
 *   the phone, so "completed" was a word with nothing behind it.
 *   **script** — the last exit code and the last output, because a script
 *   mission has no steps and its progress is its last run.
 *
 * Below the payload, the two things that are true regardless: the plan, and the
 * mission's own log — which the gateway has always returned and the app never
 * read, so a mission could say what state it was in but nothing about how it
 * got there.
 */
@Composable
fun MissionScreen(
    detail: MissionDetail,
    busy: Boolean,
    onBack: () -> Unit,
    onAction: (String) -> Unit,
    onRaiseBudget: () -> Unit,
) {
    val m = detail.mission
    val steps = detail.steps

    LazyColumn(
        Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(bottom = space.page),
    ) {
        item { MissionHeader(m, steps, onBack) }
        item { Payload(m, steps, busy, onRaiseBudget) }
        item { Budget(m) }
        item { Controls(m, busy, onAction) }

        if (steps.isNotEmpty()) {
            item {
                SectionHeading("Plan") {
                    Text(
                        "${steps.count { it.status == "succeeded" }} of ${steps.size} done",
                        style = type.caption,
                        color = Faint,
                    )
                }
            }
            items(steps, key = { it.seq }) { StepRow(it) }
        }

        if (detail.log.isNotEmpty()) {
            item { SectionHeading("History") }
            item { Timeline(detail.log) }
        }
    }
}

@Composable
private fun MissionHeader(m: MissionFull, steps: List<MissionStep>, onBack: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = space.gutter)) {
        Row(Modifier.padding(top = space.snug)) { BackButton(onBack) }

        Text(m.title, style = type.title, color = Fg, modifier = Modifier.padding(top = space.snug))

        Row(
            Modifier.padding(top = space.tight),
            horizontalArrangement = Arrangement.spacedBy(space.snug),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier.size(7.dp)
                    .clip(RoundedCornerShape(radius.pill))
                    .background(toneFor(m.status).color()),
            )
            Text(statusLabel(m.status), style = type.caption, color = toneFor(m.status).color())
            m.agent?.let { Text("· $it", style = type.caption, color = Faint) }
            m.scheduleNote?.let { Text("· $it", style = type.caption, color = Faint) }
        }

        // The plan as a rail rather than a count. "4/9 steps" is a number you
        // have to picture; a rail is the picture, and it also shows *where* the
        // failures are rather than only how many.
        if (steps.isNotEmpty()) {
            StepRail(steps, Modifier.padding(top = space.base))
        }

        Text(
            m.objective,
            style = type.bodySmall,
            color = Dim,
            modifier = Modifier.padding(top = space.base),
        )
        m.acceptanceCriteria?.takeIf { it.isNotBlank() }?.let {
            Text(
                "Done when: $it",
                style = type.caption,
                color = Faint,
                modifier = Modifier.padding(top = space.snug),
            )
        }
    }
}

/**
 * The plan, as one bar.
 *
 * Equal segments rather than proportional, because unlike a session's turns a
 * step has no duration until it runs — the useful reading is position and state,
 * not weight. A failed step in the middle is instantly locatable, which a
 * "2 failed" badge never tells you.
 */
@Composable
private fun StepRail(steps: List<MissionStep>, modifier: Modifier = Modifier) {
    val colors = steps.map {
        when (it.status) {
            "succeeded" -> Ok
            "failed" -> Err
            "running" -> Accent
            "skipped" -> Faint
            else -> Panel2
        }
    }
    Canvas(modifier.fillMaxWidth().height(8.dp)) {
        val gap = 2.dp.toPx()
        val w = (size.width - gap * (steps.size - 1)) / steps.size
        val r = size.height / 2f
        colors.forEachIndexed { i, c ->
            drawRoundRect(
                color = c,
                topLeft = Offset((w + gap) * i, 0f),
                size = Size(w, size.height),
                cornerRadius = CornerRadius(r, r),
            )
        }
    }
}

/**
 * The one thing worth reading, chosen by state.
 *
 * This is what stops a detail screen being a list. The same mission shows a
 * different primary payload depending on what you would be opening it to find
 * out, and in every state that payload is prose rather than metadata.
 */
@Composable
private fun Payload(m: MissionFull, steps: List<MissionStep>, busy: Boolean, onRaiseBudget: () -> Unit) {
    val reason = m.blockedReason?.takeIf { it.isNotBlank() }
    val budgetBlocked = reason != null &&
        (reason.contains("budget", true) || reason.contains("exhausted", true))

    when {
        reason != null -> StatePanel("Stopped", Warn) {
            Text(reason, style = type.body, color = Fg)
            if (m.consecutiveFailures > 0) {
                Text(
                    "${m.consecutiveFailures} consecutive failures " +
                        "of ${m.maxConsecutiveFailures} allowed",
                    style = type.caption,
                    color = Faint,
                    modifier = Modifier.padding(top = space.snug),
                )
            }
            // A budget stop is the one kind the phone can actually clear, so the
            // fix sits with the reason rather than among the generic controls.
            if (budgetBlocked) {
                Box(
                    Modifier.padding(top = space.base)
                        .clip(RoundedCornerShape(radius.small))
                        .background(if (busy) Panel2 else Accent)
                        .clickable(enabled = !busy) { onRaiseBudget() }
                        .padding(horizontal = space.roomy, vertical = space.base),
                ) {
                    Text(
                        "Raise to ${m.maxSessions + 10} sessions and continue",
                        style = type.label,
                        color = if (busy) Faint else OnAccent,
                    )
                }
            }
        }

        m.status == "completed" -> StatePanel("Result", Ok) {
            Text(
                m.result?.takeIf { it.isNotBlank() }
                    ?: "Completed with no result recorded.",
                style = type.body,
                color = Fg,
            )
            m.verification?.takeIf { it.isNotBlank() }?.let {
                Text(
                    "VERIFIED BY",
                    style = type.micro,
                    color = Ok,
                    modifier = Modifier.padding(top = space.base),
                )
                Text(it, style = type.bodySmall, color = Dim, modifier = Modifier.padding(top = space.hair))
            } ?: Text(
                "Nothing was recorded about how this was verified.",
                style = type.caption,
                color = Warn,
                modifier = Modifier.padding(top = space.snug),
            )
        }

        m.script != null -> StatePanel("Last run", if (m.lastExitCode == 0) Ok else Err) {
            Text(
                if (m.lastExitCode == 0) "Exited cleanly" else "Exited ${m.lastExitCode ?: "—"}",
                style = type.body,
                color = if (m.lastExitCode == 0) Ok else Err,
            )
            m.lastOutput?.takeIf { it.isNotBlank() }?.let {
                Box(Modifier.padding(top = space.snug)) {
                    ExpandableBody(it, monospace = true, color = Dim)
                }
            }
        }

        else -> {
            val current = steps.firstOrNull { it.status == "running" }
            StatePanel("Working on", Accent) {
                Text(
                    current?.title ?: "Waiting for the next tick.",
                    style = type.body,
                    color = Fg,
                )
                current?.instruction?.takeIf { it.isNotBlank() }?.let {
                    Text(
                        it,
                        style = type.bodySmall,
                        color = Dim,
                        modifier = Modifier.padding(top = space.snug),
                    )
                }
            }
        }
    }
}

/**
 * What it has left before it stops on its own.
 *
 * Two bars rather than four numbers. A mission stops when either ceiling is hit,
 * so the interesting fact is which one is closer — which a bar answers at a
 * glance and "12/40 sessions · $4.82/$25.00" does not.
 */
@Composable
private fun Budget(m: MissionFull) {
    if (m.maxSessions <= 0 && m.maxCost <= 0.0) return
    SectionHeading("Budget")
    Column(
        Modifier.fillMaxWidth()
            .padding(horizontal = space.gutter)
            .clip(RoundedCornerShape(radius.medium))
            .background(Raised)
            .padding(space.roomy),
        verticalArrangement = Arrangement.spacedBy(space.base),
    ) {
        if (m.maxSessions > 0) {
            Meter("Sessions", "${m.sessionsUsed} of ${m.maxSessions}", m.sessionsUsed.toFloat() / m.maxSessions)
        }
        if (m.maxCost > 0.0) {
            Meter(
                "Spend",
                "$" + "%.2f".format(m.costUsed) + " of $" + "%.0f".format(m.maxCost),
                (m.costUsed / m.maxCost).toFloat(),
            )
        }
    }
}

@Composable
private fun Meter(label: String, value: String, fraction: Float) {
    Column {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(label, style = type.caption, color = Faint)
            Text(value, style = type.caption, color = Dim)
        }
        PressureBar(fraction, Modifier.padding(top = space.snug))
    }
}

/**
 * Pause, resume, retry.
 *
 * Offered by what they would actually do rather than all three always. A resume
 * button on a running mission is a control that either does nothing or does
 * something surprising, and both are worse than its absence.
 */
@Composable
private fun Controls(m: MissionFull, busy: Boolean, onAction: (String) -> Unit) {
    var confirming by remember { mutableStateOf(false) }

    if (confirming) {
        ConfirmDialog(
            title = "Stop this mission?",
            consequence = "Any step running right now is killed and the mission " +
                "will not resume on its own. Its work so far is kept.",
            confirmLabel = "Stop it",
            onConfirm = { onAction("cancel") },
            onDismiss = { confirming = false },
        )
    }

    val available = buildList {
        if (m.status == "running") add("pause" to "Pause")
        if (m.status in setOf("paused", "blocked")) add("resume" to "Resume")
        if (m.status in setOf("blocked", "failed") || m.consecutiveFailures > 0) add("retry" to "Retry")
        if (m.status !in setOf("completed", "cancelled")) add("cancel" to "Stop")
    }
    if (available.isEmpty()) return

    Row(
        Modifier.fillMaxWidth().padding(horizontal = space.gutter, vertical = space.base),
        horizontalArrangement = Arrangement.spacedBy(space.snug),
    ) {
        available.forEach { (action, label) ->
            Box(
                Modifier.weight(1f)
                    .clip(RoundedCornerShape(radius.small))
                    .background(Raised)
                    // Stop is the only one here that ends work in flight, and
                    // it sits beside Resume and Retry where a stray thumb finds
                    // it. The others are all recoverable by tapping again.
                    .clickable(enabled = !busy) {
                        if (action == "cancel") confirming = true else onAction(action)
                    }
                    .padding(vertical = space.base),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label,
                    style = type.label,
                    color = when {
                        busy -> Faint
                        action == "cancel" -> Err
                        else -> Accent
                    },
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
private fun StepRow(s: MissionStep) {
    ItemRow(
        title = "${s.seq}. ${s.title}",
        meta = buildList {
            // Almost every step is kind "work", so stating it on every row is a
            // word repeated nine times that distinguishes nothing. It earns its
            // place only when it is something else.
            if (s.kind != "work") add(ItemMeta(s.kind))
            if (s.attempts > 1) add(ItemMeta("${s.attempts} attempts", Tone.Warn))
        },
        badge = when (s.status) {
            "pending" -> null
            else -> ItemMeta(statusLabel(s.status), toneFor(s.status))
        },
        expanded = {
            Column(verticalArrangement = Arrangement.spacedBy(space.snug)) {
                Text(s.instruction, style = type.bodySmall, color = Dim)
                s.result?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = type.bodySmall, color = Ok)
                }
                s.failures?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = type.bodySmall, color = Err)
                }
            }
        },
    )
}

/**
 * How it got here.
 *
 * A rail with dots rather than rows, because these entries are short, ordered
 * and causal — the shape of the sequence is the information, and a list of
 * cards would spend a screen height saying six short sentences.
 */
@Composable
private fun Timeline(log: List<MissionLogEntry>) {
    Column(Modifier.fillMaxWidth().padding(horizontal = space.gutter)) {
        log.take(24).forEachIndexed { i, e ->
            val tone = when (e.level) {
                "error" -> Err
                "warn" -> Warn
                else -> Faint
            }
            Row(Modifier.fillMaxWidth()) {
                // The rail: a dot for this entry and a line continuing to the
                // next, so the column reads as one sequence rather than as
                // unrelated rows that happen to be stacked.
                Column(
                    Modifier.padding(end = space.base),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box(
                        Modifier.padding(top = space.tight).size(7.dp)
                            .clip(RoundedCornerShape(radius.pill))
                            .background(tone),
                    )
                    if (i < log.lastIndex && i < 23) {
                        Box(
                            Modifier.padding(top = space.hair)
                                .size(width = 1.dp, height = 26.dp)
                                .background(Line),
                        )
                    }
                }
                Column(Modifier.padding(bottom = space.base)) {
                    Text(e.message, style = type.bodySmall, color = if (e.level == "info") Dim else tone)
                    Text(ago(e.ts), style = type.micro, color = Faint)
                }
            }
        }
    }
}

/** A titled block. The eyebrow carries the state's colour; the body never does. */
@Composable
private fun StatePanel(label: String, accent: Color, content: @Composable ColumnScope.() -> Unit) {
    SectionHeading(label)
    Column(
        Modifier.fillMaxWidth()
            .padding(horizontal = space.gutter)
            .clip(RoundedCornerShape(radius.medium))
            .background(Raised)
            .padding(space.roomy),
        content = content,
    )
    // The accent is spent on the heading rather than on a coloured card fill.
    // A full-bleed status colour is for something genuinely blocking, and if
    // every state gets one then none of them reads as blocking.
    @Suppress("UNUSED_EXPRESSION")
    accent
}

private typealias ColumnScope = androidx.compose.foundation.layout.ColumnScope
