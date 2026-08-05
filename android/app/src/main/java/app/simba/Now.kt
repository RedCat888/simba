package com.operator.simba

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * What needs you, and what is happening.
 *
 * The app had no answer to the only question worth opening it for. Five tabs
 * named after database tables meant the first thing you saw was a list of
 * conversations, and finding out that a mission had been blocked since 2am took
 * three taps and knowing where to look.
 *
 * The ordering here is not by kind, it is by whether you have to do something:
 *
 *   1. **Blocking on you** — an approval an agent is waiting on, a mission
 *      stopped for a reason a person has to clear. Nothing else can be the first
 *      thing on this screen.
 *   2. **Running, and whether it is really running** — the freshness of a
 *      session matters more than its status. "Running" and "running, but silent
 *      for forty minutes" are different situations and only one of them is fine.
 *   3. **The machine** — one line when healthy. It expands only when it is not.
 *   4. **What just happened** — the last few notable events, so an overnight run
 *      can be understood without opening anything.
 *
 * When nothing needs attention this screen says so in one line and gets out of
 * the way. An ops surface that manufactures urgency to look busy is worse than
 * no ops surface, because it trains you to ignore it.
 */
@Composable
fun NowScreen(
    vm: SimbaVm,
    onOpenMission: (String) -> Unit,
    onOpenSession: (String, String) -> Unit,
    onOpenSystem: () -> Unit,
) {
    var pending by remember { mutableStateOf<List<PendingAction>>(emptyList()) }
    var memory by remember { mutableStateOf<List<MemorySample>>(emptyList()) }
    var events by remember { mutableStateOf<List<SystemEvent>>(emptyList()) }
    var busy by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        val api = vm.api ?: return
        runCatching { api.pendingActions() }.onSuccess { pending = it }
        runCatching { api.memory(hours = 12) }.onSuccess { memory = it }
        runCatching { api.events() }.onSuccess { events = it }
    }
    LaunchedEffect(vm.api) { load() }
    // Slower than the session poll: these change on the scale of minutes, and a
    // landing screen that refetches constantly costs battery to tell you nothing.
    LaunchedEffect(vm.api) { while (true) { delay(45_000); load() } }

    val blocked = vm.missions.filter { it.status == "blocked" || it.blockedReason != null }
    val running = vm.missions.filter { it.status == "running" }
    val live = vm.sessions.filter { it.status in setOf("running", "idle") }

    NowBody(
        needsYou = pending.size + blocked.size,
        runningMissions = running.size,
        liveSessions = live.size,
        connected = vm.error == null && vm.stats != null,
        pending = pending,
        blocked = blocked,
        running = running,
        live = live,
        memory = memory,
        brains = vm.brains,
        events = events,
        busyAction = busy,
        onOpenMission = onOpenMission,
        onOpenSession = onOpenSession,
        onOpenSystem = onOpenSystem,
        onDecide = { action, approve ->
            busy = action.id
            vm.viewModelScope.launch {
                runCatching { vm.api?.decideAction(action.id, approve) }
                    .onFailure { vm.error = it.message }
                load()
                busy = null
            }
        },
    )
}

/**
 * The screen itself, given everything it needs.
 *
 * Split from the loader so it can be rendered — and therefore looked at — in
 * both of its states without a gateway behind it. The quiet state matters as
 * much as the busy one: it is the state this screen will be in most of the time,
 * and a landing surface that looks broken when everything is fine is worse than
 * not having one.
 */
