package com.operator.simba

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/**
 * Knowledge: what Simba has searched, learned, and decided.
 *
 * Three things that were all invisible from the phone despite being the parts
 * that accumulate. Search was already here; skills and decisions existed only
 * in Postgres, which meant the two systems designed to make Simba improve over
 * time could not be inspected from the device it is mostly driven from.
 *
 * A segmented control rather than three more tabs: the bottom bar is already
 * five wide and these are facets of one question — what does it know?
 */

enum class KnowledgeView(val label: String) {
    Search("Search"),
    Memory("Memory"),
    Skills("Skills"),
    Decisions("Decisions"),
}

@Composable
fun KnowledgeScreen(vm: SimbaVm) {
    var view by remember { mutableStateOf(KnowledgeView.Search) }
    var openSkill by remember { mutableStateOf<String?>(null) }

    if (openSkill != null) {
        SkillDetailScreen(vm, openSkill!!) { openSkill = null }
        return
    }

    Column(Modifier.fillMaxSize()) {
        FacetRow(
            labels = KnowledgeView.entries.map { it.label },
            selected = view.ordinal,
            onSelect = { view = KnowledgeView.entries[it] },
        )

        when (view) {
            // Reuses the existing screen rather than a second copy of the same
            // search — one of them would drift.
            KnowledgeView.Search -> MemoryScreen(vm)
            KnowledgeView.Memory -> MemoryList(vm)
            KnowledgeView.Skills -> SkillsList(vm) { openSkill = it }
            KnowledgeView.Decisions -> DecisionsList(vm)
        }
    }
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

@Composable
private fun SkillsList(vm: SimbaVm, open: (String) -> Unit) {
    var skills by remember { mutableStateOf<List<Skill>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        runCatching { vm.api?.skills() ?: emptyList() }
            .onSuccess { skills = it }
            .onFailure { error = it.message }
        loading = false
    }

    LazyColumn(Modifier.fillMaxSize()) {
        when {
            loading -> item { LoadingState() }
            error != null -> item { FailureState(error!!) }
            skills.isEmpty() -> item {
                EmptyState(
                    "No skills yet",
                    "Agents write these themselves when they work out something worth reusing.",
                )
            }
            else -> {
                item {
                    val learned = skills.count { it.source == "learned" }
                    SectionHeading("${skills.size} skills") {
                        Text("$learned self-taught", fontSize = 11.sp, color = Faint)
                    }
                }
                items(skills, key = { it.name }) { s ->
                    ItemRow(
                        title = s.name,
                        subtitle = s.description,
                        // 'learned' means an agent wrote it mid-work rather than
                        // it being authored deliberately — worth being able to
                        // see at a glance which of these Simba taught itself.
                        badge = if (s.source == "learned") ItemMeta("learned", Tone.Accented) else null,
                        meta = buildList {
                            // Usage is the honest measure of whether a skill is
                            // earning the prompt space it costs on every turn.
                            add(
                                if (s.useCount == 0) {
                                    ItemMeta("never used", Tone.Warn)
                                } else {
                                    ItemMeta("used ${s.useCount}×", Tone.Good)
                                },
                            )
                            if (s.version > 1) add(ItemMeta("v${s.version}"))
                            add(ItemMeta("${s.bodyChars} chars"))
                        },
                        onClick = { open(s.name) },
                    )
                }
            }
        }
    }
}

@Composable
private fun SkillDetailScreen(vm: SimbaVm, name: String, back: () -> Unit) {
    var skill by remember { mutableStateOf<SkillDetail?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(name) {
        runCatching { vm.api?.skill(name) }
            .onSuccess { skill = it }
            .onFailure { error = it.message }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Row(Modifier.screenPad().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            BackButton(back)
            Text("All skills", color = Dim, fontSize = 12.5.sp, modifier = Modifier.padding(start = 4.dp))
        }

        error?.let { FailureState(it) }
        if (skill == null && error == null) LoadingState(2)

        skill?.let { s ->
            Column(Modifier.screenPad().padding(top = 10.dp)) {
                Text(
                    s.name,
                    color = Fg,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                )
                Text(
                    s.description,
                    color = Dim,
                    fontSize = 13.sp,
                    lineHeight = 19.sp,
                    modifier = Modifier.padding(top = 6.dp),
                )
                Row(
                    Modifier.padding(top = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Meta(s.source, if (s.source == "learned") Accent else Faint)
                    Meta("v${s.version}")
                    Meta(if (s.useCount == 0) "never used" else "used ${s.useCount}×")
                }
            }

            // Monospace, copyable, and height-bounded by the same block every
            // other long body in the app goes through — a skill body is a
            // procedure with commands and paths in it, and a raw Text of it was
            // the one place left that could grow without limit.
            Spacer(Modifier.height(14.dp))
            Card(Modifier.screenPad()) {
                ExpandableBody(s.body, monospace = true, color = Fg, initiallyExpanded = true)
            }

            if (s.history.size > 1) {
                SectionHeading("History") {
                    Text("${s.history.size} revisions", fontSize = 11.sp, color = Faint)
                }
                s.history.forEach { h ->
                    ItemRow(
                        title = "v${h.version}",
                        subtitle = h.note,
                        meta = buildList { h.createdAt?.let { add(ItemMeta(it.take(10))) } },
                    )
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

@Composable
private fun DecisionsList(vm: SimbaVm) {
    var decisions by remember { mutableStateOf<List<Decision>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var expanded by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        runCatching { vm.api?.decisions() ?: emptyList() }
            .onSuccess { decisions = it }
            .onFailure { error = it.message }
        loading = false
    }

    LazyColumn(Modifier.fillMaxSize()) {
        when {
            loading -> item { LoadingState() }
            error != null -> item { FailureState(error!!) }
            decisions.isEmpty() -> item {
                EmptyState(
                    "No decisions recorded",
                    "Simba records a decision when it commits to an approach, so the reasoning survives the session.",
                )
            }
            else -> items(decisions, key = { it.id }) { d ->
                ItemRow(
                    title = d.statement,
                    badge = if (d.status == "superseded") ItemMeta("superseded", Tone.Warn) else null,
                    meta = buildList {
                        d.topic?.let { add(ItemMeta(it)) }
                        add(
                            ItemMeta(
                                d.confidence,
                                if (d.confidence == "acted_on") Tone.Good else Tone.Neutral,
                            ),
                        )
                    },
                    // Rationale is often several paragraphs — the reason a
                    // decision was made matters more than the decision, but not
                    // enough to make the list unscrollable.
                    expanded = d.rationale?.takeIf { it.isNotBlank() }?.let {
                        { Text(it, color = Faint, fontSize = 11.5.sp, lineHeight = 17.sp) }
                    },
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * What Simba knows without being asked.
 *
 * Worth editing from here rather than only from an agent: memory loads on every
 * turn of every session, so a wrong entry is wrong everywhere until someone
 * removes it. The pressure bar is shown because the store is deliberately
 * capped — when it fills, something has to go, and seeing that coming is more
 * useful than discovering it when a write is refused.
 */
@Composable
private fun MemoryList(vm: SimbaVm) {
    var view by remember { mutableStateOf<MemoryView?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf("") }
    var kind by remember { mutableStateOf("environment") }
    val scope = rememberCoroutineScope()

    suspend fun load() {
        runCatching { vm.api?.memory() }
            .onSuccess { view = it; error = null }
            .onFailure { error = it.message }
    }
    LaunchedEffect(Unit) { load() }

    Column(Modifier.fillMaxSize()) {
        view?.let { v ->
            @Suppress("NAME_SHADOWING") val pad = Modifier.padding(horizontal = 16.dp)
            val used = v.pressure.global.used
            val cap = v.pressure.global.cap
            val pct = if (cap > 0) used.toFloat() / cap else 0f
            Row(
                pad.fillMaxWidth().padding(top = 6.dp, bottom = 6.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("$used / $cap remembered", fontSize = 11.sp, color = if (pct > 0.75f) Warn else Faint)
                Text(
                    if (adding) "cancel" else "+ remember",
                    fontSize = 11.sp,
                    color = Accent,
                    modifier = Modifier.clickable { adding = !adding },
                )
            }
            LinearProgressIndicator(
                progress = { pct },
                modifier = pad.fillMaxWidth().height(3.dp),
                color = if (pct > 0.75f) Warn else Accent,
                trackColor = Panel2,
            )

            if (adding) {
                Spacer(Modifier.height(8.dp))
                Card(pad) {
                    OutlinedTextField(
                        value = draft,
                        onValueChange = { draft = it },
                        label = { Text("One fact, under 400 characters", fontSize = 11.sp) },
                        modifier = Modifier.fillMaxWidth(),
                        maxLines = 4,
                    )
                    Row(
                        Modifier.padding(top = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        listOf("environment", "convention", "person", "preference").forEach { k ->
                            Text(
                                k,
                                fontSize = 11.sp,
                                color = if (kind == k) Accent else Faint,
                                modifier = Modifier.clickable { kind = k },
                            )
                        }
                    }
                    Text(
                        "save",
                        fontSize = 12.sp,
                        color = Ok,
                        modifier = Modifier.padding(top = 8.dp).clickable {
                            scope.launch {
                                runCatching { vm.api?.addMemory(kind, draft.trim()) }
                                    .onFailure { error = it.message }
                                draft = ""; adding = false; load()
                            }
                        },
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
        }

        error?.let { FailureState(it) }

        LazyColumn(Modifier.fillMaxSize()) {
            val entries = view?.entries.orEmpty()
            if (view == null && error == null) {
                item { LoadingState(3) }
            } else if (entries.isEmpty()) {
                item {
                    EmptyState(
                        "Nothing remembered yet",
                        "Facts saved here load into every session, so keep them few and true.",
                    )
                }
            }
            items(entries, key = { it.id }) { m ->
                ItemRow(
                    title = m.content,
                    meta = buildList {
                        add(ItemMeta(m.kind))
                        m.source?.let { add(ItemMeta(it.take(30))) }
                        if (m.confirmations > 0) add(ItemMeta("confirmed ${m.confirmations}×", Tone.Good))
                    },
                    // Forgetting lives behind the expansion rather than beside
                    // the text: it is irreversible, and an irreversible control
                    // one stray thumb away from a scrolling list is a trap.
                    expanded = {
                        Text(
                            "Forget this",
                            fontSize = 12.sp,
                            color = Err,
                            modifier = Modifier.clickable {
                                scope.launch {
                                    runCatching { vm.api?.removeMemory(m.content.take(60)) }
                                    load()
                                }
                            },
                        )
                    },
                )
            }
        }
    }
}
