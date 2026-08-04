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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SimbaRoot(vm: SimbaVm = viewModel()) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var dest by remember { mutableStateOf(Destination.Chat) }
    var openMission by remember { mutableStateOf<String?>(null) }
    var openChat by remember { mutableStateOf<Pair<String, String>?>(null) }
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
            if (openMission == null) vm.refresh()
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
            onNavigate = { dest = it; openMission = null; openChat = null },
            status = ShellStatus(
                connected = vm.error == null && vm.stats != null,
                activeSessions = vm.stats?.activeSessions ?: 0,
                runningMissions = vm.missions.count { it.status == "running" },
                brainsAvailable = vm.stats?.brainsAvailable ?: 0,
                spend7d = vm.stats?.totalCost ?: 0.0,
                error = vm.error,
            ),
        ) {
            when {
                !ready -> CenteredNote("Connecting…")
                openMission != null -> MissionDetailScreen(vm, openMission!!) { openMission = null }
                else -> when (dest) {
                    Destination.Chat -> ChatListScreen(vm) { sid, title -> openChat = sid to title }
                    Destination.Missions -> MissionsScreen(vm) { openMission = it }
                    Destination.Agents -> AgentsScreen(vm) { sid, title -> openChat = sid to title }
                    Destination.Knowledge -> KnowledgeScreen(vm)
                    Destination.System -> SystemScreen(vm) { url, token, clientId, clientSecret ->
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

/**
 * Material's own bars pad themselves for the system bars by default. The shell
 * already does that for every destination, so they must be told not to, or the
 * inset is applied twice.
 */
internal val NoInsets = WindowInsets(0, 0, 0, 0)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SimbaTopBar(vm: SimbaVm) {
    TopAppBar(
        windowInsets = NoInsets,
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Panel, titleContentColor = Fg),
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("SIMBA", fontWeight = FontWeight.Bold, color = Accent, fontSize = 17.sp)
                Spacer(Modifier.width(12.dp))
                vm.stats?.let { s ->
                    Text(
                        "${s.activeSessions} active · ${s.brainsAvailable} brains · $${"%.2f".format(s.totalCost)}",
                        fontSize = 11.sp,
                        color = Dim,
                    )
                }
            }
        },
        actions = {
            if (vm.loading) {
                CircularProgressIndicator(
                    Modifier.size(18.dp).padding(end = 4.dp),
                    strokeWidth = 2.dp,
                    color = Accent,
                )
            }
            IconButton(onClick = { vm.refresh() }) {
                Icon(Icons.Filled.Refresh, "Refresh", tint = Dim)
            }
        },
    )
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

@Composable
fun Card(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    // Padding and corner radius both come from the active design rather than
    // being fixed here. This is what makes Dense actually fit more on a screen
    // instead of merely being written in a smaller font: every card in the app
    // tightens at once, and no caller has to know which design is on.
    val scale = LocalDensityScale.current
    Column(
        modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(Panel)
            .padding((14 * scale).dp),
        content = content,
    )
}

@Composable
fun Pill(text: String, color: Color = Dim) {
    Box(
        Modifier
            .clip(RoundedCornerShape(99.dp))
            .background(color.copy(alpha = 0.14f))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        Text(text.uppercase(), fontSize = 9.5.sp, color = color, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
fun CenteredNote(text: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(text, color = Faint, fontSize = 13.sp)
    }
}

@Composable
private fun ErrorBanner(error: String?) {
    AnimatedVisibility(error != null) {
        Card(Modifier.padding(horizontal = 12.dp, vertical = 6.dp)) {
            Text("Cannot reach Simba", color = Err, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
            Text(
                error.orEmpty().take(160),
                color = Dim,
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 3.dp),
            )
            Text(
                "The PC may be asleep, or the tunnel is down.",
                color = Faint,
                fontSize = 11.5.sp,
                modifier = Modifier.padding(top = 4.dp),
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

        vm.briefs.firstOrNull()?.let { b ->
            item {
                Card(Modifier.screenPad()) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.Top,
                    ) {
                        Text(
                            b.headline,
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 14.5.sp,
                            color = Fg,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    if (b.body.isNotBlank()) {
                        Text(b.body, fontSize = 12.5.sp, color = Dim, modifier = Modifier.padding(top = 6.dp))
                    }
                    b.needsDecision?.takeIf { it.isNotBlank() }?.let {
                        Spacer(Modifier.height(8.dp))
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .background(Accent.copy(alpha = 0.12f))
                                .padding(9.dp),
                        ) { Text("Needs you: $it", fontSize = 12.sp, color = Accent) }
                    }
                    b.stuck?.takeIf { it.isNotBlank() }?.let {
                        Text("Stuck: $it", fontSize = 12.sp, color = Warn, modifier = Modifier.padding(top = 6.dp))
                    }
                }
            }
        }

        if (design != Design.Material) {
            item {
                SectionHeading("Missions") {
                    Text(
                        "+ new",
                        fontSize = 12.sp,
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

        items(vm.missions, key = { it.id }) { m -> MissionCard(m) { open(m.id) } }
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
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text("Title", fontSize = 12.sp) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = objective,
                    onValueChange = { objective = it },
                    label = { Text("What should it achieve?", fontSize = 12.sp) },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 3,
                    maxLines = 6,
                )
                OutlinedTextField(
                    value = criteria,
                    onValueChange = { criteria = it },
                    label = { Text("Done when… (optional)", fontSize = 12.sp) },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 3,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = repeats, onCheckedChange = { repeats = it })
                    Text("Run on a schedule", color = Dim, fontSize = 12.5.sp)
                }
                // Plain English, because nobody states a recurring objective in
                // cron and requiring it is what stops the feature being used.
                // An unparseable phrase is refused by the gateway rather than
                // defaulted, so a mission never runs at an hour nobody chose.
                if (repeats) {
                    OutlinedTextField(
                        value = schedule,
                        onValueChange = { schedule = it },
                        label = { Text("When?", fontSize = 12.sp) },
                        placeholder = { Text("every morning", fontSize = 12.sp, color = Faint) },
                        singleLine = true,
                        supportingText = {
                            Text("“every morning”, “weekdays at 9”, “every 30 minutes”", fontSize = 10.5.sp)
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
            m.cron?.let { add(ItemMeta(it, Tone.Neutral)) }
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
    Text(text, fontSize = 11.sp, color = color)
}

@Composable
private fun MissionDetailScreen(vm: SimbaVm, id: String, back: () -> Unit) {
    var detail by remember { mutableStateOf<MissionDetail?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun load() { detail = runCatching { vm.api?.mission(id) }.getOrNull() }
    LaunchedEffect(id) { load() }
    LaunchedEffect(id) { while (true) { delay(15_000); load() } }

    val d = detail
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 24.dp),
    ) {
        item {
            Row(Modifier.screenPad().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                BackButton(back)
                Text("All missions", color = Dim, fontSize = 12.5.sp, modifier = Modifier.padding(start = 4.dp))
            }
        }

        if (d == null) { item { LoadingState(3) }; return@LazyColumn }

        item {
            Card(Modifier.screenPad()) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        d.mission.title,
                        fontWeight = FontWeight.Bold,
                        fontSize = 16.sp,
                        color = Fg,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Pill(d.mission.status, statusColor(d.mission.status))
                }
                Text(
                    d.mission.objective,
                    fontSize = 12.5.sp,
                    color = Dim,
                    modifier = Modifier.padding(top = 7.dp),
                )
                d.mission.acceptanceCriteria?.takeIf { it.isNotBlank() }?.let {
                    Text("Done when: $it", fontSize = 12.sp, color = Faint, modifier = Modifier.padding(top = 6.dp))
                }
                d.mission.blockedReason?.takeIf { it.isNotBlank() }?.let { reason ->
                    Spacer(Modifier.height(8.dp))
                    Box(
                        Modifier.clip(RoundedCornerShape(8.dp)).background(Warn.copy(alpha = 0.12f)).padding(9.dp),
                    ) {
                        Column {
                            Text("Blocked: $reason", fontSize = 12.sp, color = Warn)
                            // A budget block is the one kind of stop the phone
                            // can actually clear, so offer the fix beside the
                            // reason rather than making it a generic action.
                            if (reason.contains("budget", ignoreCase = true) ||
                                reason.contains("exhausted", ignoreCase = true)
                            ) {
                                Text(
                                    "Raise to ${d.mission.maxSessions + 10} sessions / " +
                                        "$${"%.0f".format(d.mission.maxCost + 10)} and continue",
                                    fontSize = 12.sp,
                                    color = Accent,
                                    modifier = Modifier.padding(top = 7.dp).clickable(enabled = !busy) {
                                        scope.launch {
                                            busy = true
                                            runCatching {
                                                vm.api?.missionBudget(
                                                    id,
                                                    d.mission.maxSessions + 10,
                                                    d.mission.maxCost + 10.0,
                                                )
                                            }
                                            load(); busy = false
                                        }
                                    },
                                )
                            }
                        }
                    }
                }

                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("pause" to "Pause", "resume" to "Resume", "retry" to "Retry").forEach { (a, label) ->
                        OutlinedButton(
                            onClick = {
                                scope.launch {
                                    busy = true
                                    runCatching { vm.api?.missionAction(id, a) }
                                    load(); busy = false
                                }
                            },
                            enabled = !busy,
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                        ) { Text(label, fontSize = 12.sp) }
                    }
                }
            }
        }

        item {
            SectionHeading("Plan") {
                Text("${d.steps.size} steps", fontSize = 11.sp, color = Faint)
            }
        }

        items(d.steps) { s -> StepCard(s) }
    }
}

@Composable
private fun StepCard(s: MissionStep) {
    // A step carries three things worth reading — what it was told to do, what
    // it produced, and how it failed — which is more than a subtitle can hold
    // without truncating whichever one mattered. So they go in the expansion,
    // and the row itself stays scannable: number, title, state.
    ItemRow(
        title = "${s.seq}. ${s.title}",
        meta = listOf(ItemMeta(s.kind)),
        badge = ItemMeta(s.status, toneFor(s.status)),
        expanded = {
            Column {
                Text(s.instruction, fontSize = 12.sp, color = Dim, lineHeight = 17.sp)
                s.result?.takeIf { it.isNotBlank() }?.let {
                    Text(it, fontSize = 12.sp, color = Ok, modifier = Modifier.padding(top = 8.dp))
                }
                s.failures?.takeIf { it.isNotBlank() }?.let {
                    Text(it, fontSize = 12.sp, color = Err, modifier = Modifier.padding(top = 8.dp))
                }
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

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 24.dp),
    ) {
        item { ErrorBanner(vm.error) }
        if (vm.agents.isEmpty() && vm.error == null) {
            item { EmptyState("No agents yet", "Agents are created from the desktop or by Simba itself.") }
        }
        items(vm.agents, key = { it.id }) { a ->
            ItemRow(
                title = a.name,
                subtitle = a.description,
                meta = buildList {
                    add(ItemMeta("tier ${a.tier}", if (a.tier == 0) Tone.Accented else Tone.Neutral))
                    add(ItemMeta(a.modelTier))
                    if (a.activeSessions > 0) add(ItemMeta("${a.activeSessions} live", Tone.Accented))
                    if (a.totalCost > 0) add(ItemMeta("$" + "%.2f".format(a.totalCost)))
                },
                badge = ItemMeta(a.status, toneFor(a.status)),
                // Tapping the row starts it. A separate button inside a row is
                // a third tap target competing with the row and the design's own
                // expansion, and every design would have to place it differently.
                onClick = { prompting = a },
            )
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
    val past = vm.sessions.filter { it.status !in listOf("running", "idle") }.take(30)

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
                    modifier = Modifier.fillMaxWidth().screenPad().padding(top = 6.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = OnAccent),
                ) {
                    Text(
                        if (starting) "Starting…" else "Talk to ${simba?.name ?: "Simba"}",
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }

        item { ErrorBanner(vm.error) }

        if (live.isNotEmpty()) {
            item { SectionHeading("Live") }
            items(live, key = { it.id }) { s -> SessionRowCard(s) { open(s.id, s.title ?: s.agent) } }
        }

        if (past.isNotEmpty()) {
            item { SectionHeading("Earlier") }
            items(past, key = { it.id }) { s -> SessionRowCard(s) { open(s.id, s.title ?: s.agent) } }
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
            if (s.cost > 0) add(ItemMeta("$" + "%.3f".format(s.cost)))
        },
        badge = ItemMeta(s.status, toneFor(s.status)),
        onClick = onClick,
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
        title = { Text(title, color = Fg, fontSize = 16.sp) },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                label = { Text(label, fontSize = 12.sp) },
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

    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = q,
                onValueChange = { q = it },
                placeholder = { Text("Ask your own history…", fontSize = 13.sp, color = Faint) },
                modifier = Modifier.weight(1f),
                singleLine = true,
                keyboardActions = KeyboardActions(onSearch = { go() }),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Accent,
                    unfocusedBorderColor = Line,
                    focusedTextColor = Fg,
                    unfocusedTextColor = Fg,
                ),
            )
            Spacer(Modifier.width(8.dp))
            IconButton(onClick = { go() }) { Icon(Icons.Filled.Search, "Search", tint = Accent) }
        }

        vm.stats?.let {
            Text(
                "${it.embeddings} chunks indexed",
                fontSize = 11.sp,
                color = Faint,
                modifier = Modifier.padding(top = 4.dp, start = 4.dp),
            )
        }

        Spacer(Modifier.height(10.dp))
        when {
            searching -> LoadingState(3)
            hits.isEmpty() && searched -> EmptyState(
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
                        expanded = { Text(h.content, fontSize = 12.sp, color = Dim, lineHeight = 17.sp) },
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
private fun SystemScreen(vm: SimbaVm, save: (String, String, String, String) -> Unit) {
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

    LaunchedEffect(Unit) {
        // Failing quietly is right here: an older gateway has no /api/worktrees,
        // and the whole screen should not break because one section is missing.
        runCatching { vm.api?.worktrees() ?: emptyList() }.onSuccess { worktrees = it }
        // Both fail quietly: an older gateway lacks these routes, and one
        // missing section should not blank the whole screen.
        runCatching { vm.api?.contextBudget("simba") }.onSuccess { budget = it }
        runCatching { vm.api?.storePressure() }.onSuccess { stores = it }
        runCatching { vm.api?.events() ?: emptyList() }.onSuccess { events = it }
    }

    LaunchedEffect(Unit) {
        url = ctx.gatewayUrl()
        token = ctx.gatewayToken()
        clientId = ctx.accessClientId()
        clientSecret = ctx.accessClientSecret()
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
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
            if (verifyingAll) Text("checking…", fontSize = 11.sp, color = Accent)
            else Text(
                "verify all",
                fontSize = 11.sp,
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
                                fontSize = 11.5.sp,
                                color = if (b.provider == "opencode" || b.cli == "ollama") Ok else Faint,
                            )
                            Spacer(Modifier.height(8.dp))
                        }
                        // The live answer, kept visually distinct from the
                        // stored status so it is obvious which was just measured.
                        verdict?.let { v ->
                            Text(
                                v.detail,
                                fontSize = 11.5.sp,
                                color = if (v.ok) Ok else Err,
                            )
                            Spacer(Modifier.height(8.dp))
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                            val busy = verifying == b.slug
                            Text(
                                if (busy) "asking…" else "verify",
                                fontSize = 12.sp,
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
                                fontSize = 12.sp,
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
                Text("${worktrees.size} held", fontSize = 11.sp, color = Warn)
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
                    expanded = { Text(w.state.path, color = Faint, fontSize = 11.sp) },
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
            Card(Modifier.padding(horizontal = 16.dp)) {
                b.slices.forEach { sl ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "${sl.pct}%",
                            fontSize = 11.sp,
                            color = if (sl.pct >= 30) Warn else Faint,
                            modifier = Modifier.width(34.dp),
                        )
                        Box(
                            Modifier.width((sl.pct.coerceAtMost(60) * 1.6).dp).height(6.dp)
                                .clip(RoundedCornerShape(3.dp))
                                .background(if (sl.pct >= 30) Warn else Accent),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(sl.category, color = Fg, fontSize = 11.5.sp)
                    }
                    sl.note?.let {
                        Text(it, color = Faint, fontSize = 10.sp, modifier = Modifier.padding(start = 34.dp, bottom = 3.dp))
                    }
                }
            }
        }

        // The stores that load every turn, and the button that tidies them.
        stores?.let { st ->
            SectionHeading("Stores") {
                Text(
                    if (curating) "tidying…" else "curate now",
                    fontSize = 11.sp,
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
            Card(Modifier.padding(horizontal = 16.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("memory", color = Fg, fontSize = 12.sp)
                    Meta(
                        "${st.memory.used}/${st.memory.cap}",
                        if (st.memory.pct > 75) Warn else Faint,
                    )
                }
                Row(
                    Modifier.fillMaxWidth().padding(top = 4.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("skills", color = Fg, fontSize = 12.sp)
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
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
                    fontSize = 11.sp,
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
        Card(Modifier.padding(horizontal = 16.dp)) {
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                label = { Text("Gateway URL", fontSize = 12.sp) },
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
                label = { Text("Token (optional)", fontSize = 12.sp) },
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
                fontSize = 11.sp,
                color = Faint,
            )
            Spacer(Modifier.height(6.dp))
            OutlinedTextField(
                value = clientId,
                onValueChange = { clientId = it },
                label = { Text("CF-Access-Client-Id", fontSize = 12.sp) },
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
                label = { Text("CF-Access-Client-Secret", fontSize = 12.sp) },
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
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
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
            text = { Text("Kills every running agent session immediately.", color = Dim, fontSize = 13.sp) },
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
