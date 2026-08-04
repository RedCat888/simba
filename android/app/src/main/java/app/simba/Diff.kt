package com.operator.simba

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * What a session actually changed.
 *
 * Simba's whole premise is work happening while nobody watches, and the only
 * record of an agent's effect on the filesystem was a diffstat line. Knowing
 * eleven files were touched without knowing what happened inside them is the
 * wrong half to have — reviewing the change is what makes unattended work
 * something you can trust rather than merely something that finished.
 */

private val AddBg = Color(0xFF0E2A18)
private val DelBg = Color(0xFF2C1214)
private val AddFg = Color(0xFF7EE2A8)
private val DelFg = Color(0xFFF08D92)
private val HunkFg = Color(0xFF7AA2F7)

@Composable
fun DiffScreen(vm: SimbaVm, sessionId: String, onBack: () -> Unit) {
    var diff by remember { mutableStateOf<SessionDiff?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var open by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(sessionId) {
        runCatching { vm.api?.sessionDiff(sessionId) }
            .onSuccess { diff = it }
            .onFailure { error = it.message }
        loading = false
    }

    SimbaShell(
        header = {
            Row(
                Modifier.fillMaxWidth().background(Panel).padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "‹ back",
                    color = Accent,
                    fontSize = 13.sp,
                    modifier = Modifier.clickable { onBack() },
                )
                Spacer(Modifier.width(12.dp))
                diff?.let { d ->
                    Text("+${d.totalAdditions}", color = AddFg, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.width(6.dp))
                    Text("−${d.totalDeletions}", color = DelFg, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.width(10.dp))
                    Text(d.branch ?: "", color = Faint, fontSize = 11.sp)
                }
            }
        },
    ) {
        when {
            loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                CircularProgressIndicator(color = Accent, strokeWidth = 2.dp)
            }
            error != null -> Box(Modifier.fillMaxSize().padding(24.dp), Alignment.Center) {
                Text(error!!, color = Err, fontSize = 12.sp)
            }
            diff == null || (diff!!.files.isEmpty() && diff!!.commits.isEmpty()) ->
                Box(Modifier.fillMaxSize().padding(24.dp), Alignment.Center) {
                    Text("No changes in this session's working tree.", color = Faint, fontSize = 12.sp)
                }
            else -> LazyColumn(
                Modifier.fillMaxSize().padding(horizontal = 10.dp),
                verticalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                val d = diff!!

                if (d.commits.isNotEmpty()) {
                    item {
                        Text(
                            "COMMITS",
                            fontSize = 10.sp,
                            color = Faint,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(top = 8.dp),
                        )
                    }
                    items(d.commits, key = { it.sha }) { c ->
                        Card {
                            Row {
                                Text(
                                    c.sha,
                                    color = Accent,
                                    fontSize = 11.sp,
                                    fontFamily = FontFamily.Monospace,
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(c.subject, color = Fg, fontSize = 12.sp, maxLines = 2)
                            }
                        }
                    }
                }

                if (d.files.isNotEmpty()) {
                    item {
                        Text(
                            "UNCOMMITTED",
                            fontSize = 10.sp,
                            color = Faint,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(top = 10.dp),
                        )
                    }
                    items(d.files, key = { it.path }) { f ->
                        Card(Modifier.clickable { open = if (open == f.path) null else f.path }) {
                            Row(
                                Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Text(
                                    // Long paths matter at the end, not the
                                    // start — a phone-width row that truncates
                                    // right shows only directories.
                                    f.path.takeLast(46),
                                    color = Fg,
                                    fontSize = 11.5.sp,
                                    fontFamily = FontFamily.Monospace,
                                    maxLines = 1,
                                    modifier = Modifier.weight(1f),
                                )
                                Row {
                                    if (f.additions > 0) {
                                        Text("+${f.additions}", color = AddFg, fontSize = 11.sp)
                                        Spacer(Modifier.width(5.dp))
                                    }
                                    if (f.deletions > 0) {
                                        Text("−${f.deletions}", color = DelFg, fontSize = 11.sp)
                                    }
                                }
                            }
                            Row(Modifier.padding(top = 3.dp)) {
                                Meta(f.status, if (f.status == "untracked") Warn else Faint)
                            }

                            if (open == f.path) {
                                Spacer(Modifier.height(8.dp))
                                when {
                                    f.truncated -> Text(
                                        "Patch withheld — too large to send to the phone. " +
                                            "Review it on the machine.",
                                        color = Warn,
                                        fontSize = 11.sp,
                                    )
                                    f.patch.isNullOrBlank() -> Text(
                                        "No patch available.",
                                        color = Faint,
                                        fontSize = 11.sp,
                                    )
                                    else -> PatchView(f.patch)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * A patch, coloured by line kind.
 *
 * Scrolls horizontally rather than wrapping: wrapped code on a narrow screen
 * makes the +/- column ambiguous, and that column is the entire point.
 */
@Composable
private fun PatchView(patch: String) {
    val lines = remember(patch) { patch.split('\n').take(400) }
    Column(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        lines.forEach { line ->
            val (bg, fg) = when {
                line.startsWith("+++") || line.startsWith("---") -> Color.Transparent to Faint
                line.startsWith("@@") -> Color.Transparent to HunkFg
                line.startsWith("+") -> AddBg to AddFg
                line.startsWith("-") -> DelBg to DelFg
                line.startsWith("diff ") || line.startsWith("index ") -> Color.Transparent to Faint
                else -> Color.Transparent to Dim
            }
            Text(
                line.ifEmpty { " " },
                color = fg,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                modifier = Modifier.background(bg).padding(horizontal = 4.dp, vertical = 1.dp),
            )
        }
        if (patch.split('\n').size > 400) {
            Text(
                "… truncated at 400 lines",
                color = Faint,
                fontSize = 10.sp,
                modifier = Modifier.padding(4.dp),
            )
        }
    }
}
