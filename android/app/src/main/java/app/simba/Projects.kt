package com.operator.simba

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import kotlinx.coroutines.launch

/**
 * What exists on this machine, ordered by what you could lose.
 *
 * the operator built atlas before Simba and described it as "an operational index:
 * what exists, where it lives, what state it's in, what's risky, and what to do
 * next". This is the "what's risky" half, and the ordering is the whole design:
 * a list of forty repositories sorted by name is a list nobody opens twice, and
 * the same list with the three holding unpublished work at the top is worth
 * checking before shutting the machine down.
 *
 * It earned itself on the first run by finding that ReelAgent — which had just
 * had a fortnight of durability work done to it — had no git remote at all.
 */
@Composable
fun ProjectsScreen(vm: SimbaVm) {
    var projects by remember { mutableStateOf<List<Project>?>(null) }
    var failed by remember { mutableStateOf<String?>(null) }
    var scanning by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun load() {
        val api = vm.api ?: return
        runCatching { api.projects() }
            .onSuccess { projects = it; failed = null }
            .onFailure { failed = it.message ?: "could not reach the gateway" }
    }
    LaunchedEffect(vm.api) { load() }

    val rows = projects
    when {
        rows != null -> ProjectsBody(
            projects = rows,
            scanning = scanning,
            onRescan = {
                scanning = true
                scope.launch {
                    runCatching { vm.api?.scanProjects() }.onFailure { vm.error = it.message }
                    load()
                    scanning = false
                }
            },
        )
        failed != null -> FailureState(failed!!)
        else -> LoadingState()
    }
}

/** Pure, so it can be rendered and looked at without a gateway. */
@Composable
fun ProjectsBody(
    projects: List<Project>,
    scanning: Boolean = false,
    onRescan: () -> Unit = {},
) {
    val exposed = projects.filter { it.atRisk }
    val unreadable = projects.filter { it.scanError != null }
    val settled = projects.filter { !it.atRisk && it.scanError == null }

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = space.page),
        verticalArrangement = Arrangement.spacedBy(space.hair),
    ) {
        item {
            ItemRow(
                title = when {
                    exposed.isEmpty() -> "Everything is published"
                    exposed.size == 1 -> "1 project holds work that's only here"
                    else -> "${exposed.size} projects hold work that's only here"
                },
                subtitle = "${projects.size} tracked",
                // Not the summed exposure. Adding dirty files to unpushed
                // commits produces a number in no unit at all, which looks
                // precise and means nothing. The count worth promoting is the
                // sharpest case: a repository with no remote is not behind, it
                // has nowhere to be behind of.
                badge = when {
                    exposed.isEmpty() -> ItemMeta("clear", Tone.Good)
                    exposed.any { !it.hasRemote } ->
                        ItemMeta("${exposed.count { !it.hasRemote }} with no remote", Tone.Bad)
                    else -> ItemMeta("unpublished", Tone.Warn)
                },
                meta = listOf(ItemMeta(if (scanning) "scanning…" else "rescan", Tone.Accented)),
                onClick = onRescan,
            )
        }

        if (exposed.isNotEmpty()) {
            item { SectionHeading("Only on this disk") }
            items(exposed, key = { it.id }) { ProjectRow(it) }
        }

        // Separated rather than mixed in, because a repository git cannot read
        // is not a repository with nothing at risk — it is one where the
        // question was not answered, and the two must never look alike.
        if (unreadable.isNotEmpty()) {
            item { SectionHeading("Couldn't read") }
            items(unreadable, key = { it.id }) { ProjectRow(it) }
        }

        if (settled.isNotEmpty()) {
            item { SectionHeading("Published") }
            items(settled, key = { it.id }) { ProjectRow(it) }
        }
    }
}

@Composable
private fun ProjectRow(p: Project) {
    ItemRow(
        title = p.name,
        subtitle = p.rootPath?.let { shortPath(it, pathBudget(44)) },
        mono = false,
        meta = buildList {
            if (p.dirtyFiles > 0) add(ItemMeta("${p.dirtyFiles} uncommitted", Tone.Warn))
            if (p.unpushed > 0) {
                // A repository with no remote is the sharp case: it is not
                // "behind", it has nowhere to be behind of, and every commit in
                // it is on one disk.
                add(
                    if (p.hasRemote) ItemMeta("${p.unpushed} unpushed", Tone.Warn)
                    else ItemMeta("${p.unpushed} commits, nowhere else", Tone.Bad),
                )
            }
            p.branch?.let { add(ItemMeta(it)) }
            p.lastCommitAt?.let { add(ItemMeta(ago(it))) }
            p.owner?.let { add(ItemMeta(it, Tone.Accented)) }
        },
        badge = when {
            p.scanError != null -> ItemMeta("unreadable", Tone.Bad)
            !p.hasRemote && p.kind == "repo" -> ItemMeta("no remote", Tone.Bad)
            else -> null
        },
        expanded = p.scanError?.let { err -> { Text(err, color = Err, style = type.bodySmall) } },
    )
}
