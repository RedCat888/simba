package com.operator.simba

import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.layout.FlowRow
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

    SkillsPane(skills, loading, error, open)
}

/**
 * What Simba has worked out and written down for itself.
 *
 * Sorted by whether the skill is earning its place rather than alphabetically.
 * Every skill costs prompt space on every turn of every session, so one that has
 * never been opened is a standing tax — and the list that surfaces those first
 * is the one that gets them removed.
 */
@Composable
fun SkillsPane(
    skills: List<Skill>,
    loading: Boolean = false,
    error: String? = null,
    open: (String) -> Unit = {},
) {
    LazyColumn(Modifier.fillMaxSize()) {
        when {
            loading -> item { LoadingState() }
            error != null -> item { FailureState(error) }
            skills.isEmpty() -> item {
                EmptyState(
                    "No skills yet",
                    "Agents write these themselves when they work out something worth reusing.",
                )
            }
            else -> {
                val unused = skills.filter { it.useCount == 0 }
                val earning = skills.filter { it.useCount > 0 }.sortedByDescending { it.useCount }

                if (unused.isNotEmpty()) {
                    item {
                        SectionHeading("Never used") {
                            Text(
                                "${unused.size} costing prompt space",
                                style = type.caption,
                                color = Warn,
                            )
                        }
                    }
                    items(unused, key = { it.name }) { SkillRow(it, open, statedByHeading = true) }
                }

                if (earning.isNotEmpty()) {
                    item {
                        SectionHeading("Earning their place") {
                            val learned = skills.count { it.source == "learned" }
                            Text("$learned self-taught", style = type.caption, color = Faint)
                        }
                    }
                    items(earning, key = { it.name }) { SkillRow(it, open) }
                }
            }
        }
    }
}

