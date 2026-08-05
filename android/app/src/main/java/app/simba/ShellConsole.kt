package com.operator.simba

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Console: the operator's cockpit. My own concept, and the argument for it.
 *
 * Simba is not a content app. It is an operations system for a machine that
 * works while nobody is watching, and the questions it exists to answer are
 * "what is running", "what broke", "make it stop". Tabbed navigation is built
 * for browsing — it optimises for discovering what an app contains, which is a
 * problem you have once. An operator has the opposite problem: they know
 * exactly where they want to be and are made to tap through a hierarchy to get
 * there, every time, usually while something is going wrong.
 *
 * So there are no tabs. A command bar owns the bottom of the screen, where the
 * thumb already is: type `sys`, `missions`, `chat`. Above it sits a permanent
 * status strip, because in an ops tool the state of the system is not something
 * you navigate to — it is the frame everything else is read inside. Density is
 * deliberate: more rows per screen means fewer scrolls between you and the
 * thing that is wrong.
 *
 * This is the design I would use myself. It is also the one that would be wrong
 * for most apps, which is rather the point of it being a distinct concept
 * rather than a third colour scheme.
 */
@Composable
fun ConsoleShell(
    current: Destination,
    onNavigate: (Destination) -> Unit,
    status: ShellStatus,
    content: @Composable (Destination) -> Unit,
) {
    var command by remember { mutableStateOf("") }
    val suggestion = remember(command) { Destination.match(command) }

    SimbaShell(
        header = {
            // The status strip. Permanent, monospace, single line: what is
            // true right now, without navigating anywhere to ask.
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(Panel)
                    .padding(horizontal = space.snug, vertical = space.tight),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(space.snug),
            ) {
                Field("net", if (status.connected) "up" else "down", if (status.connected) Ok else Err)
                Field("run", status.activeSessions.toString(), if (status.activeSessions > 0) Accent else Dim)
                Field("msn", status.runningMissions.toString(), if (status.runningMissions > 0) Accent else Dim)
                Field("brn", status.brainsAvailable.toString(), Dim)
                Spacer(Modifier.weight(1f))
                Field("7d", "$" + "%.2f".format(status.spend7d), Dim)
            }
            status.error?.let {
                Text(
                    "! ${it.take(72)}",
                    color = Err,
                    style = type.micro,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.fillMaxWidth().background(Panel2).padding(horizontal = space.snug, vertical = space.hair),
                )
            }
        },
        bottomBar = {
            Column(Modifier.fillMaxWidth().background(Panel)) {
                // Jump targets as chips: typing is fastest once you know the
                // words, and these are how you learn them. They are not tabs —
                // they scroll away with the command, and the command wins.
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = space.snug, vertical = space.tight),
                    horizontalArrangement = Arrangement.spacedBy(space.tight),
                ) {
                    Destination.entries.forEach { d ->
                        val on = d == current
                        Text(
                            d.glyph + d.command,
                            style = type.caption,
                            fontFamily = FontFamily.Monospace,
                            fontWeight = if (on) FontWeight.Bold else FontWeight.Normal,
                            color = if (on) Bg else Dim,
                            modifier = Modifier
                                .clip(RoundedCornerShape(3.dp))
                                .background(if (on) Accent else Panel2)
                                .clickable { onNavigate(d) }
                                .padding(horizontal = space.snug, vertical = space.tight),
                        )
                    }
                }

                Row(
                    Modifier.fillMaxWidth().padding(horizontal = space.snug, vertical = space.snug),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "simba",
                        color = Accent,
                        style = type.label,
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        ">",
                        color = Accent,
                        style = type.label,
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(start = space.hair),
                    )
                    BasicTextField(
                        value = command,
                        onValueChange = { command = it },
                        singleLine = true,
                        textStyle = type.label.copy(
                            color = Fg,
                            fontFamily = FontFamily.Monospace,
                        ),
                        cursorBrush = androidx.compose.ui.graphics.SolidColor(Accent),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                        keyboardActions = KeyboardActions(
                            onGo = {
                                suggestion?.let { onNavigate(it) }
                                command = ""
                            },
                        ),
                        modifier = Modifier.weight(1f).padding(start = space.tight),
                    )
                    // Inline completion, so the command language is learnable
                    // by using it rather than by reading documentation.
                    suggestion?.takeIf { command.isNotBlank() && it.command != command }?.let {
                        Text(
                            it.command,
                            color = Faint,
                            style = type.label,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
            }
        },
    ) {
        content(current)
    }
}

/** One `label=value` pair in the status strip. */
@Composable
private fun Field(label: String, value: String, tint: androidx.compose.ui.graphics.Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = Faint, style = type.micro, fontFamily = FontFamily.Monospace)
        Text(
            value,
            color = tint,
            style = type.caption,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(start = space.hair),
        )
    }
}
