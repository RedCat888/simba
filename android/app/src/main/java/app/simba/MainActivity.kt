package com.operator.simba

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Transparent bars; which way round the clock and wifi icons are drawn is
        // decided by SimbaTheme, because the theme is the only thing that knows
        // whether the chrome behind them ended up light or dark. Pinning it here
        // was safe only while every design was dark.
        enableEdgeToEdge()
        setContent { SimbaThemeHost { SimbaRoot() } }
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

class SimbaVm : ViewModel() {
    var api: SimbaApi? = null

    var stats by mutableStateOf<Stats?>(null)
    var missions by mutableStateOf<List<Mission>>(emptyList())
    var agents by mutableStateOf<List<Agent>>(emptyList())
    var brains by mutableStateOf<List<Brain>>(emptyList())
    var briefs by mutableStateOf<List<Brief>>(emptyList())
    var sessions by mutableStateOf<List<SessionRow>>(emptyList())
    var error by mutableStateOf<String?>(null)
    var loading by mutableStateOf(false)

    fun refresh() {
        val a = api ?: return
        viewModelScope.launch {
            loading = true
            try {
                stats = a.stats()
                missions = a.missions()
                agents = a.agents()
                briefs = a.briefs()
                brains = a.brains()
                sessions = a.sessions()
                error = null
            } catch (e: Exception) {
                // Surfaced rather than swallowed: the most common failure here
                // is the PC being asleep or the tunnel being down, and silently
                // showing stale data hides that completely.
                error = e.message ?: "unreachable"
            } finally {
                loading = false
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/**
 * Screens reached by tapping something, rather than by choosing a destination.
 *
 * Kept as a single nullable value rather than a stack: every push in this app is
 * one level deep except session -> diff, and that one is expressed as a push
 * that knows how to go back to its parent. A general back stack would be more
 * machinery than there is navigation to manage, and machinery that is not
 * exercised is machinery that is wrong.
 */
private sealed interface Push {
    data class MissionDetail(val id: String) : Push
    data class SessionDetail(val id: String, val title: String) : Push
    data class SessionDiff(val id: String) : Push
    data object Agents : Push
    data object Knowledge : Push
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SimbaRoot(vm: SimbaVm = viewModel()) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var dest by remember { mutableStateOf(Destination.Now) }
    var openChat by remember { mutableStateOf<Pair<String, String>?>(null) }
    var push by remember { mutableStateOf<Push?>(null) }
    var ready by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        vm.api = ctx.api()
        ready = true
        vm.refresh()
    }

    // Light background polling while the app is open. Deliberately slow: the
    // interesting changes here happen on the scale of minutes, and a tight loop
    // would cost battery for nothing.
    LaunchedEffect(ready) {
        while (ready) {
            delay(20_000)
            // Not while reading a detail screen: a refresh underneath a pushed
            // view re-sorts the list it came from and can move what is on screen.
            if (push == null) vm.refresh()
        }
    }

    val chat = openChat
    when {
        // A chat is a destination inside the shell like any other, not a screen
        // that returns before the layout is built. It brings its own header and
        // composer because the top bar and bottom nav are chrome that steals
        // vertical space from the one view where every line counts — but its
        // insets still come from SimbaShell, which is why the header now clears
        // the status bar and the composer clears the keyboard.
        chat != null && ready -> ChatScreen(
            vm, chat.first, chat.second,
            onBack = { openChat = null; vm.refresh() },
            // Re-point the screen at the session the work actually moved to.
            // state is keyed on sessionId, so this reloads history for the
            // continuation rather than leaving the thread watching a dead id.
            onMoved = { moved -> openChat = moved to chat.second },
        )

        // The shell *is* the design. Navigation model, chrome and motion all
        // come from whichever one is active. Previously a NavigationBar was
        // hard-coded here, which guaranteed all three designs were the same app
        // in different colours no matter what the theme did.
        else -> DesignShell(
            design = LocalDesign.current,
            current = dest,
            onNavigate = { dest = it; push = null; openChat = null },
            status = ShellStatus(
                connected = vm.error == null && vm.stats != null,
                activeSessions = vm.stats?.activeSessions ?: 0,
                runningMissions = vm.missions.count { it.status == "running" },
                brainsAvailable = vm.stats?.brainsAvailable ?: 0,
                spend7d = vm.stats?.totalCost ?: 0.0,
                error = vm.error,
            ),
        ) { shown ->
            val here = push
            when {
                !ready -> LoadingState()

                // Pushed screens win over the tab. They are reached from a row,
                // they have a back affordance of their own, and the tab bar stays
                // put underneath — which is what makes tapping a tab a way out.
                here != null -> when (here) {
                    is Push.MissionDetail ->
                        MissionDetailScreen(vm, here.id) { push = null }

                    is Push.SessionDetail -> SessionScreen(
                        vm, here.id, here.title,
                        onBack = { push = null },
                        onOpenChat = { openChat = here.id to here.title },
                        onOpenDiff = { push = Push.SessionDiff(here.id) },
                    )

                    is Push.SessionDiff ->
                        DiffScreen(vm, here.id) { push = Push.SessionDetail(here.id, "") }

                    Push.Agents -> AgentsScreen(vm) { sid, title -> openChat = sid to title }
                    Push.Knowledge -> KnowledgeScreen(vm)
                }

                // `shown`, not `dest`: during a Fluid transition the outgoing
                // half is asked to draw the destination being left.
                else -> when (shown) {
                    Destination.Now -> NowScreen(
                        vm,
                        onOpenMission = { push = Push.MissionDetail(it) },
                        onOpenSession = { id, title -> push = Push.SessionDetail(id, title) },
                        onOpenSystem = { dest = Destination.System },
                    )
                    Destination.Chat -> ChatListScreen(vm) { sid, title -> openChat = sid to title }
                    Destination.Missions -> MissionsScreen(vm) { push = Push.MissionDetail(it) }
                    Destination.System -> SystemScreen(
                        vm,
                        onOpenAgents = { push = Push.Agents },
                        onOpenKnowledge = { push = Push.Knowledge },
                    ) { url, token, clientId, clientSecret ->
                        scope.launch {
                            ctx.saveGateway(url, token, clientId, clientSecret)
                            vm.api = ctx.api()
                            vm.refresh()
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun Card(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    // Padding and corner radius both come from the active design rather than
    // being fixed here. This is what makes Console actually fit more on a screen
    // instead of merely being written in a smaller font: every card in the app
    // tightens at once, and no caller has to know which design is on.
    val scale = LocalDensityScale.current
    Column(
        modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(Raised)
            .padding((14 * scale).dp),
        content = content,
    )
}

@Composable
private fun ErrorBanner(error: String?) {
    AnimatedVisibility(error != null) {
        Card(Modifier.screenPad().padding(vertical = space.tight)) {
            Text("Cannot reach Simba", color = Err, fontWeight = FontWeight.SemiBold, style = type.bodySmall)
            Text(
                error.orEmpty().take(160),
                color = Dim,
                style = type.label,
                modifier = Modifier.padding(top = space.hair),
            )
            Text(
                "The PC may be asleep, or the tunnel is down.",
                color = Faint,
                style = type.caption,
                modifier = Modifier.padding(top = space.tight),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Missions
// ---------------------------------------------------------------------------

@Composable
private fun MissionsScreen(vm: SimbaVm, open: (String) -> Unit) {
    var creating by remember { mutableStateOf(false) }
    val design = LocalDesign.current

    // Material puts the primary action in its FAB, which is the component that
    // decides where the eye goes; the other two designs have no FAB, so they
    // put it in the heading. Showing both would be two controls doing one job.
    DisposableEffect(Unit) {
        MaterialActions.newMission = { creating = true }
        onDispose { MaterialActions.newMission = null }
    }

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 24.dp),
    ) {
        item { ErrorBanner(vm.error) }

        // The brief, when there is one worth showing. Sentence case and the
        // type scale rather than three bespoke font sizes; the decision it
        // wants is the only part that gets colour.
        vm.briefs.firstOrNull()?.let { b ->
            item {
                Column(
                    Modifier.fillMaxWidth()
                        .screenPad()
                        .padding(top = space.snug)
                        .clip(RoundedCornerShape(radius.medium))
                        .background(Raised)
                        .padding(space.roomy),
                ) {
                    Text(b.headline, style = type.heading, color = Fg)
                    if (b.body.isNotBlank()) {
                        Text(
                            b.body,
                            style = type.bodySmall,
                            color = Dim,
                            modifier = Modifier.padding(top = space.snug),
                        )
                    }
                    b.needsDecision?.takeIf { it.isNotBlank() }?.let {
                        Text(
                            "NEEDS YOU",
                            style = type.micro,
                            color = Accent,
                            modifier = Modifier.padding(top = space.base),
                        )
                        Text(it, style = type.bodySmall, color = Fg)
                    }
                    b.stuck?.takeIf { it.isNotBlank() }?.let {
                        Text(
                            "STUCK",
                            style = type.micro,
                            color = Warn,
                            modifier = Modifier.padding(top = space.base),
                        )
                        Text(it, style = type.bodySmall, color = Dim)
                    }
                }
            }
        }

        if (design != Design.Material) {
            item {
                SectionHeading("Missions") {
                    Text(
                        "+ new",
                        style = type.label,
                        color = Accent,
                        modifier = Modifier.clickable { creating = true },
                    )
                }
            }
        }

        if (vm.missions.isEmpty() && vm.error == null) {
            item {
                EmptyState(
                    "No missions yet",
                    "A mission is an objective that runs itself across many sessions — it plans, provisions what it needs, works, and verifies.",
                )
            }
        }

        // Grouped by what you would do about it, not by created_at.
        //
        // A flat list sorted by recency puts a mission that has been blocked
        // since 2am below three that finished cleanly, which is exactly backwards:
        // the finished ones need nothing and the blocked one is the reason you
        // opened the app. Sections that are empty do not appear at all, so the
        // common case — everything running — is three rows and no chrome.
        val groups = listOf(
            Triage("Needs you", Tone.Warn) { it.status == "blocked" || it.blockedReason != null },
            Triage("Running", Tone.Good) { it.status == "running" },
            Triage("Scheduled", Tone.Neutral) { it.cron != null && it.status !in RUNNING_STATES },
            Triage("Planning", Tone.Neutral) { it.status == "planning" },
            Triage("Finished", Tone.Neutral) { it.status in setOf("completed", "cancelled", "failed") },
        )

        val seen = mutableSetOf<String>()
        groups.forEach { g ->
            val rows = vm.missions.filter { it.id !in seen && g.match(it) }
            if (rows.isEmpty()) return@forEach
            rows.forEach { seen += it.id }
            item {
                SectionHeading(g.label) {
                    Text("${rows.size}", style = type.caption, color = g.tone.color())
                }
            }
            items(rows, key = { it.id }) { m -> MissionCard(m) { open(m.id) } }
        }

        // Anything the groups did not claim. Without this a status nobody
        // anticipated would silently vanish from the screen, which is the worst
        // possible failure mode for a list of things that run unattended.
        val rest = vm.missions.filter { it.id !in seen }
        if (rest.isNotEmpty()) {
            item { SectionHeading("Other") }
            items(rest, key = { it.id }) { m -> MissionCard(m) { open(m.id) } }
        }
    }

    if (creating) {
        NewMissionDialog(
            onDismiss = { creating = false },
            onCreate = { title, objective, criteria, schedule ->
                creating = false
                vm.viewModelScope.launch {
                    runCatching { vm.api?.createMission(title, objective, criteria, schedule) }
                        .onFailure { vm.error = it.message }
                    vm.refresh()
                }
            },
        )
    }
}

/**
 * Starting a mission from the phone.
 *
 * The gateway has had a create route the whole time and nothing called it, so
 * missions — the thing the system is built around — could only be started from
 * the desktop. The three fields are the three the planner actually needs: what
 * to call it, what it is for, and how anyone will know it worked. Acceptance is
 * optional but asked for anyway, because a mission with no end condition is how
 * one runs all night and finishes nothing.
 */
@Composable
private fun NewMissionDialog(onDismiss: () -> Unit, onCreate: (String, String, String?, String?) -> Unit) {
    var title by remember { mutableStateOf("") }
    var objective by remember { mutableStateOf("") }
    var criteria by remember { mutableStateOf("") }
    var repeats by remember { mutableStateOf(false) }
    var schedule by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Panel,
        title = { Text("New mission", color = Fg) },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(space.snug),
            ) {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text("Title", style = type.label) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = objective,
                    onValueChange = { objective = it },
                    label = { Text("What should it achieve?", style = type.label) },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 3,
                    maxLines = 6,
                )
                OutlinedTextField(
                    value = criteria,
                    onValueChange = { criteria = it },
                    label = { Text("Done when… (optional)", style = type.label) },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 3,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = repeats, onCheckedChange = { repeats = it })
                    Text("Run on a schedule", color = Dim, style = type.label)
                }
                // Plain English, because nobody states a recurring objective in
                // cron and requiring it is what stops the feature being used.
                // An unparseable phrase is refused by the gateway rather than
                // defaulted, so a mission never runs at an hour nobody chose.
                if (repeats) {
                    OutlinedTextField(
                        value = schedule,
                        onValueChange = { schedule = it },
                        label = { Text("When?", style = type.label) },
                        placeholder = { Text("every morning", style = type.label, color = Faint) },
                        singleLine = true,
                        supportingText = {
                            Text("“every morning”, “weekdays at 9”, “every 30 minutes”", style = type.micro)
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    onCreate(
                        title.trim(),
                        objective.trim(),
                        criteria.trim().ifBlank { null },
                        schedule.trim().takeIf { repeats && it.isNotBlank() },
                    )
                },
                enabled = title.isNotBlank() && objective.isNotBlank() &&
                    (!repeats || schedule.isNotBlank()),
            ) { Text("Start", color = Accent, fontWeight = FontWeight.Bold) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = Dim) } },
    )
}

/** One triage bucket: a heading, a tone, and what belongs in it. */
private class Triage(
    val label: String,
    val tone: Tone,
    val match: (Mission) -> Boolean,
)

private val RUNNING_STATES = setOf("running", "planning", "blocked")

@Composable
private fun MissionCard(m: Mission, onClick: () -> Unit) {
    // Describes what the row *is*; the active design decides how it looks.
    // A script mission has no steps and no cost, so its progress is its last
    // exit code — showing "0/0 steps" for one would be reporting a number that
    // does not apply rather than the one that does.
    val meta = buildList {
        if (m.isScript) {
            m.lastExitCode?.let {
                add(ItemMeta(if (it == 0) "exit 0" else "exit $it", if (it == 0) Tone.Good else Tone.Bad))
            }
            // The phrase, not the cron. "0 7 * * *" is a correct answer to a
            // question nobody asked, and on a phone row it reads as line noise.
            (m.scheduleNote ?: m.cron)?.let { add(ItemMeta(it, Tone.Neutral)) }
        } else {
            add(ItemMeta("${m.doneSteps}/${m.totalSteps} steps"))
            if (m.failedSteps > 0) add(ItemMeta("${m.failedSteps} failed", Tone.Warn))
            add(ItemMeta("${m.sessionsUsed}/${m.maxSessions} sessions"))
            if (m.costUsed > 0) add(ItemMeta("$" + "%.2f".format(m.costUsed)))
        }
    }

    ItemRow(
        title = m.title,
        subtitle = m.currentStep ?: m.blockedReason ?: m.lastOutput?.take(120),
        meta = meta,
        badge = ItemMeta(if (m.isScript) "script" else m.status, toneFor(m.status)),
        onClick = onClick,
    )
}

/** Status words mapped to meaning once, rather than to a colour in each design. */
fun toneFor(status: String): Tone = when (status) {
    "running", "planning", "verifying" -> Tone.Accented
    "completed", "succeeded", "available" -> Tone.Good
    "blocked", "paused", "limited" -> Tone.Warn
    "failed", "error", "killed", "logged_out" -> Tone.Bad
    else -> Tone.Neutral
}

/** Token counts, short enough for a phone row. 9349 reads as 9.3k. */
fun tokens(n: Long): String = when {
    n >= 1_000_000 -> "%.1fM".format(n / 1_000_000.0)
    n >= 1_000 -> "%.1fk".format(n / 1_000.0)
    else -> n.toString()
}

@Composable
fun Meta(text: String, color: Color = Faint) {
    Text(text, style = type.caption, color = color)
}

/**
 * Loads a mission and hands it to [MissionScreen].
 *
 * Only the fetching lives here; everything about how a mission is presented
 * moved to Mission.kt, where it can be rendered and looked at without a gateway.
 */
@Composable
private fun MissionDetailScreen(vm: SimbaVm, id: String, back: () -> Unit) {
    var detail by remember(id) { mutableStateOf<MissionDetail?>(null) }
    var busy by remember(id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun load() { detail = runCatching { vm.api?.mission(id) }.getOrNull() }
    LaunchedEffect(id) { load() }
    // A running mission changes underneath you; a finished one does not, so the
    // poll stops once there is nothing left to watch.
    LaunchedEffect(id, detail?.mission?.status) {
        while (detail?.mission?.status in setOf("running", "planning", null)) {
            delay(15_000)
            load()
        }
    }

    val d = detail
    if (d == null) {
        LoadingState(3)
        return
    }

    MissionScreen(
        detail = d,
        busy = busy,
        onBack = back,
        onAction = { action ->
            scope.launch {
                busy = true
                runCatching { vm.api?.missionAction(id, action) }
                    .onFailure { vm.error = it.message }
                load()
                busy = false
                vm.refresh()
            }
        },
        onRaiseBudget = {
            scope.launch {
                busy = true
                runCatching {
                    vm.api?.missionBudget(id, d.mission.maxSessions + 10, d.mission.maxCost + 10.0)
                }.onFailure { vm.error = it.message }
                load()
                busy = false
            }
        },
    )
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

@Composable
private fun AgentsScreen(vm: SimbaVm, openChat: (String, String) -> Unit) {
    var prompting by remember { mutableStateOf<Agent?>(null) }

    // Tier 0 is the brain and tier 1 are the workers, which is the single most
    // important thing about an agent and was previously a chip reading "tier 0"
    // among four other chips. Splitting the list says it without a label.
    val brain = vm.agents.filter { it.tier == 0 }
    val workers = vm.agents.filter { it.tier != 0 }.sortedBy { it.tier }

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 24.dp),
    ) {
        item { ErrorBanner(vm.error) }
        if (vm.agents.isEmpty() && vm.error == null) {
            item { EmptyState("No agents yet", "Agents are created from the desktop or by Simba itself.") }
        }

        if (brain.isNotEmpty()) {
            item {
                SectionHeading("The brain") {
                    Text("tier 0", style = type.micro, color = Accent)
                }
            }
            items(brain, key = { it.id }) { AgentRow(it) { prompting = it } }
        }

        if (workers.isNotEmpty()) {
            item {
                SectionHeading("Workers") {
                    val live = workers.sumOf { it.activeSessions }
                    Text(
                        if (live > 0) "$live running" else "${workers.size} idle",
                        style = type.caption,
                        color = if (live > 0) Ok else Faint,
                    )
                }
            }
            items(workers, key = { it.id }) { AgentRow(it) { prompting = it } }
        }
    }

    prompting?.let { agent ->
        PromptDialog(
            title = "Start ${agent.name}",
            label = "What should it do?",
            onDismiss = { prompting = null },
            onConfirm = { text ->
                prompting = null
                vm.viewModelScope.launch {
                    // Drops straight into the conversation. Starting an agent
                    // and being returned to a list is the behaviour that made
                    // this feel like a dashboard rather than a control centre.
                    val r = runCatching { vm.api?.startAgent(agent.slug, text) }.getOrNull()
                    vm.refresh()
                    r?.sessionId?.let { openChat(it, agent.name) }
                        ?: r?.error?.let { vm.error = it }
                }
            },
        )
    }
}

/**
 * Conversation list. Live sessions first — those are the ones that can be
 * steered right now; the rest are history you can still pick back up, because
 * messaging a dead session transparently revives it.
 */
@Composable
private fun ChatListScreen(vm: SimbaVm, open: (String, String) -> Unit) {
    var starting by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val simba = vm.agents.firstOrNull { it.tier == 0 } ?: vm.agents.firstOrNull()

    val live = vm.sessions.filter { it.status in listOf("running", "idle") }
    // Grouped by day rather than one flat run of thirty. A conversation from
    // this morning and one from last week were rendering identically, so the
    // only way to tell them apart was to open them.
    val past = vm.sessions
        .filter { it.status !in listOf("running", "idle") }
        .take(40)
        .groupBy { dayLabel(it.lastActivityAt ?: it.createdAt) }

    fun start() {
        if (starting || simba == null) return
        starting = true
        scope.launch {
            val r = runCatching {
                vm.api?.startAgent(simba.slug, "Hey — what's going on with the system right now?")
            }.getOrNull()
            starting = false
            vm.refresh()
            r?.sessionId?.let { open(it, simba.name) } ?: run { vm.error = r?.error }
        }
    }

    // Same rule as missions: Material's FAB is the primary action, so the
    // inline button would be the second control for the same job.
    DisposableEffect(simba) {
        MaterialActions.newChat = { start() }
        onDispose { MaterialActions.newChat = null }
    }

    // Read outside the list builder: the lambda passed to LazyColumn is not
    // composable, so a CompositionLocal cannot be looked up inside it.
    val design = LocalDesign.current

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 24.dp),
    ) {
        if (design != Design.Material) {
            item {
                Button(
                    onClick = { start() },
                    enabled = !starting,
                    modifier = Modifier.fillMaxWidth().screenPad().padding(top = space.tight),
                    colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = OnAccent),
                ) {
                    Text(
                        if (starting) "Starting…" else "Talk to ${simba?.name ?: "Simba"}",
                        style = type.label,
                    )
                }
            }
        }

        item { ErrorBanner(vm.error) }

        if (live.isNotEmpty()) {
            item {
                SectionHeading("Live") {
                    Text("${live.size}", style = type.caption, color = Ok)
                }
            }
            items(live, key = { it.id }) { s -> SessionRowCard(s) { open(s.id, s.title ?: s.agent) } }
        }

        past.forEach { (day, rows) ->
            item { SectionHeading(day) }
            items(rows, key = { it.id }) { s -> SessionRowCard(s) { open(s.id, s.title ?: s.agent) } }
        }

        if (vm.sessions.isEmpty() && vm.error == null) {
            item {
                EmptyState(
                    "No conversations yet",
                    "Start one above, or launch an agent from Agents and it will open here.",
                )
            }
        }
    }
}

@Composable
private fun SessionRowCard(s: SessionRow, onClick: () -> Unit) {
    val quiet = if (s.status in setOf("running", "idle")) {
        s.lastActivityAt?.let { minutesSince(it) } ?: 0
    } else {
        0
    }
    ItemRow(
        title = s.title ?: s.agent,
        // The failure reason, when there is one, is the most useful thing the
        // row can say - a bare "failed" reads as a defect in Simba rather than
        // something that happened to a process.
        subtitle = s.error,
        meta = buildList {
            add(ItemMeta(s.agent))
            s.brain?.let { add(ItemMeta(it)) }
            if (s.swapCount > 0) add(ItemMeta("swapped ${s.swapCount}x", Tone.Accented))
            if (s.outputTokens > 0) add(ItemMeta("${tokens(s.outputTokens)} out"))
            if (s.cost > 0) add(ItemMeta("$" + "%.2f".format(s.cost)))
        },
        // Silence on a live session is the finding, and it is said here the same
        // way Now says it — a badge that reads differently in two places for the
        // same fact is how an interface stops being trusted.
        badge = when {
            quiet >= 30 -> ItemMeta("quiet ${quiet}m", Tone.Warn)
            else -> ItemMeta(s.status, toneFor(s.status))
        },
        onClick = onClick,
    )
}

/**
 * Which day something happened, as a person would name it.
 *
 * Today and Yesterday by name because those are the two that matter, and a date
 * for everything else — "3 days ago" makes you do arithmetic to work out which
 * day, and nobody wants to do arithmetic while looking for a conversation.
 */
private fun dayLabel(iso: String?): String {
    if (iso.isNullOrBlank()) return "Earlier"
    return runCatching {
        val zone = java.time.ZoneId.systemDefault()
        val day = java.time.Instant.parse(iso).atZone(zone).toLocalDate()
        val today = java.time.LocalDate.now(zone)
        when (day) {
            today -> "Today"
            today.minusDays(1) -> "Yesterday"
            else -> day.format(java.time.format.DateTimeFormatter.ofPattern("d MMM"))
        }
    }.getOrDefault("Earlier")
}

/**
 * One agent.
 *
 * The model tier is the only configuration on an agent that changes what it
 * costs and how well it works, so it is stated plainly rather than as a chip
 * among chips. Total spend is deliberately absent from the row: it is a
 * lifetime number, it never goes down, and a large one says nothing about
 * whether the agent is behaving now.
 */
@Composable
private fun AgentRow(a: Agent, onStart: () -> Unit) {
    ItemRow(
        title = a.name,
        subtitle = a.description,
        meta = buildList {
            add(ItemMeta(a.modelTier))
            a.domain?.takeIf { it.isNotBlank() }?.let { add(ItemMeta(it)) }
            if (a.activeSessions > 0) add(ItemMeta("${a.activeSessions} live", Tone.Accented))
        },
        badge = ItemMeta(a.status, toneFor(a.status)),
        // Tapping the row starts it. A separate button inside a row is a third
        // tap target competing with the row and the design's own expansion, and
        // every design would have to place it differently.
        onClick = onStart,
    )
}

@Composable
fun PromptDialog(
    title: String,
    label: String,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Panel,
        title = { Text(title, color = Fg, style = type.heading) },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                label = { Text(label, style = type.label) },
                modifier = Modifier.fillMaxWidth(),
                minLines = 3,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Accent,
                    unfocusedBorderColor = Line,
                    focusedTextColor = Fg,
                    unfocusedTextColor = Fg,
                ),
            )
        },
        confirmButton = {
            TextButton(onClick = { if (text.isNotBlank()) onConfirm(text) }) {
                Text("Go", color = Accent, fontWeight = FontWeight.SemiBold)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = Dim) } },
    )
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

@Composable
fun MemoryScreen(vm: SimbaVm) {
    var q by remember { mutableStateOf("") }
    var hits by remember { mutableStateOf<List<MemoryHit>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    var searched by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun go() {
        if (q.isBlank()) return
        scope.launch {
            searching = true
            hits = runCatching { vm.api?.search(q) ?: emptyList() }.getOrDefault(emptyList())
            searching = false; searched = true
        }
    }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.screenPad().padding(top = space.snug), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = q,
                onValueChange = { q = it },
                placeholder = { Text("Ask your own history…", style = type.bodySmall, color = Faint) },
                modifier = Modifier.weight(1f),
                singleLine = true,
                // Without declaring the action, the IME shows a newline key and
                // the onSearch handler below is never reached — the field looked
                // wired and did nothing when you pressed return.
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { go() }),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Accent,
                    unfocusedBorderColor = Line,
                    focusedTextColor = Fg,
                    unfocusedTextColor = Fg,
                ),
            )
            Spacer(Modifier.width(8.dp))
            ActionIcon(Icons.Filled.Search, glyph = "[go]", label = "Search", tint = Accent) { go() }
        }

        vm.stats?.let {
            Text(
                "${it.embeddings} chunks indexed",
                style = type.caption,
                color = Faint,
                modifier = Modifier.screenPad().padding(top = space.tight),
            )
        }

        Spacer(Modifier.height(6.dp))
        when {
            searching -> LoadingState(3)
            // Before the first search there is nothing to say the screen works;
            // an empty column reads exactly like a failed load.
            !searched -> EmptyState(
                "Search everything Simba has read",
                "Conversations, the vault, and the knowledge base — asked in your own words.",
            )
            hits.isEmpty() -> EmptyState(
                "No matches",
                "Nothing in the indexed history is close enough to that.",
            )
            else -> LazyColumn {
                items(hits) { h ->
                    ItemRow(
                        title = h.title ?: "untitled",
                        // The excerpt is the answer, so it is not hidden behind
                        // an expansion — but 400 characters of it is a wall, and
                        // the full text is one tap away.
                        subtitle = h.content.take(180),
                        meta = buildList { h.source?.let { add(ItemMeta(it)) } },
                        badge = ItemMeta(
                            "${(h.relevance * 100).toInt()}%",
                            if (h.relevance > 0.6f) Tone.Good else Tone.Neutral,
                        ),
                        expanded = { Text(h.content, style = type.label, color = Dim, lineHeight = 17.sp) },
                    )
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// System: brains, settings, panic
// ---------------------------------------------------------------------------

@Composable
private fun SystemScreen(
    vm: SimbaVm,
    onOpenAgents: () -> Unit = {},
    onOpenKnowledge: () -> Unit = {},
    save: (String, String, String, String) -> Unit,
) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var url by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var clientId by remember { mutableStateOf("") }
    var clientSecret by remember { mutableStateOf("") }
    var confirmPanic by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    // Live verification results, keyed by brain. Held in the composable rather
    // than the view model because they are a snapshot of one moment, not state
    // the rest of the app should treat as current.
    var verdicts by remember { mutableStateOf<Map<String, VerifyResult>>(emptyMap()) }
    var verifying by remember { mutableStateOf<String?>(null) }
    var verifyingAll by remember { mutableStateOf(false) }
    var worktrees by remember { mutableStateOf<List<HeldWorktree>>(emptyList()) }
    var budget by remember { mutableStateOf<ContextBudget?>(null) }
    var stores by remember { mutableStateOf<StorePressure?>(null) }
    var curating by remember { mutableStateOf(false) }
    var events by remember { mutableStateOf<List<SystemEvent>>(emptyList()) }
    var allEvents by remember { mutableStateOf(false) }
    var memory by remember { mutableStateOf<List<MemorySample>>(emptyList()) }
    var spend by remember { mutableStateOf<List<UsageDay>>(emptyList()) }
    var surfaces by remember { mutableStateOf<List<Surface>>(emptyList()) }

    LaunchedEffect(Unit) {
        // Failing quietly is right here: an older gateway has no /api/worktrees,
        // and the whole screen should not break because one section is missing.
        runCatching { vm.api?.worktrees() ?: emptyList() }.onSuccess { worktrees = it }
        // Both fail quietly: an older gateway lacks these routes, and one
        // missing section should not blank the whole screen.
        runCatching { vm.api?.contextBudget("simba") }.onSuccess { budget = it }
        runCatching { vm.api?.storePressure() }.onSuccess { stores = it }
        runCatching { vm.api?.events() ?: emptyList() }.onSuccess { events = it }
        runCatching { vm.api?.memory(hours = 24) ?: emptyList() }.onSuccess { memory = it }
        runCatching { vm.api?.usageTimeline() ?: emptyList() }.onSuccess { spend = it }
        runCatching { vm.api?.surfaces() ?: emptyList() }.onSuccess { surfaces = it }
    }

    LaunchedEffect(Unit) {
        url = ctx.gatewayUrl()
        token = ctx.gatewayToken()
        clientId = ctx.accessClientId()
        clientSecret = ctx.accessClientSecret()
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        if (memory.isNotEmpty()) {
            SectionHeading("Machine") {
                Meta("${memory.last().totalMb / 1024}GB total", Faint)
            }
            MemoryChart(memory)
        }

        if (spend.isNotEmpty()) {
            SectionHeading("Spend") {
                Meta("$" + "%.2f".format(spend.sumOf { it.cost }) + " over 14 days", Faint)
            }
            SpendChart(spend)
        }

        if (surfaces.isNotEmpty()) {
            SectionHeading("Where requests come from")
            surfaces.forEach { sf ->
                ItemRow(
                    title = sf.name,
                    // Trust level is the security model made visible, and the
                    // phone is deliberately a lower-trust surface than the
                    // desktop — worth being able to see from the phone.
                    subtitle = "trust ${sf.trustLevel} · caps model tier at ${sf.maxModelTier ?: "any"}",
                    badge = when {
                        !sf.enabled -> ItemMeta("disabled", Tone.Neutral)
                        sf.awaitingConfirmation > 0 -> ItemMeta("${sf.awaitingConfirmation} waiting", Tone.Warn)
                        sf.activeSessions > 0 -> ItemMeta("${sf.activeSessions} live", Tone.Good)
                        else -> null
                    },
                    meta = listOf(ItemMeta("${sf.totalSessions} sessions")),
                )
            }
        }

        // Agents and Knowledge stopped being tabs because neither is a task —
        // one is a directory that changes monthly, the other is occasional
        // curation. They are still one tap away, and stating what is inside
        // them is what stops "System" becoming the drawer everything fell into.
        SectionHeading("Manage")
        ItemRow(
            title = "Agents",
            subtitle = "Who can run, what tier they think at, and what they have cost",
            meta = buildList {
                add(ItemMeta("${vm.agents.size}"))
                val live = vm.agents.sumOf { it.activeSessions }
                if (live > 0) add(ItemMeta("$live live", Tone.Good))
            },
            onClick = onOpenAgents,
        )
        ItemRow(
            title = "Knowledge",
            subtitle = "Skills it wrote for itself, what it remembers, and what it has decided",
            onClick = onOpenKnowledge,
        )

        SectionHeading("Design") { Meta(BuildConfig.BUILD_STAMP, Accent) }

        // The picker is the one place the three designs are described rather
        // than merely used, so each is named with its own argument beside it —
        // choosing between three words tells you nothing.
        val design = LocalDesign.current
        Design.entries.forEach { d ->
            ItemRow(
                title = d.label,
                subtitle = d.blurb,
                badge = if (d == design) ItemMeta("in use", Tone.Accented) else null,
                onClick = { scope.launch { ctx.saveDesign(d) } },
            )
        }

        // The ladder, in the order failover actually walks it — the sequence is
        // the point, not the set. Each row can be asked whether it really works
        // and benched without touching the machine.
        SectionHeading("Brains") {
            if (verifyingAll) Text("checking…", style = type.caption, color = Accent)
            else Text(
                "verify all",
                style = type.caption,
                color = Accent,
                modifier = Modifier.clickable {
                    scope.launch {
                        verifyingAll = true
                        // Sequential, not parallel: each one spawns a CLI that
                        // wants CPU and RAM, and firing six at once on a machine
                        // already running Postgres and agents is how the box
                        // starts swapping.
                        vm.brains.forEach { b ->
                            runCatching { vm.api?.verifyBrain(b.slug) }
                                .onSuccess { r -> if (r != null) verdicts = verdicts + (b.slug to r) }
                        }
                        verifyingAll = false
                        vm.refresh()
                    }
                },
            )
        }
        if (vm.brains.isEmpty()) {
            EmptyState("No brains configured", "Simba has nothing to think with until a CLI is registered on the machine.")
        }
        vm.brains.forEachIndexed { i, b ->
            val verdict = verdicts[b.slug]
            ItemRow(
                // The number is the failover position, which is the only thing
                // that distinguishes an ordered ladder from a list of brains.
                title = "${i + 1}. ${b.label}",
                // A brain showing "logged_out" with no explanation reads as a
                // bug in Simba rather than a state of the account. The reason
                // is already recorded server-side, so show it.
                subtitle = b.lastError?.takeIf { it.isNotBlank() },
                badge = ItemMeta(
                    if (!b.enabled) "benched" else b.status,
                    if (!b.enabled) Tone.Neutral else toneFor(b.status),
                ),
                meta = buildList {
                    add(ItemMeta(b.provider))
                    // Free brains cost nothing by construction; showing $0.00
                    // next to them implies a meter that does not exist.
                    if (b.provider == "opencode" || b.cli == "ollama") add(ItemMeta("free", Tone.Good))
                    else add(ItemMeta("7d $${"%.2f".format(b.cost7d ?: 0.0)}"))
                    b.limitResetsAt?.let { add(ItemMeta("resets $it", Tone.Warn)) }
                },
                expanded = {
                    Column {
                        // Rolling 5-hour usage. On a subscription-only setup
                        // headroom is the scarce resource, and this window is
                        // what actually predicts a brain going unavailable — a
                        // cost figure does not, because the limit is not
                        // denominated in dollars.
                        if (b.input5h > 0 || b.output5h > 0) {
                            Text(
                                "5h · ${tokens(b.input5h)} in / ${tokens(b.output5h)} out" +
                                    if (b.provider == "opencode" || b.cli == "ollama") " · at no cost" else "",
                                style = type.caption,
                                color = if (b.provider == "opencode" || b.cli == "ollama") Ok else Faint,
                            )
                            Spacer(Modifier.height(8.dp))
                        }
                        // The live answer, kept visually distinct from the
                        // stored status so it is obvious which was just measured.
                        verdict?.let { v ->
                            Text(
                                v.detail,
                                style = type.caption,
                                color = if (v.ok) Ok else Err,
                            )
                            Spacer(Modifier.height(8.dp))
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(space.gutter)) {
                            val busy = verifying == b.slug
                            Text(
                                if (busy) "asking…" else "verify",
                                style = type.label,
                                color = if (busy) Faint else Accent,
                                modifier = Modifier.clickable(enabled = !busy) {
                                    scope.launch {
                                        verifying = b.slug
                                        runCatching { vm.api?.verifyBrain(b.slug) }
                                            .onSuccess { r -> if (r != null) verdicts = verdicts + (b.slug to r) }
                                            .onFailure { e ->
                                                verdicts = verdicts + (b.slug to VerifyResult(
                                                    slug = b.slug, ok = false,
                                                    detail = e.message ?: "request failed",
                                                ))
                                            }
                                        verifying = null
                                        vm.refresh()
                                    }
                                },
                            )
                            Text(
                                if (b.enabled) "bench" else "restore",
                                style = type.label,
                                color = if (b.enabled) Warn else Ok,
                                modifier = Modifier.clickable {
                                    scope.launch {
                                        runCatching { vm.api?.toggleBrain(b.slug) }
                                        vm.refresh()
                                    }
                                },
                            )
                        }
                    }
                },
            )
        }

        // Work an agent produced that nothing has collected.
        //
        // A worktree is kept rather than deleted whenever it still holds
        // changes, which is right — destroying unattended work is not
        // recoverable. But kept-and-invisible is its own failure: the session
        // reads "completed" while a directory somewhere holds the only copy.
        if (worktrees.isNotEmpty()) {
            SectionHeading("Uncollected work") {
                Text("${worktrees.size} held", style = type.caption, color = Warn)
            }
            worktrees.forEach { w ->
                ItemRow(
                    title = w.agent,
                    subtitle = w.state.branch,
                    badge = ItemMeta(
                        when {
                            // Not recoverable, so not a call to action.
                            w.state.originMissing -> "repo gone"
                            w.state.dirty -> "uncommitted"
                            else -> "${w.state.ahead} commits"
                        },
                        if (w.state.originMissing) Tone.Neutral else Tone.Warn,
                    ),
                    expanded = { Text(w.state.path, color = Faint, style = type.caption) },
                )
            }
        }


        // What every turn pays for, and what it is spent on.
        //
        // The brief grew all night and nothing measured the total until it was
        // asked. Memory turned out to be the largest single consumer, which was
        // not the guess - so this is here to be looked at rather than assumed.
        budget?.let { b ->
            SectionHeading("Context per turn") {
                Meta("~${tokens(b.estTokens.toLong())} tokens")
            }
            Card(Modifier.padding(horizontal = space.gutter)) {
                b.slices.forEach { sl ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = space.hair),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "${sl.pct}%",
                            style = type.caption,
                            color = if (sl.pct >= 30) Warn else Faint,
                            modifier = Modifier.width(34.dp),
                        )
                        Box(
                            Modifier.width((sl.pct.coerceAtMost(60) * 1.6).dp).height(6.dp)
                                .clip(RoundedCornerShape(3.dp))
                                .background(if (sl.pct >= 30) Warn else Accent),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(sl.category, color = Fg, style = type.caption)
                    }
                    sl.note?.let {
                        Text(it, color = Faint, style = type.micro, modifier = Modifier.padding(start = space.section, bottom = space.hair))
                    }
                }
            }
        }

        // The stores that load every turn, and the button that tidies them.
        stores?.let { st ->
            SectionHeading("Stores") {
                Text(
                    if (curating) "tidying…" else "curate now",
                    style = type.caption,
                    color = Accent,
                    modifier = Modifier.clickable(enabled = !curating) {
                        scope.launch {
                            curating = true
                            runCatching { vm.api?.runCuration() }
                            runCatching { vm.api?.storePressure() }.onSuccess { stores = it }
                            curating = false
                        }
                    },
                )
            }
            Card(Modifier.padding(horizontal = space.gutter)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("memory", color = Fg, style = type.label)
                    Meta(
                        "${st.memory.used}/${st.memory.cap}",
                        if (st.memory.pct > 75) Warn else Faint,
                    )
                }
                Row(
                    Modifier.fillMaxWidth().padding(top = space.tight),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("skills", color = Fg, style = type.label)
                    Row(horizontalArrangement = Arrangement.spacedBy(space.snug)) {
                        Meta("${st.skills.enabled} live")
                        // Never-opened skills cost tokens every turn and have
                        // returned nothing, which is the whole argument for
                        // curation being visible rather than silent.
                        if (st.skills.unused > 0) Meta("${st.skills.unused} unused", Warn)
                        if (st.skills.archived > 0) Meta("${st.skills.archived} archived")
                    }
                }
            }
        }

        // What the machine has been doing. Filtered to the events that change
        // what a person would do, with everything else one tap away — an
        // unfiltered feed of two hundred rows is a log, not a screen.
        if (events.isNotEmpty()) {
            SectionHeading("Activity") {
                Text(
                    if (allEvents) "notable only" else "show all",
                    style = type.caption,
                    color = Accent,
                    modifier = Modifier.clickable { allEvents = !allEvents },
                )
            }
            val shown = (if (allEvents) events else events.filter { it.notable }).take(30)
            if (shown.isEmpty()) {
                EmptyState("Nothing notable", "No missions finished, blocked, or learned anything recently.")
            }
            shown.forEach { e ->
                ItemRow(
                    title = e.label,
                    subtitle = e.message,
                    badge = when (e.severity) {
                        "error" -> ItemMeta("error", Tone.Bad)
                        "warn" -> ItemMeta("warn", Tone.Warn)
                        else -> null
                    },
                    meta = buildList {
                        add(ItemMeta(e.ts.take(16).replace('T', ' ')))
                        e.agent?.let { add(ItemMeta(it)) }
                        e.brain?.let { add(ItemMeta(it, Tone.Accented)) }
                    },
                )
            }
        }

        SectionHeading("Connection")
        Card(Modifier.padding(horizontal = space.gutter)) {
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                label = { Text("Gateway URL", style = type.label) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Accent, unfocusedBorderColor = Line,
                    focusedTextColor = Fg, unfocusedTextColor = Fg,
                ),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = token,
                onValueChange = { token = it },
                label = { Text("Token (optional)", style = type.label) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Accent, unfocusedBorderColor = Line,
                    focusedTextColor = Fg, unfocusedTextColor = Fg,
                ),
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "Cloudflare Access service token — required when reaching Simba over the tunnel.",
                style = type.caption,
                color = Faint,
            )
            Spacer(Modifier.height(6.dp))
            OutlinedTextField(
                value = clientId,
                onValueChange = { clientId = it },
                label = { Text("CF-Access-Client-Id", style = type.label) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Accent, unfocusedBorderColor = Line,
                    focusedTextColor = Fg, unfocusedTextColor = Fg,
                ),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = clientSecret,
                onValueChange = { clientSecret = it },
                label = { Text("CF-Access-Client-Secret", style = type.label) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Accent, unfocusedBorderColor = Line,
                    focusedTextColor = Fg, unfocusedTextColor = Fg,
                ),
            )
            Spacer(Modifier.height(10.dp))
            Button(
                onClick = { save(url, token, clientId, clientSecret) },
                colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = OnAccent),
            ) { Text("Save & reconnect", fontWeight = FontWeight.SemiBold) }
        }

        Spacer(Modifier.height(18.dp))
        Button(
            onClick = { confirmPanic = true },
            colors = ButtonDefaults.buttonColors(containerColor = Err.copy(alpha = 0.15f), contentColor = Err),
            modifier = Modifier.fillMaxWidth().padding(horizontal = space.gutter),
        ) {
            Icon(Icons.Filled.Warning, null, modifier = Modifier.size(17.dp))
            Text("  Panic — stop every agent", fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.height(20.dp))
    }

    if (confirmPanic) {
        AlertDialog(
            onDismissRequest = { confirmPanic = false },
            containerColor = Panel,
            title = { Text("Stop everything?", color = Fg) },
            text = { Text("Kills every running agent session immediately.", color = Dim, style = type.bodySmall) },
            confirmButton = {
                TextButton(onClick = {
                    confirmPanic = false
                    scope.launch { runCatching { vm.api?.panic() }; vm.refresh() }
                }) { Text("Stop all", color = Err, fontWeight = FontWeight.Bold) }
            },
            dismissButton = { TextButton(onClick = { confirmPanic = false }) { Text("Cancel", color = Dim) } },
        )
    }
}