@Composable
private fun SkillRow(s: Skill, open: (String) -> Unit, statedByHeading: Boolean = false) {
    ItemRow(
        title = s.name,
        mono = true,
        subtitle = s.description,
        // 'learned' means an agent wrote it mid-work rather than it being
        // authored deliberately — worth seeing at a glance which of these Simba
        // taught itself.
        badge = if (s.source == "learned") ItemMeta("learned", Tone.Accented) else null,
        meta = buildList {
            // Usage is the honest measure of whether a skill is earning the
            // prompt space it costs on every turn.
            // The heading above already says these have never been used;
            // repeating it on every row spends a column to say nothing.
            if (s.useCount > 0) add(ItemMeta("used ${s.useCount}×", Tone.Good))
            else if (!statedByHeading) add(ItemMeta("never used", Tone.Warn))
            if (s.version > 1) add(ItemMeta("v${s.version}"))
            add(ItemMeta("${s.bodyChars} chars"))
        },
        onClick = { open(s.name) },
    )
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
        Row(Modifier.screenPad().padding(top = space.tight), verticalAlignment = Alignment.CenterVertically) {
            BackButton(back)
            Text("All skills", color = Dim, style = type.label, modifier = Modifier.padding(start = space.tight))
        }

        error?.let { FailureState(it) }
        if (skill == null && error == null) LoadingState(2)

        skill?.let { s ->
            Column(Modifier.screenPad().padding(top = space.snug)) {
                Text(
                    s.name,
                    color = Fg,
                    style = type.heading,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                )
                Text(
                    s.description,
                    color = Dim,
                    style = type.bodySmall,
                    lineHeight = 19.sp,
                    modifier = Modifier.padding(top = space.tight),
                )
                Row(
                    Modifier.padding(top = space.snug),
                    horizontalArrangement = Arrangement.spacedBy(space.base),
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
                    Text("${s.history.size} revisions", style = type.caption, color = Faint)
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

    LaunchedEffect(Unit) {
        runCatching { vm.api?.decisions() ?: emptyList() }
            .onSuccess { decisions = it }
            .onFailure { error = it.message }
        loading = false
    }

    DecisionsPane(decisions, loading, error)
}

/**
 * What has been settled, and why.
 *
 * Grouped by whether a decision is still standing. A superseded decision is not
 * noise — it is how you find out that something you remember being true stopped
 * being true — but it must not sit among the current ones pretending to still
 * hold, which a flat list sorted by date does.
 */
@Composable
fun DecisionsPane(
    decisions: List<Decision>,
    loading: Boolean = false,
    error: String? = null,
) {
    LazyColumn(Modifier.fillMaxSize()) {
        when {
            loading -> item { LoadingState() }
            error != null -> item { FailureState(error) }
            decisions.isEmpty() -> item {
                EmptyState(
                    "No decisions recorded",
                    "Simba records a decision when it commits to an approach, so the reasoning survives the session.",
                )
            }
            else -> {
                val current = decisions.filter { it.status != "superseded" }
                val past = decisions.filter { it.status == "superseded" }

                if (current.isNotEmpty()) {
                    item {
                        SectionHeading("Standing") {
                            val acted = current.count { it.confidence == "acted_on" }
                            Text("$acted acted on", style = type.caption, color = Ok)
                        }
                    }
                    items(current, key = { it.id }) { DecisionRow(it) }
                }

                if (past.isNotEmpty()) {
                    item { SectionHeading("Superseded") }
                    items(past, key = { it.id }) { DecisionRow(it, statedByHeading = true) }
                }
            }
        }
    }
}

@Composable
private fun DecisionRow(d: Decision, statedByHeading: Boolean = false) {
    ItemRow(
        title = d.statement,
        // Same rule as skills, and here it also fixes a real overflow:
        // "superseded" is longer than Console's status column and was butting
        // against the title of every row in a section already headed Superseded.
        badge = if (d.status == "superseded" && !statedByHeading) {
            ItemMeta("superseded", Tone.Warn)
        } else {
            null
        },
        meta = buildList {
            d.topic?.let { add(ItemMeta(it)) }
            add(
                ItemMeta(
                    // The column value is acted_on; a person reads "acted on".
                    // Underscores are how a database spells a phrase, and
                    // showing them is showing your schema to the user.
                    d.confidence.replace('_', ' '),
                    if (d.confidence == "acted_on") Tone.Good else Tone.Neutral,
                ),
            )
        },
        // Rationale is often several paragraphs — the reason a decision was made
        // matters more than the decision, but not enough to make the list
        // unscrollable.
        expanded = d.rationale?.takeIf { it.isNotBlank() }?.let {
            { Text(it, color = Faint, style = type.bodySmall) }
        },
    )
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
    val scope = rememberCoroutineScope()

    suspend fun load() {
        runCatching { vm.api?.memory() }
            .onSuccess { view = it; error = null }
            .onFailure { error = it.message }
    }
    LaunchedEffect(Unit) { load() }

    MemoryPane(
        view = view,
        error = error,
        onAdd = { kind, content ->
            scope.launch {
                runCatching { vm.api?.addMemory(kind, content) }
                    .onFailure { error = it.message }
                load()
            }
        },
        onForget = { entry ->
            scope.launch {
                runCatching { vm.api?.removeMemory(entry.content.take(60)) }
                load()
            }
        },
    )
}

/**
 * What Simba knows without being asked.
 *
 * Worth editing from here rather than only from an agent: memory loads on every
 * turn of every session, so a wrong entry is wrong everywhere until someone
 * removes it. The pressure bar is shown because the store is deliberately capped
 * by a database trigger — when it fills, a write is refused rather than quietly
 * trimmed, and seeing that coming is more useful than discovering it when
 * something fails to save.
 *
 * Split from its loader so both the empty and populated states can be rendered
 * without a gateway. The add form in particular had two controls that did not
 * look like controls, which is the sort of thing only visible by looking.
 */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun MemoryPane(
    view: MemoryView?,
    error: String?,
    onAdd: (String, String) -> Unit = { _, _ -> },
    onForget: (MemoryEntry) -> Unit = {},
    startAdding: Boolean = false,
) {
    var adding by remember { mutableStateOf(startAdding) }
    var draft by remember { mutableStateOf("") }
    var kind by remember { mutableStateOf("environment") }

    Column(Modifier.fillMaxSize()) {
        view?.let { v ->
            val used = v.pressure.global.used
            val cap = v.pressure.global.cap
            val pct = if (cap > 0) used.toFloat() / cap else 0f

            SectionHeading("Remembered") {
                Text(
                    if (adding) "cancel" else "+ add",
                    style = type.label,
                    color = Accent,
                    modifier = Modifier.clickable { adding = !adding },
                )
            }

            Column(Modifier.padding(horizontal = space.gutter)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("$used of $cap", style = type.caption, color = Dim)
                    Text(
                        if (pct > 0.85f) "nearly full — new facts will be refused" else "loaded every turn",
                        style = type.caption,
                        color = if (pct > 0.85f) Warn else Faint,
                    )
                }
                PressureBar(pct, Modifier.padding(top = space.snug))
            }

            if (adding) {
                Column(
                    Modifier.fillMaxWidth()
                        .padding(horizontal = space.gutter)
                        .padding(top = space.base)
                        .clip(RoundedCornerShape(radius.medium))
                        .background(Raised)
                        .padding(space.roomy),
                ) {
                    OutlinedTextField(
                        value = draft,
                        onValueChange = { draft = it },
                        label = { Text("One fact, under 400 characters", style = type.caption) },
                        modifier = Modifier.fillMaxWidth(),
                        maxLines = 4,
                    )

                    // Selectable rather than four words that happen to respond
                    // to a tap. Plain coloured text gives no indication it is a
                    // control, so the kind was effectively unchangeable.
                    // FlowRow, not Row: the four kinds at their natural widths
                    // exceed a phone row, and a Row resolved that by wrapping
                    // "preference" mid-word into "prefere / nce". Wrapping to a
                    // second line keeps every option visible, which matters when
                    // the options are the whole control.
                    FlowRow(
                        Modifier.padding(top = space.base),
                        horizontalArrangement = Arrangement.spacedBy(space.snug),
                        verticalArrangement = Arrangement.spacedBy(space.snug),
                    ) {
                        listOf("environment", "convention", "person", "preference").forEach { k ->
                            val on = kind == k
                            Text(
                                k,
                                style = type.caption,
                                color = if (on) OnAccent else Dim,
                                maxLines = 1,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(radius.pill))
                                    .background(if (on) Accent else Inset)
                                    .clickable { kind = k }
                                    .padding(horizontal = space.base, vertical = space.tight),
                            )
                        }
                    }

                    val valid = draft.trim().length in 1..400
                    Box(
                        Modifier.fillMaxWidth()
                            .padding(top = space.base)
                            .clip(RoundedCornerShape(radius.small))
                            .background(if (valid) Accent else Inset)
                            .clickable(enabled = valid) {
                                onAdd(kind, draft.trim())
                                draft = ""
                                adding = false
                            }
                            .padding(vertical = space.base),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "Remember this",
                            style = type.label,
                            color = if (valid) OnAccent else Faint,
                        )
                    }
                }
            }
            Spacer(Modifier.height(space.base))
        }

        error?.let { FailureState(it) }
        if (view == null && error == null) LoadingState(3)

        LazyColumn(Modifier.fillMaxSize()) {
            val entries = view?.entries.orEmpty()
            if (view != null && entries.isEmpty()) {
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
                            style = type.label,
                            color = Err,
                            modifier = Modifier.clickable { onForget(m) },
                        )
                    },
                )
            }
        }
    }
}
