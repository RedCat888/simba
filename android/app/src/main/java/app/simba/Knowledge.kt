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
        SingleChoiceSegmentedButtonRow(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            KnowledgeView.entries.forEachIndexed { i, v ->
                SegmentedButton(
                    selected = view == v,
                    onClick = { view = v },
                    shape = SegmentedButtonDefaults.itemShape(i, KnowledgeView.entries.size),
                    colors = SegmentedButtonDefaults.colors(
                        activeContainerColor = Accent.copy(alpha = 0.16f),
                        activeContentColor = Accent,
                        inactiveContainerColor = Panel,
                        inactiveContentColor = Faint,
                    ),
                ) { Text(v.label, fontSize = 12.sp) }
            }
        }

        when (view) {
            // Reuses the existing screen rather than a second copy of the same
            // search — one of them would drift.
            KnowledgeView.Search -> MemoryScreen(vm)
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

    when {
        loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
            CircularProgressIndicator(color = Accent, strokeWidth = 2.dp)
        }
        error != null -> Box(Modifier.fillMaxSize().padding(24.dp), Alignment.Center) {
            Text(error!!, color = Err, fontSize = 12.sp)
        }
        skills.isEmpty() -> Box(Modifier.fillMaxSize().padding(24.dp), Alignment.Center) {
            Text(
                "No skills yet. Agents write these themselves when they work out " +
                    "something worth reusing.",
                color = Faint,
                fontSize = 12.sp,
            )
        }
        else -> LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                val learned = skills.count { it.source == "learned" }
                Text(
                    "${skills.size} skills · $learned written by agents themselves",
                    fontSize = 11.sp,
                    color = Faint,
                    modifier = Modifier.padding(bottom = 2.dp),
                )
            }
            items(skills, key = { it.name }) { s ->
                Card(Modifier.clickable { open(s.name) }) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(
                            s.name,
                            color = Fg,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.SemiBold,
                            fontFamily = FontFamily.Monospace,
                        )
                        // 'learned' means an agent wrote it mid-work rather than
                        // it being authored deliberately — worth being able to
                        // see at a glance which of these Simba taught itself.
                        if (s.source == "learned") Pill("learned", Accent)
                    }
                    Text(
                        s.description,
                        color = Faint,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                    Row(
                        Modifier.padding(top = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        // Usage is the honest measure of whether a skill is
                        // earning the prompt space it costs on every turn.
                        Meta(
                            if (s.useCount == 0) "never used" else "used ${s.useCount}×",
                            if (s.useCount == 0) Warn else Ok,
                        )
                        if (s.version > 1) Meta("v${s.version}")
                        Meta("${s.bodyChars} chars")
                    }
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

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp)) {
        Text(
            "‹ back",
            color = Accent,
            fontSize = 12.sp,
            modifier = Modifier.clickable { back() }.padding(bottom = 10.dp),
        )

        error?.let { Text(it, color = Err, fontSize = 12.sp) }

        skill?.let { s ->
            Text(
                s.name,
                color = Fg,
                fontSize = 17.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
            Text(s.description, color = Faint, fontSize = 12.5.sp, modifier = Modifier.padding(top = 5.dp))
            Row(
                Modifier.padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Meta(s.source, if (s.source == "learned") Accent else Faint)
                Meta("v${s.version}")
                Meta(if (s.useCount == 0) "never used" else "used ${s.useCount}×")
            }

            Spacer(Modifier.height(12.dp))
            Card {
                // Monospace throughout: bodies are procedures with commands and
                // paths in them, and proportional text makes those harder to
                // read and to copy correctly.
                Text(s.body, color = Fg, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
            }

            if (s.history.size > 1) {
                Spacer(Modifier.height(12.dp))
                Text("HISTORY", fontSize = 10.sp, color = Faint, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(6.dp))
                s.history.forEach { h ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 3.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text("v${h.version}", color = Faint, fontSize = 11.sp)
                        Text(
                            h.note ?: "",
                            color = Faint,
                            fontSize = 11.sp,
                            modifier = Modifier.weight(1f).padding(start = 10.dp),
                        )
                    }
                }
            }
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

    when {
        loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
            CircularProgressIndicator(color = Accent, strokeWidth = 2.dp)
        }
        error != null -> Box(Modifier.fillMaxSize().padding(24.dp), Alignment.Center) {
            Text(error!!, color = Err, fontSize = 12.sp)
        }
        else -> LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(decisions, key = { it.id }) { d ->
                Card(Modifier.clickable { expanded = if (expanded == d.id) null else d.id }) {
                    Text(d.statement, color = Fg, fontSize = 12.5.sp)
                    Row(
                        Modifier.padding(top = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        d.topic?.let { Meta(it) }
                        Meta(d.confidence, if (d.confidence == "acted_on") Ok else Faint)
                        if (d.status == "superseded") Pill("superseded", Warn)
                    }
                    // Rationale is often several paragraphs — the reason a
                    // decision was made matters more than the decision, but not
                    // enough to make the list unscrollable.
                    if (expanded == d.id) {
                        d.rationale?.takeIf { it.isNotBlank() }?.let {
                            Text(
                                it,
                                color = Faint,
                                fontSize = 11.5.sp,
                                modifier = Modifier.padding(top = 8.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}
