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
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { ErrorBanner(vm.error) }

        vm.briefs.firstOrNull()?.let { b ->
            item {
                Card {
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

        if (vm.missions.isEmpty() && vm.error == null) {
            item {
                Card {
                    Text("No missions yet", color = Fg, fontWeight = FontWeight.SemiBold)
                    Text(
                        "A mission is an objective that runs itself across many sessions — it plans, provisions what it needs, works, and verifies.",
                        fontSize = 12.5.sp,
                        color = Dim,
                        modifier = Modifier.padding(top = 5.dp),
                    )
                }
            }
        }

        items(vm.missions, key = { it.id }) { m -> MissionCard(m) { open(m.id) } }
    }
}

@Composable
private fun MissionCard(m: Mission, onClick: () -> Unit) {
    val pct = if (m.totalSteps > 0) m.doneSteps.toFloat() / m.totalSteps else 0f
    val animated by animateFloatAsState(pct, label = "progress")

    Card(Modifier.clickable(onClick = onClick)) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                m.title,
                fontWeight = FontWeight.SemiBold,
                fontSize = 14.5.sp,
                color = Fg,
                modifier = Modifier.weight(1f, fill = false),
            )
            Spacer(Modifier.width(8.dp))
            Pill(m.status, statusColor(m.status))
        }

        val sub = m.currentStep ?: m.blockedReason
        if (!sub.isNullOrBlank()) {
            Text(sub, fontSize = 12.sp, color = Dim, modifier = Modifier.padding(top = 4.dp))
        }

        Spacer(Modifier.height(9.dp))
        LinearProgressIndicator(
            progress = { animated },
            modifier = Modifier.fillMaxWidth().height(5.dp).clip(RoundedCornerShape(3.dp)),
            color = if (m.failedSteps > 0) Warn else Ok,
            trackColor = Panel2,
            gapSize = 0.dp,
            drawStopIndicator = {},
        )

        Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Meta("${m.doneSteps}/${m.totalSteps} steps")
            if (m.failedSteps > 0) Meta("${m.failedSteps} failed", Warn)
            Meta("${m.sessionsUsed}/${m.maxSessions} sessions")
            Meta("$${"%.2f".format(m.costUsed)}")
        }
    }
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
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            TextButton(onClick = back) {
                Icon(Icons.Filled.ArrowBack, null, tint = Info, modifier = Modifier.size(16.dp))
                Text("  All missions", color = Info, fontSize = 12.5.sp)
            }
        }

        if (d == null) { item { CenteredNote("Loading…") }; return@LazyColumn }

        item {
            Card {
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
            Text(
                "PLAN — ${d.steps.size} STEPS",
                fontSize = 10.sp,
                color = Faint,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(start = 4.dp, top = 4.dp),
            )
        }

        items(d.steps) { s -> StepCard(s) }
    }
}

@Composable
private fun StepCard(s: MissionStep) {
    var expanded by remember { mutableStateOf(false) }
    Card(Modifier.clickable { expanded = !expanded }) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("${s.seq}.", color = Faint, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.width(7.dp))
            Text(s.title, color = Fg, fontSize = 13.5.sp, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(6.dp))
            Pill(s.kind, Info)
            Spacer(Modifier.width(5.dp))
            Pill(s.status, statusColor(s.status))
        }
        if (expanded) {
            Text(s.instruction, fontSize = 12.sp, color = Dim, modifier = Modifier.padding(top = 7.dp))
        }
        s.result?.takeIf { it.isNotBlank() }?.let {
            Text("✓ $it", fontSize = 12.sp, color = Ok, modifier = Modifier.padding(top = 6.dp))
        }
        s.failures?.takeIf { it.isNotBlank() }?.let {
            Text("✕ $it", fontSize = 12.sp, color = Err, modifier = Modifier.padding(top = 6.dp))
        }
    }
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

