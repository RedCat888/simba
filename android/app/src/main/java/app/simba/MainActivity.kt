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
        enableEdgeToEdge()
        setContent { SimbaTheme { SimbaRoot() } }
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

private enum class Tab(val label: String, val icon: androidx.compose.ui.graphics.vector.ImageVector) {
    Chat("Chat", Icons.Filled.Forum),
    Missions("Missions", Icons.Filled.Flag),
    Agents("Agents", Icons.Filled.SmartToy),
    Memory("Memory", Icons.Filled.Search),
    System("System", Icons.Filled.Tune),
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SimbaRoot(vm: SimbaVm = viewModel()) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var tab by remember { mutableStateOf(Tab.Chat) }
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

    // A chat takes the whole screen. The top bar and nav are chrome that steals
    // vertical space from the one view where every line counts.
    if (openChat != null && ready) {
        val (sid, title) = openChat!!
        ChatScreen(vm, sid, title) { openChat = null; vm.refresh() }
        return
    }

    Scaffold(
        containerColor = Bg,
        topBar = { SimbaTopBar(vm) },
        bottomBar = {
            NavigationBar(containerColor = Panel, tonalElevation = 0.dp) {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t && openMission == null && openChat == null,
                        onClick = { tab = t; openMission = null; openChat = null },
                        icon = { Icon(t.icon, contentDescription = t.label) },
                        label = { Text(t.label, fontSize = 11.sp) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = Accent,
                            selectedTextColor = Accent,
                            indicatorColor = Panel2,
                            unselectedIconColor = Faint,
                            unselectedTextColor = Faint,
                        ),
                    )
                }
            }
        },
    ) { pad ->
        Box(Modifier.padding(pad).fillMaxSize()) {
            when {
                !ready -> CenteredNote("Connecting…")
                openMission != null -> MissionDetailScreen(vm, openMission!!) { openMission = null }
                else -> when (tab) {
                    Tab.Chat -> ChatListScreen(vm) { sid, title -> openChat = sid to title }
                    Tab.Missions -> MissionsScreen(vm) { openMission = it }
                    Tab.Agents -> AgentsScreen(vm) { sid, title -> openChat = sid to title }
                    Tab.Memory -> MemoryScreen(vm)
                    Tab.System -> SystemScreen(vm) { url, token, clientId, clientSecret ->
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SimbaTopBar(vm: SimbaVm) {
    TopAppBar(
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
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Panel)
            .padding(14.dp),
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

@Composable
private fun Meta(text: String, color: Color = Faint) {
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
                d.mission.blockedReason?.takeIf { it.isNotBlank() }?.let {
                    Spacer(Modifier.height(8.dp))
                    Box(
                        Modifier.clip(RoundedCornerShape(8.dp)).background(Warn.copy(alpha = 0.12f)).padding(9.dp),
                    ) { Text("Blocked: $it", fontSize = 12.sp, color = Warn) }
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
                        colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = Color(0xFF1A1206)),
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
                colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = Color(0xFF1A1206)),
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
private fun MemoryScreen(vm: SimbaVm) {
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
        Text("BRAINS", fontSize = 10.sp, color = Faint, fontWeight = FontWeight.SemiBold)
        vm.brains.forEach { b ->
            Card {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(b.label, color = Fg, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold)
                    Pill(b.status, statusColor(b.status))
                }
                Row(Modifier.padding(top = 5.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Meta(b.provider)
                    Meta("7d $${"%.2f".format(b.cost7d ?: 0.0)}")
                    b.limitResetsAt?.let { Meta("resets $it", Warn) }
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
                colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = Color(0xFF1A1206)),
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