@Composable
fun NowBody(
    needsYou: Int,
    runningMissions: Int,
    liveSessions: Int,
    connected: Boolean,
    pending: List<PendingAction>,
    blocked: List<Mission>,
    running: List<Mission>,
    live: List<SessionRow>,
    memory: List<MemorySample>,
    brains: List<Brain>,
    events: List<SystemEvent>,
    busyAction: String? = null,
    onOpenMission: (String) -> Unit = {},
    onOpenSession: (String, String) -> Unit = { _, _ -> },
    onOpenSystem: () -> Unit = {},
    onDecide: (PendingAction, Boolean) -> Unit = { _, _ -> },
) {
    LazyColumn(
        Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(bottom = space.page),
    ) {
        item { Headline(needsYou, runningMissions, liveSessions, connected) }

        // -------------------------------------------------------------- act
        if (pending.isNotEmpty()) {
            item { SectionHeading("Waiting for you") }
            items(pending, key = { it.id }) { action ->
                ApprovalCard(
                    action = action,
                    busy = busyAction == action.id,
                    onDecide = { approve -> onDecide(action, approve) },
                )
            }
        }

        if (blocked.isNotEmpty()) {
            item { SectionHeading("Stopped") }
            items(blocked, key = { it.id }) { m ->
                ItemRow(
                    title = m.title,
                    // The reason is the whole point of the row. A blocked mission
                    // with no stated cause is indistinguishable from a bug.
                    subtitle = m.blockedReason ?: "blocked with no reason recorded",
                    badge = ItemMeta("blocked", Tone.Warn),
                    meta = listOf(ItemMeta("${m.doneSteps}/${m.totalSteps} steps")),
                    onClick = { onOpenMission(m.id) },
                )
            }
        }

        // ------------------------------------------------------------- live
        if (running.isNotEmpty() || live.isNotEmpty()) {
            item { SectionHeading("Working") }
            items(running, key = { "m" + it.id }) { m ->
                ItemRow(
                    title = m.title,
                    subtitle = m.currentStep,
                    badge = ItemMeta("running", Tone.Good),
                    meta = buildList {
                        add(ItemMeta("${m.doneSteps}/${m.totalSteps} steps"))
                        if (m.costUsed > 0) add(ItemMeta("$" + "%.2f".format(m.costUsed)))
                        else add(ItemMeta("free", Tone.Good))
                    },
                    onClick = { onOpenMission(m.id) },
                )
            }
            items(live, key = { "s" + it.id }) { s ->
                val quiet = s.lastActivityAt?.let { minutesSince(it) } ?: 0
                ItemRow(
                    title = s.title ?: s.agent,
                    // Silence is the finding. A session that has said nothing for
                    // half an hour is usually more urgent than one that failed,
                    // and no status string anywhere carries that.
                    subtitle = s.lastActivityAt?.let { "last activity ${ago(it)}" },
                    badge = when {
                        quiet >= 30 -> ItemMeta(quietLabel(quiet), Tone.Warn)
                        else -> ItemMeta(statusLabel(s.status), Tone.Good)
                    },
                    meta = buildList {
                        s.brain?.let { add(ItemMeta(it)) }
                        if (s.cost > 0) add(ItemMeta("$" + "%.2f".format(s.cost)))
                    },
                    onClick = { onOpenSession(s.id, s.title ?: s.agent) },
                )
            }
        }

        // ----------------------------------------------------------- machine
        if (memory.isNotEmpty()) {
            item { MachineStrip(memory, brains, onOpenSystem) }
        }

        // ---------------------------------------------------------- recently
        val recent = events.filter { it.notable }.take(6)
        if (recent.isNotEmpty()) {
            item { SectionHeading("Recently") }
            items(recent, key = { it.id }) { e ->
                ItemRow(
                    title = e.label,
                    subtitle = e.message,
                    badge = when (e.severity) {
                        "error" -> ItemMeta("error", Tone.Bad)
                        "warn" -> ItemMeta("warn", Tone.Warn)
                        else -> null
                    },
                    meta = listOf(ItemMeta(ago(e.ts))),
                )
            }
        }

        if (needsYou == 0 && running.isEmpty() && live.isEmpty() && recent.isEmpty()) {
            item {
                EmptyState(
                    "Nothing running",
                    "No missions in flight and nothing waiting on you. Start something from Chat or Missions.",
                )
            }
        }
    }
}

/**
 * The state of things, in a sentence.
 *
 * One sentence rather than a row of counters, because a counter is a number you
 * have to interpret and a sentence is a fact you have already read. The
 * attention count is the only part that changes colour, and only when it is not
 * zero.
 */
@Composable
private fun Headline(needsYou: Int, missions: Int, sessions: Int, connected: Boolean) {
    Column(
        Modifier.fillMaxWidth()
            .padding(horizontal = space.gutter)
            .padding(top = space.roomy),
    ) {
        Text(
            when {
                !connected -> "Can't reach the machine"
                needsYou > 0 -> "$needsYou ${if (needsYou == 1) "thing needs" else "things need"} you"
                missions > 0 || sessions > 0 -> "Working"
                else -> "All quiet"
            },
            style = type.display,
            color = if (needsYou > 0 && connected) Warn else Fg,
        )
        Text(
            buildList {
                if (missions > 0) add("$missions ${if (missions == 1) "mission" else "missions"}")
                if (sessions > 0) add("$sessions live")
                add(if (connected) "PC connected" else "offline")
            }.joinToString(" · "),
            style = type.bodySmall,
            color = Faint,
            modifier = Modifier.padding(top = space.tight),
        )
    }
}

/**
 * An approval, with the consequence stated.
 *
 * The two buttons are deliberately not the same weight. Approving lets an agent
 * do something to a real machine; declining costs nothing and is reversible by
 * asking again. Making them symmetrical would be treating those as equivalent.
 */