@Composable
private fun AgentsScreen(vm: SimbaVm, openChat: (String, String) -> Unit) {
    var prompting by remember { mutableStateOf<Agent?>(null) }

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { ErrorBanner(vm.error) }
        items(vm.agents, key = { it.id }) { a ->
            Card {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(a.name, fontWeight = FontWeight.SemiBold, color = Fg, fontSize = 14.5.sp)
                        Spacer(Modifier.width(7.dp))
                        Pill("T${a.tier}", if (a.tier == 0) Accent else Dim)
                    }
                    Pill(a.status, statusColor(a.status))
                }
                a.description?.let {
                    Text(it, fontSize = 12.sp, color = Dim, modifier = Modifier.padding(top = 4.dp))
                }
                Row(
                    Modifier.padding(top = 9.dp).fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(horizontalArrangement = Arrangement.spacedBy(11.dp)) {
                        Meta(a.modelTier)
                        Meta("${a.activeSessions} live")
                        Meta("$${"%.2f".format(a.totalCost)}")
                    }
                    Button(
                        onClick = { prompting = a },
                        colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = OnAccent),
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp),
                    ) { Text("Start", fontSize = 12.sp, fontWeight = FontWeight.SemiBold) }
                }
            }
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

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        item {
            Button(
                onClick = {
                    if (starting || simba == null) return@Button
                    starting = true
                    scope.launch {
                        val r = runCatching {
                            vm.api?.startAgent(simba.slug, "Hey — what's going on with the system right now?")
                        }.getOrNull()
                        starting = false
                        vm.refresh()
                        r?.sessionId?.let { open(it, simba.name) } ?: run { vm.error = r?.error }
                    }
                },
                enabled = !starting,
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = OnAccent),
            ) {
                Icon(Icons.Filled.Add, null, modifier = Modifier.size(18.dp))
                Text(
                    if (starting) "  Starting…" else "  Talk to ${simba?.name ?: "Simba"}",
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }

        item { ErrorBanner(vm.error) }

        if (live.isNotEmpty()) {
            item { SectionLabel("LIVE") }
            items(live, key = { it.id }) { s -> SessionRowCard(s) { open(s.id, s.title ?: s.agent) } }
        }

        if (past.isNotEmpty()) {
            item { SectionLabel("EARLIER") }
            items(past, key = { it.id }) { s -> SessionRowCard(s) { open(s.id, s.title ?: s.agent) } }
        }

        if (vm.sessions.isEmpty() && vm.error == null) {
            item {
                Card {
                    Text("No conversations yet", color = Fg, fontWeight = FontWeight.SemiBold)
                    Text(
                        "Start one above, or launch an agent from the Agents tab and it will open here.",
                        fontSize = 12.5.sp, color = Dim, modifier = Modifier.padding(top = 5.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        fontSize = 10.sp,
        color = Faint,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(start = 4.dp, top = 5.dp),
    )
}

@Composable
private fun SessionRowCard(s: SessionRow, onClick: () -> Unit) {
    Card(Modifier.clickable(onClick = onClick)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(
                s.title ?: s.agent,
                color = Fg,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                modifier = Modifier.weight(1f, fill = false),
            )
            Spacer(Modifier.width(8.dp))
            Pill(s.status, statusColor(s.status))
        }
        Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(11.dp)) {
            Meta(s.agent)
            s.brain?.let { Meta(it) }
            if (s.swapCount > 0) Meta("⇄ ${s.swapCount}", Accent)
            Meta("$${"%.3f".format(s.cost)}")
        }
        // A session showing "failed" and nothing else reads as a defect in
        // Simba rather than something that happened to a process. The reason
        // was already being recorded; it just never reached here.
        s.error?.takeIf { it.isNotBlank() }?.let {
            Text(
                it,
                fontSize = 11.sp,
                color = Err,
                maxLines = 2,
                modifier = Modifier.padding(top = 5.dp),
            )
        }
    }
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
            searching -> CenteredNote("Searching…")
            hits.isEmpty() && searched -> CenteredNote("No matches.")
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                items(hits) { h ->
                    Card {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(
                                h.title ?: "untitled",
                                color = Fg,
                                fontSize = 13.5.sp,
                                fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                            Pill("${(h.relevance * 100).toInt()}%", Info)
                        }
                        h.source?.let { Text(it, fontSize = 11.sp, color = Faint, modifier = Modifier.padding(top = 2.dp)) }
                        Text(
                            h.content.take(400),
                            fontSize = 12.sp,
                            color = Dim,
                            modifier = Modifier.padding(top = 6.dp),
                        )
                    }
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

    LaunchedEffect(Unit) {
        // Failing quietly is right here: an older gateway has no /api/worktrees,
        // and the whole screen should not break because one section is missing.
        runCatching { vm.api?.worktrees() ?: emptyList() }.onSuccess { worktrees = it }
        // Both fail quietly: an older gateway lacks these routes, and one
        // missing section should not blank the whole screen.
        runCatching { vm.api?.contextBudget("simba") }.onSuccess { budget = it }
        runCatching { vm.api?.storePressure() }.onSuccess { stores = it }
    }

    LaunchedEffect(Unit) {
        url = ctx.gatewayUrl()
        token = ctx.gatewayToken()
        clientId = ctx.accessClientId()
        clientSecret = ctx.accessClientSecret()
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // The ladder, in the order failover actually walks it — the sequence is
        // the point, not the set. Each row can be asked whether it really works
        // and benched without touching the machine.
        Row(
            Modifier.fillMaxWidth().padding(bottom = 2.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("BUILD", fontSize = 10.sp, color = Faint, fontWeight = FontWeight.SemiBold)
            Meta(BuildConfig.BUILD_STAMP, Accent)
        }

        Text("DESIGN", fontSize = 10.sp, color = Faint, fontWeight = FontWeight.SemiBold)
        Card {
            val design = LocalDesign.current
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Design.entries.forEach { d ->
                    val on = d == design
                    Text(
                        d.label,
                        fontSize = 12.sp,
                        fontWeight = if (on) FontWeight.Bold else FontWeight.Normal,
                        color = if (on) OnAccent else Dim,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(8.dp))
                            .background(if (on) Accent else Panel2)
                            .clickable { scope.launch { ctx.saveDesign(d) } }
                            .padding(vertical = 9.dp),
                    )
                }
            }
            Spacer(Modifier.height(7.dp))
            Text(design.blurb, fontSize = 11.sp, color = Faint)
        }

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("BRAINS — FAILOVER ORDER", fontSize = 10.sp, color = Faint, fontWeight = FontWeight.SemiBold)
            if (verifyingAll) Text("checking…", fontSize = 10.sp, color = Accent)
            else Text(
                "verify all",
                fontSize = 10.sp,
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
        vm.brains.forEachIndexed { i, b ->
            val verdict = verdicts[b.slug]
            Card {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                        Text(
                            "${i + 1}",
                            fontSize = 11.sp,
                            color = Faint,
                            modifier = Modifier.padding(top = 2.dp),
                        )
                        Text(
                            b.label,
                            color = if (b.enabled) Fg else Faint,
                            fontSize = 13.5.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    Pill(if (!b.enabled) "benched" else b.status, if (!b.enabled) Faint else statusColor(b.status))
                }
                Row(Modifier.padding(top = 5.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Meta(b.provider)
                    // Free brains cost nothing by construction; showing $0.00
                    // next to them implies a meter that does not exist.
                    if (b.provider == "opencode" || b.cli == "ollama") Meta("free", Ok)
                    else Meta("7d $${"%.2f".format(b.cost7d ?: 0.0)}")
                    b.limitResetsAt?.let { Meta("resets $it", Warn) }
                }
                // Rolling 5-hour usage. On a subscription-only setup headroom is
                // the scarce resource, and this window is what actually predicts
                // a brain going unavailable — a cost figure does not, because
                // the limit is not denominated in dollars.
                if (b.input5h > 0 || b.output5h > 0) {
                    Row(
                        Modifier.padding(top = 3.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Meta("5h ${tokens(b.input5h)} in / ${tokens(b.output5h)} out")
                        // Real volume at no cost is the point of the free tier,
                        // so say so rather than leaving a blank where a price
                        // would be.
                        if (b.provider == "opencode" || b.cli == "ollama") {
                            Meta("at no cost", Ok)
                        }
                    }
                }
                // A brain showing "logged_out" with no explanation reads as a
                // bug in Simba rather than a state of the account. The reason
                // is already recorded server-side, so show it.
                b.lastError?.takeIf { it.isNotBlank() }?.let {
                    Text(
                        it,
                        fontSize = 11.sp,
                        color = if (b.status in listOf("logged_out", "error")) Err else Faint,
                        modifier = Modifier.padding(top = 5.dp),
                    )
                }
                // The live answer, kept visually distinct from the stored status
                // so it is obvious which one was just measured.
                verdict?.let { v ->
                    Text(
                        (if (v.ok) "✓ " else "✗ ") + v.detail,
                        fontSize = 11.sp,
                        color = if (v.ok) Ok else Err,
                        modifier = Modifier.padding(top = 5.dp),
                    )
                }
                Row(
                    Modifier.padding(top = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    val busy = verifying == b.slug
                    Text(
                        if (busy) "asking…" else "verify",
                        fontSize = 11.sp,
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
                        fontSize = 11.sp,
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
        }

        // Work an agent produced that nothing has collected.
        //
        // A worktree is kept rather than deleted whenever it still holds
        // changes, which is right — destroying unattended work is not
        // recoverable. But kept-and-invisible is its own failure: the session
        // reads "completed" while a directory somewhere holds the only copy.
        if (worktrees.isNotEmpty()) {
            Spacer(Modifier.height(4.dp))
            Text(
                "UNCOLLECTED WORK",
                fontSize = 10.sp,
                color = Warn,
                fontWeight = FontWeight.SemiBold,
            )
            worktrees.forEach { w ->
                Card {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(w.agent, color = Fg, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        Pill(
                            when {
                                // Not recoverable, so not a call to action.
                                w.state.originMissing -> "repo gone"
                                w.state.dirty -> "uncommitted"
                                else -> "${w.state.ahead} commits"
                            },
                            if (w.state.originMissing) Faint else Warn,
                        )
                    }
                    Text(
                        w.state.branch ?: "",
                        color = Faint,
                        fontSize = 11.sp,
                        fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                    Text(
                        w.state.path,
                        color = Faint,
                        fontSize = 10.sp,
                        maxLines = 1,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
            }
        }


        // What every turn pays for, and what it is spent on.
        //
        // The brief grew all night and nothing measured the total until it was
        // asked. Memory turned out to be the largest single consumer, which was
        // not the guess - so this is here to be looked at rather than assumed.
        budget?.let { b ->
            Spacer(Modifier.height(4.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("CONTEXT PER TURN", fontSize = 10.sp, color = Faint, fontWeight = FontWeight.SemiBold)
                Meta("~${tokens(b.estTokens.toLong())} tokens")
            }
            Card {
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
            Spacer(Modifier.height(4.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("STORES", fontSize = 10.sp, color = Faint, fontWeight = FontWeight.SemiBold)
                Text(
                    if (curating) "tidying..." else "curate now",
                    fontSize = 10.sp,
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
            Card {
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

        Spacer(Modifier.height(4.dp))
        Text("CONNECTION", fontSize = 10.sp, color = Faint, fontWeight = FontWeight.SemiBold)
        Card {
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

        Spacer(Modifier.height(6.dp))
        Button(
            onClick = { confirmPanic = true },
            colors = ButtonDefaults.buttonColors(containerColor = Err.copy(alpha = 0.15f), contentColor = Err),
            modifier = Modifier.fillMaxWidth(),
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
