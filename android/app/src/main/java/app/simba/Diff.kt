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
import androidx.compose.runtime.ReadOnlyComposable
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

/**
 * Diff colours derived from the active theme rather than hardcoded.
 *
 * These were five fixed hex values, which meant a diff rendered identically in
 * every design and ignored the palette completely - exactly the kind of detail
 * that makes an app feel assembled rather than designed. Added and removed stay
 * green and red because that convention is older than the app and breaking it
 * would cost legibility for nothing, but they are now *this* design's green and
 * red, and the row tints are derived from them so they sit correctly on each
 * design's background.
 */
private val AddFg: Color @Composable @ReadOnlyComposable get() = Ok
private val DelFg: Color @Composable @ReadOnlyComposable get() = Err
private val HunkFg: Color @Composable @ReadOnlyComposable get() = Info
private val AddBg: Color @Composable @ReadOnlyComposable get() = Ok.copy(alpha = 0.10f)
private val DelBg: Color @Composable @ReadOnlyComposable get() = Err.copy(alpha = 0.10f)

@Composable
fun DiffScreen(vm: SimbaVm, sessionId: String, onBack: () -> Unit) {
    var diff by remember { mutableStateOf<SessionDiff?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }

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
        LazyColumn(Modifier.fillMaxSize()) {
            val d = diff
            when {
                loading -> item { LoadingState(3) }
                error != null -> item { FailureState(error!!) }
                d == null || (d.files.isEmpty() && d.commits.isEmpty()) -> item {
                    EmptyState(
                        "Nothing changed",
                        "This session's working tree is clean — it read, reasoned or ran things, but wrote no files.",
                    )
                }

                else -> {
                    if (d.commits.isNotEmpty()) {
                        item { SectionHeading("Commits") }
                        items(d.commits, key = { it.sha }) { c ->
                            ItemRow(title = c.subject, meta = listOf(ItemMeta(c.sha, Tone.Accented)))
                        }
                    }

                    if (d.files.isNotEmpty()) {
                        item {
                            SectionHeading("Uncommitted") {
                                Text("${d.files.size} files", fontSize = 11.sp, color = Faint)
                            }
                        }
                        items(d.files, key = { it.path }) { f ->
                            ItemRow(
                                title = shortPath(f.path, 46),
                                meta = buildList {
                                    if (f.additions > 0) add(ItemMeta("+${f.additions}", Tone.Good))
                                    if (f.deletions > 0) add(ItemMeta("−${f.deletions}", Tone.Bad))
                                    add(ItemMeta(f.status, if (f.status == "untracked") Tone.Warn else Tone.Neutral))
                                },
                                expanded = {
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
                                },
                            )
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
