package com.operator.simba

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import kotlinx.coroutines.delay

/**
 * One box, for when you remember asking but not what you called it.
 *
 * The failure this is built from: he asked to set up a "wifi thru walls"
 * project, then days later asked an agent to check progress and was told no
 * such project was tracked. Even after the request was recorded, finding it
 * needed curl — there were two searches in this system that could not see each
 * other and four surfaces with none at all.
 *
 * Results are not grouped by kind. Grouping would make you decide whether the
 * thing you half-remember is a request or a capture or a project before you can
 * find it, which is the decision a palette exists to remove. What they are
 * grouped by instead is whether they are still outstanding, because the question
 * behind almost every search here is "what happened to X".
 */
@Composable
fun FindScreen(vm: SimbaVm) {
    var q by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<List<Found>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }

    // Debounced, not per-keystroke. The gateway is a home PC behind a tunnel and
    // every character would be a round trip over it; 250ms is below the point a
    // pause feels like waiting and well above the typing rate.
    LaunchedEffect(q) {
        if (q.trim().length < 2) { results = emptyList(); return@LaunchedEffect }
        delay(250)
        searching = true
        runCatching { vm.api?.find(q.trim()) }
            .onSuccess { results = it ?: emptyList() }
            .onFailure { vm.error = it.message }
        searching = false
    }

    FindBody(q, results, searching, onChange = { q = it })
}

/**
 * Pure, so every state can be rendered and looked at without a gateway — which
 * matters most for the two states a search is actually judged on: before you
 * have typed anything, and when it finds nothing.
 */
@Composable
fun FindBody(
    q: String,
    results: List<Found>,
    searching: Boolean = false,
    onChange: (String) -> Unit = {},
) {
    Column(Modifier.fillMaxSize()) {
        SearchField(q, onChange = onChange)
        FindResults(q, results, searching)
    }
}

@Composable
private fun SearchField(q: String, onChange: (String) -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .screenPad()
            .padding(vertical = space.snug)
            .clip(RoundedCornerShape(radius.medium))
            .background(Inset)
            .padding(horizontal = space.gutter, vertical = space.base),
    ) {
        if (q.isEmpty()) {
            Text("Requests, captures, projects, sessions, missions", color = Faint, style = type.body)
        }
        BasicTextField(
            value = q,
            onValueChange = onChange,
            singleLine = true,
            textStyle = TextStyle(color = Fg, fontSize = type.body.fontSize),
            cursorBrush = SolidColor(Accent),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun FindResults(q: String, results: List<Found>, searching: Boolean) {
    val outstanding = results.filter { it.live }
    val closed = results.filter { !it.live }

    when {
        q.trim().length < 2 -> EmptyState(
            "Find anything",
            "Type a word you remember. It searches what you asked for, what you " +
                "shared in, your projects, and every session and mission by name.",
        )
        searching && results.isEmpty() -> LoadingState(rows = 3)
        results.isEmpty() -> EmptyState(
            "Nothing matches \"${q.trim()}\"",
            // Naming the one thing this box deliberately does not cover, since
            // otherwise "nothing matches" reads as "you never mentioned it".
            "This searches operational records. Notes, conversations and the " +
                "vault are under Knowledge.",
        )
        else -> LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(bottom = space.page),
        ) {
            if (outstanding.isNotEmpty()) {
                item { SectionHeading("Still open") }
                items(outstanding, key = { it.kind + it.id }) { FoundRow(it) }
            }
            if (closed.isNotEmpty()) {
                // Not "Done": a project is never done, and a session that ended
                // is not the same kind of finished as a request that was
                // answered. The only thing these actually share is that none of
                // them is waiting on anything.
                item { SectionHeading(if (outstanding.isEmpty()) "Found" else "Everything else") }
                items(closed, key = { it.kind + it.id }) { FoundRow(it) }
            }
        }
    }
}

@Composable
private fun FoundRow(f: Found) {
    ItemRow(
        title = f.title,
        subtitle = f.subtitle?.takeIf { it.isNotBlank() && it != f.title },
        // The kind leads the metadata rather than the badge, because it is what
        // tells you where the thing lives — which is usually what you wanted to
        // know when you went looking for it.
        meta = buildList {
            add(ItemMeta(f.kind, Tone.Accented))
            f.status?.takeIf { it.isNotBlank() }?.let { add(ItemMeta(it, statusTone(it))) }
            f.whenAt?.let { add(ItemMeta(ago(it))) }
        },
    )
}

/** Only the states that mean something needs doing get a colour. */
private fun statusTone(status: String): Tone = when (status) {
    "open", "pending", "blocked" -> Tone.Warn
    "running", "idle" -> Tone.Good
    "failed", "rejected" -> Tone.Bad
    else -> Tone.Neutral
}