/**
 * Twenty-four hours of machine memory, by process.
 *
 * Stacked rather than a single free-memory line because the useful question is
 * not "how much is left" but "what took it". A night where Claude Desktop grew
 * from 1.5GB to 6GB looks identical to one where twenty small processes did,
 * unless the bands are separated.
 */
@Composable
private fun MemoryChart(samples: List<MemorySample>) {
    val latest = samples.last()
    Column(
        Modifier.fillMaxWidth()
            .padding(horizontal = space.gutter)
            .clip(RoundedCornerShape(radius.medium))
            .background(Raised)
            .padding(space.roomy),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("${latest.freeMb / 1024}GB free", style = type.heading, color = Fg)
            Text("${latest.processCount} processes", style = type.caption, color = Faint)
        }
        PressureBar(latest.pressure, Modifier.padding(top = space.snug))

        StackedArea(
            bands = listOf(
                Band("claude", samples.map { it.claudeDesktopMb + it.claudeCodeMb.toFloat() }, Accent),
                Band("simba", samples.map { it.simbaMb.toFloat() }, Info),
                Band("ollama", samples.map { it.ollamaMb.toFloat() }, Ok),
                Band("postgres", samples.map { it.postgresMb.toFloat() }, Warn),
            ),
            modifier = Modifier.padding(top = space.base),
            total = latest.totalMb.toFloat(),
        )
        Row(
            Modifier.padding(top = space.snug),
            horizontalArrangement = Arrangement.spacedBy(space.base),
        ) {
            listOf("claude" to Accent, "simba" to Info, "ollama" to Ok, "postgres" to Warn)
                .forEach { (label, c) ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(6.dp).clip(RoundedCornerShape(radius.pill)).background(c))
                        Text(label, style = type.micro, color = Faint, modifier = Modifier.padding(start = space.tight))
                    }
                }
        }
    }
}

