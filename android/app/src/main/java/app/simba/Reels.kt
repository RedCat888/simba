package com.operator.simba

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import kotlinx.coroutines.delay

/**
 * The reel pipeline, from the phone.
 *
 * the operator shares a reel to the bot's Instagram account and a headless Claude
 * session downloads it, pulls keyframes, transcribes the audio, works out what
 * it actually is — a repo, an opportunity, a recipe — and writes it up. The
 * answer comes back as a DM. That loop worked, and then the PC rebooted on the
 * 25th of July and nothing started it again, so for eleven days the reels went
 * into a mailbox nobody was reading.
 *
 * Which is why this screen leads with whether the pipeline is *running* rather
 * than with the list. A list of twelve processed reels looks identical whether
 * the thing is healthy or has been dead for a week — the difference only shows
 * in what is missing, and missing things are exactly what a list cannot show.
 */
@Composable
fun ReelsScreen(vm: SimbaVm, onOpen: (String) -> Unit) {
    var feed by remember { mutableStateOf<ReelFeed?>(null) }
    var failed by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        val api = vm.api ?: return
        runCatching { api.reels() }
            .onSuccess { feed = it; failed = null }
            .onFailure { failed = it.message ?: "could not reach the gateway" }
    }
    LaunchedEffect(vm.api) { load() }
    // Faster than the Now screen's poll: when a backlog is draining, the counts
    // are the interesting part and they move every few minutes.
    LaunchedEffect(vm.api) { while (true) { delay(20_000); load() } }

    val current = feed
    when {
        current != null -> ReelsBody(current, onOpen)
        failed != null -> FailureState(failed!!)
        else -> LoadingState()
    }
}

/** Pure, so it can be rendered in a test without a gateway. */
@Composable
fun ReelsBody(feed: ReelFeed, onOpen: (String) -> Unit) {
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = space.page),
        verticalArrangement = Arrangement.spacedBy(space.hair),
    ) {
        item { PipelineState(feed) }

        // No empty state when the pipeline is off: the row above has already
        // said so, and saying it twice reads as two separate problems.
        if (feed.items.isEmpty() && feed.reachable) {
            item {
                EmptyState(
                    "Nothing processed yet",
                    "Share a reel to the bot account and it appears here.",
                )
            }
        } else if (feed.items.isNotEmpty()) {
            item { SectionHeading("Processed") }
            items(feed.items, key = { it.id }) { reel ->
                ItemRow(
                    title = reel.title,
                    subtitle = reel.summary,
                    meta = listOfNotNull(
                        ItemMeta(received(reel.received)),
                        if (reel.frames > 0) ItemMeta("${reel.frames} frames") else null,
                        if (reel.hasNotes) ItemMeta("notes") else null,
                    ),
                    // A finished item is the ordinary case and gets no badge; the
                    // one worth flagging is the item still in the machine.
                    badge = if (reel.done) null else ItemMeta("working", Tone.Warn),
                    onClick = { onOpen(reel.id) },
                )
            }
        }
    }
}

/**
 * Is the pipeline alive, and what is it holding?
 *
 * `owed` is the number that matters and the one that did not exist before: an
 * event stays owed from the moment it is seen until its work is confirmed
 * finished, so it survives a crash and counts the backlog honestly.
 */
@Composable
private fun PipelineState(feed: ReelFeed) {
    val h = feed.health
    if (!feed.reachable) {
        ItemRow(
            title = "Reel agent is not running",
            subtitle = "Reels shared to Instagram are not being picked up. Nothing is lost — " +
                "they are read from the DM history when it starts again.",
            badge = ItemMeta("off", Tone.Bad),
        )
        return
    }
    ItemRow(
        title = if ((h?.working ?: 0) > 0) "Working" else "Idle, waiting for reels",
        subtitle = h?.loggedInAs?.let { "listening as @$it" },
        meta = listOfNotNull(
            if ((h?.working ?: 0) > 0) ItemMeta("${h?.working} in progress", Tone.Accented) else null,
            if ((h?.owed ?: 0) > 0) ItemMeta("${h?.owed} queued", Tone.Warn) else null,
            ItemMeta("${feed.items.size} done", Tone.Good),
        ),
        badge = ItemMeta("live", Tone.Good),
    )
}

/**
 * One reel's writeup.
 *
 * `status` is the short version — the text that was DM'd back, under 900
 * characters by design. `notes` is the long one. The source material below them
 * is what the analysis was built from, collapsed by default because a
 * transcript is rarely what you came for but occasionally the only thing that
 * settles whether the summary got it right.
 */
@Composable
fun ReelDetailScreen(vm: SimbaVm, id: String, onBack: () -> Unit) {
    var detail by remember { mutableStateOf<ReelDetail?>(null) }
    var failed by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(id, vm.api) {
        val api = vm.api ?: return@LaunchedEffect
        runCatching { api.reel(id) }
            .onSuccess { detail = it }
            .onFailure { failed = it.message ?: "could not load this reel" }
    }

    Column(Modifier.fillMaxSize()) {
        BackButton(onBack)
        val d = detail
        when {
            d != null -> ReelDetailBody(d)
            failed != null -> FailureState(failed!!)
            else -> LoadingState(rows = 3)
        }
    }
}

@Composable
fun ReelDetailBody(d: ReelDetail) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = space.page),
    ) {
        d.status?.takeIf { it.isNotBlank() }?.let {
            SectionHeading("Verdict")
            Text(
                it.trim(),
                color = Fg,
                style = type.body,
                modifier = Modifier.fillMaxWidth().screenPad().padding(vertical = space.snug),
            )
        }

        d.sourceUrl?.takeIf { it.isNotBlank() }?.let {
            ItemRow(title = it, mono = true, leading = null)
        }

        d.notes?.takeIf { it.isNotBlank() }?.let {
            SectionHeading("Full notes")
            Text(
                it.trim(),
                color = Dim,
                style = type.bodySmall,
                modifier = Modifier.fillMaxWidth().screenPad().padding(vertical = space.snug),
            )
        }

        // The raw material, folded away. Present because the writeup is a
        // reading of it and sometimes the reading is what you want to check.
        val sources = listOfNotNull(
            d.caption?.takeIf { it.isNotBlank() }?.let { "Caption" to it },
            d.transcript?.takeIf { it.isNotBlank() }?.let { "Transcript" to it },
            d.comments?.takeIf { it.isNotBlank() }?.let { "Top comments" to it },
        )
        if (sources.isNotEmpty()) {
            SectionHeading("Source")
            sources.forEach { (label, body) ->
                ItemRow(
                    title = label,
                    subtitle = body.take(80).replace('\n', ' '),
                    expanded = {
                        Text(body.trim(), color = Dim, style = type.bodySmall)
                    },
                )
            }
        }
    }
}

/**
 * `20260805-193037` → `5 Aug 19:30`.
 *
 * The folder name is the timestamp, which makes it the one piece of metadata
 * guaranteed to exist even for an item whose processing never finished.
 */
fun received(stamp: String): String {
    val digits = stamp.filter { it.isDigit() }
    if (digits.length < 12) return stamp
    val months = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun",
                        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    val month = digits.substring(4, 6).toIntOrNull() ?: return stamp
    if (month !in 1..12) return stamp
    val day = digits.substring(6, 8).trimStart('0').ifEmpty { "0" }
    return "$day ${months[month - 1]} ${digits.substring(8, 10)}:${digits.substring(10, 12)}"
}
