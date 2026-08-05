package com.operator.simba

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily

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
    var diff by remember(sessionId) { mutableStateOf<SessionDiff?>(null) }
    var error by remember(sessionId) { mutableStateOf<String?>(null) }
    var loading by remember(sessionId) { mutableStateOf(true) }

    LaunchedEffect(sessionId) {
        runCatching { vm.api?.sessionDiff(sessionId) }
            .onSuccess { diff = it }
            .onFailure { error = it.message }
        loading = false
    }

    DiffView(diff, loading, error, onBack)
}

/**
 * What a session changed.
 *
 * No longer wrapped in [SimbaShell]. It used to bring its own shell because it
 * was launched as a full screen from inside chat; now it is pushed inside the
 * design's shell like every other detail view, and a shell inside a shell means
 * the status-bar and keyboard insets are applied twice and there are two pieces
 * of chrome stacked. Detail screens carry a back control and nothing else.
 */
@Composable
fun DiffView(
    diff: SessionDiff?,
    loading: Boolean,
    error: String?,
    onBack: () -> Unit,
) {
    LazyColumn(Modifier.fillMaxSize()) {
        item {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = space.gutter).padding(top = space.snug),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(space.snug),
            ) {
                BackButton(onBack)
                diff?.let { d ->
                    // Added and removed keep the convention, but they are this
                    // design's green and red rather than fixed hex.
                    Text("+${d.totalAdditions}", color = AddFg, style = type.label)
                    Text("−${d.totalDeletions}", color = DelFg, style = type.label)
                    d.branch?.let { Text(it, color = Faint, style = type.mono) }
                }
            }
        }

        val d = diff
        when {
            loading -> item { LoadingState(3) }
            error != null -> item { FailureState(error) }
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
                            Text("${d.files.size} files", style = type.caption, color = Faint)
                        }
                    }
                    items(d.files, key = { it.path }) { f ->
                        ItemRow(
                            // 42, not 46: at Fluid's gutter and card padding the row gives
                            // mono about 45 characters, so 46 was one over and the
                            // ellipsis ate the file extension — the one part of a
                            // path that has to survive truncation.
                            title = shortPath(f.path, pathBudget(42)),
                            mono = true,
                            meta = buildList {
                                if (f.additions > 0) add(ItemMeta("+${f.additions}", Tone.Good))
                                if (f.deletions > 0) add(ItemMeta("−${f.deletions}", Tone.Bad))
                                add(ItemMeta(statusLabel(f.status), if (f.status == "untracked") Tone.Warn else Tone.Neutral))
                            },
                            expanded = {
                                when {
                                    f.truncated -> Text(
                                        "Patch withheld — too large to send to the phone. " +
                                            "Review it on the machine.",
                                        color = Warn,
                                        style = type.caption,
                                    )
                                    f.patch.isNullOrBlank() -> Text(
                                        "No patch available.",
                                        color = Faint,
                                        style = type.caption,
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
                style = type.micro,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                modifier = Modifier.background(bg).padding(horizontal = space.tight, vertical = space.hair),
            )
        }
        if (patch.split('\n').size > 400) {
            Text(
                "… truncated at 400 lines",
                color = Faint,
                style = type.micro,
                modifier = Modifier.padding(space.tight),
            )
        }
    }
}