/**
 * Fourteen days of spend.
 *
 * Bars rather than a line: spend is a discrete daily quantity, and a line
 * between two days implies values in between that do not exist. Today is
 * highlighted because "am I spending more than usual" is the only question this
 * chart is ever asked.
 */
@Composable
private fun SpendChart(days: List<UsageDay>) {
    // The API returns one row per brain per day; the chart is about the total.
    val byDay = days.groupBy { it.day }.toSortedMap()
    val totals = byDay.values.map { rows -> rows.sumOf { it.cost }.toFloat() }
    val free = days.filter { it.cost == 0.0 }.sumOf { it.tokens }

    Column(
        Modifier.fillMaxWidth()
            .padding(horizontal = space.gutter)
            .clip(RoundedCornerShape(radius.medium))
            .background(Raised)
            .padding(space.roomy),
    ) {
        BarSeries(totals, highlight = totals.lastIndex)
        Row(
            Modifier.fillMaxWidth().padding(top = space.snug),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(byDay.keys.firstOrNull().orEmpty(), style = type.micro, color = Faint)
            // Free volume beside paid spend is the point of the failover ladder:
            // a large number here is work that cost nothing.
            if (free > 0) {
                Text("${tokens(free)} tokens at no cost", style = type.micro, color = Ok)
            }
            Text(byDay.keys.lastOrNull().orEmpty(), style = type.micro, color = Faint)
        }
    }
}