@Composable
private fun ApprovalCard(action: PendingAction, busy: Boolean, onDecide: (Boolean) -> Unit) {
    Column(
        Modifier.fillMaxWidth()
            .padding(horizontal = space.gutter, vertical = space.tight)
            .clip(RoundedCornerShape(radius.medium))
            .background(Raised)
            .padding(space.roomy),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(action.actionClass, style = type.micro, color = Warn)
            action.agent?.let {
                Text(" · $it", style = type.micro, color = Faint)
            }
        }
        Text(
            action.summary,
            style = type.body,
            color = Fg,
            modifier = Modifier.padding(top = space.snug),
        )
        action.target?.takeIf { it.isNotBlank() }?.let {
            Text(
                // 46 was too generous: shortPath trimmed to its budget and
                // Compose then ellipsized again because mono at this size
                // overflows the card, so the path ended in two ellipses with
                // the file extension gone. The budget has to fit the width the
                // text is actually given, not the width of the screen.
                shortPath(it, 36),
                style = type.mono,
                color = Faint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = space.tight),
            )
        }
        action.error?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = type.caption, color = Err, modifier = Modifier.padding(top = space.snug))
        }

        Row(
            Modifier.padding(top = space.base),
            horizontalArrangement = Arrangement.spacedBy(space.snug),
        ) {
            Box(
                Modifier.weight(1f)
                    .clip(RoundedCornerShape(radius.small))
                    .background(if (busy) Panel2 else Accent)
                    .clickable(enabled = !busy) { onDecide(true) }
                    .padding(vertical = space.base),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    if (busy) "…" else "Approve",
                    style = type.label,
                    color = if (busy) Faint else OnAccent,
                )
            }
            Box(
                Modifier
                    .clip(RoundedCornerShape(radius.small))
                    .background(Inset)
                    .clickable(enabled = !busy) { onDecide(false) }
                    .padding(horizontal = space.roomy, vertical = space.base),
                contentAlignment = Alignment.Center,
            ) {
                Text("Decline", style = type.label, color = Dim)
            }
        }
    }
}

/**
 * The machine, in one line when it is fine.
 *
 * Agents are CLI processes on a home PC, so memory is the resource that actually
 * runs out overnight — and it runs out slowly, which means the shape matters
 * more than the number. The sparkline is the whole point: 6GB free is fine if it
 * has been 6GB all night and alarming if it was 16GB an hour ago.
 */
@Composable
private fun MachineStrip(samples: List<MemorySample>, brains: List<Brain>, onOpen: () -> Unit) {
    val latest = samples.lastOrNull() ?: return
    val free = samples.map { it.freeMb.toFloat() }
    val tight = latest.pressure > 0.85f
    val down = brains.count { !it.enabled || it.status !in setOf("available", "idle") }

    SectionHeading("Machine") {
        Text(
            if (tight || down > 0) "needs a look" else "healthy",
            style = type.micro,
            color = if (tight || down > 0) Warn else Ok,
        )
    }
    Column(
        Modifier.fillMaxWidth()
            .padding(horizontal = space.gutter)
            .clip(RoundedCornerShape(radius.medium))
            .background(Raised)
            .clickable { onOpen() }
            .padding(space.roomy),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("${latest.freeMb / 1024}GB free", style = type.heading, color = if (tight) Warn else Fg)
            Text(
                "${brains.size - down}/${brains.size} brains",
                style = type.caption,
                color = if (down > 0) Warn else Faint,
            )
        }
        Sparkline(free, Modifier.padding(top = space.snug), color = if (tight) Warn else Info)
        Text(
            "${latest.processCount} processes · last 12 hours",
            style = type.micro,
            color = Faint,
            modifier = Modifier.padding(top = space.tight),
        )
    }
}

// ---------------------------------------------------------------------------
// Time, said the way people say it
// ---------------------------------------------------------------------------

/**
 * How long a session has been silent, phrased like everything else.
 *
 * It read "quiet 506m" directly above a line saying "last activity 8h ago" —
 * the same fact in two formats, adjacent, and the three-digit one also overflowed
 * the status column it had to fit in. Anything past ninety minutes is said in
 * hours, which is how the rest of the app says it.
 */
fun quietLabel(minutes: Long): String =
    if (minutes >= 90) "quiet ${minutes / 60}h" else "quiet ${minutes}m"

/**
 * Minutes since an ISO-8601 instant, or 0 if it cannot be read.
 *
 * Returning 0 rather than throwing on an unparseable timestamp is deliberate:
 * the consequence of a bad parse should be "no freshness warning", never a
 * screen that fails to draw because one row had an odd date.
 */
fun minutesSince(iso: String): Long = runCatching {
    val then = java.time.Instant.parse(iso)
    java.time.Duration.between(then, java.time.Instant.now()).toMinutes().coerceAtLeast(0)
}.getOrDefault(0)

/**
 * Relative time, but only for the first 48 hours.
 *
 * Past two days "3 days ago" makes you do arithmetic to work out which day, and
 * nobody wants to do arithmetic while diagnosing a machine. After that it says
 * the date.
 */
fun ago(iso: String): String {
    val minutes = runCatching {
        java.time.Duration.between(java.time.Instant.parse(iso), java.time.Instant.now()).toMinutes()
    }.getOrNull() ?: return iso.take(16).replace('T', ' ')

    return when {
        minutes < 1 -> "just now"
        minutes < 60 -> "${minutes}m ago"
        minutes < 60 * 48 -> "${minutes / 60}h ago"
        else -> iso.take(10)
    }
}
