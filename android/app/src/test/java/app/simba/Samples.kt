package com.operator.simba

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable

/**
 * Fixtures for the render test.
 *
 * Deliberately not fetched and not faked at the API layer: these exist to
 * exercise the *drawing*, and a screen that needs a gateway to be looked at is
 * a screen nobody looks at. The values are chosen to hit the cases that
 * actually break layouts — a title long enough to wrap, an empty subtitle, a
 * badge on a row that also has metadata, an expansion.
 */
@Composable
fun SampleRows() {
    Column(Modifier7, verticalArrangement = Arrangement.Top) {
        SectionHeading("Missions")
        ItemRow(
            title = "Port the Hermes self-improvement loop so agents write their own skills",
            subtitle = "Planning · deciding which of the fourteen behaviours are worth carrying over",
            meta = listOf(
                ItemMeta("3/9 steps"),
                ItemMeta("2 failed", Tone.Warn),
                ItemMeta("$0.00", Tone.Good),
            ),
            badge = ItemMeta("running", Tone.Good),
            onClick = {},
        )
        ItemRow(
            title = "Nightly Obsidian sync",
            meta = listOf(ItemMeta("exit 0", Tone.Good), ItemMeta("every day at 07:00")),
            badge = ItemMeta("script", Tone.Accented),
            onClick = {},
        )
        ItemRow(
            title = "raw-postgres-wire-protocol-in-node",
            subtitle = "How to speak the v3 protocol directly when no driver is installed.",
            meta = listOf(ItemMeta("never used", Tone.Warn), ItemMeta("1420 chars")),
            badge = ItemMeta("learned", Tone.Accented),
            expanded = { SectionHeading("Body") },
        )
    }
}

@Composable
fun SampleChat() {
    Column(Modifier7) {
        SectionHeading("Conversation")
        ItemRow(
            title = "Simba",
            subtitle = "The tunnel is up and three brains verified clean. One mission is blocked on budget.",
            meta = listOf(ItemMeta("claude"), ItemMeta("live", Tone.Good)),
        )
        EmptyState("Nothing else yet", "Send a message and it will appear here.")
    }
}

/** Named rather than inlined so both fixtures share one width contract. */
private val Modifier7 = androidx.compose.ui.Modifier.fillMaxWidth()
