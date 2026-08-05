package com.operator.simba

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material3.*
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Material 3, used as Google specifies rather than as a coat of paint.
 *
 * The distinction matters because the previous "Material" design was this app's
 * own layout with dynamic colours poured over it, which is the most common way
 * to claim Material and not ship it. What actually makes an app feel like
 * Material is the component set and the structure they imply:
 *
 *   - A [LargeTopAppBar] that collapses as you scroll, via nestedScroll, so the
 *     title is generous at rest and compact when you are reading.
 *   - A real [NavigationBar] with the specified item behaviour, including the
 *     selection indicator pill that no hand-rolled bar reproduces correctly.
 *   - A [FloatingActionButton] carrying the primary action of each destination,
 *     which is the component that decides where the eye goes.
 *   - Surface elevation and tonal colour doing the layering, instead of borders.
 *
 * Adaptive by default too: at tablet width the bar becomes a [NavigationRail],
 * which is Material's own answer and something the other two shells do not do.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MaterialShell(
    current: Destination,
    onNavigate: (Destination) -> Unit,
    status: ShellStatus,
    content: @Composable (Destination) -> Unit,
) {
    val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(
        rememberTopAppBarState(),
    )
    val wide = LocalConfiguration.current.screenWidthDp >= 600

    Scaffold(
        modifier = Modifier.nestedScroll(scroll.nestedScrollConnection),
        topBar = {
            LargeTopAppBar(
                title = {
                    // Two lines inside the title slot: this Material version
                    // has no subtitle parameter, and inventing a status strip
                    // beside the app bar would be exactly the not-really-Material
                    // move this design exists to avoid.
                    Column {
                        Text(current.label)
                        Text(
                            buildString {
                                append(if (status.connected) "Connected" else "Offline")
                                if (status.activeSessions > 0) append(" · ${status.activeSessions} live")
                                if (status.brainsAvailable > 0) append(" · ${status.brainsAvailable} brains")
                            },
                            style = MaterialTheme.typography.labelMedium,
                        )
                    }
                },
                scrollBehavior = scroll,
                colors = TopAppBarDefaults.largeTopAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                    scrolledContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                ),
            )
        },
        bottomBar = {
            if (!wide) {
                NavigationBar {
                    Destination.entries.forEach { d ->
                        val on = d == current
                        NavigationBarItem(
                            selected = on,
                            onClick = { onNavigate(d) },
                            icon = {
                                Icon(
                                    if (on) d.rounded else d.outlined,
                                    contentDescription = d.label,
                                )
                            },
                            label = { Text(d.label) },
                            alwaysShowLabel = false,
                        )
                    }
                }
            }
        },
        floatingActionButton = {
            // One primary action per destination, which is the discipline the
            // FAB imposes and the reason Material apps feel decisive.
            val action = primaryActionFor(current)
            if (action != null) {
                ExtendedFloatingActionButton(
                    onClick = action.onClick,
                    icon = { Icon(Icons.Rounded.Add, contentDescription = null) },
                    text = { Text(action.label) },
                )
            }
        },
    ) { pad ->
        Row(Modifier.padding(pad).fillMaxSize()) {
            if (wide) {
                NavigationRail {
                    Destination.entries.forEach { d ->
                        val on = d == current
                        NavigationRailItem(
                            selected = on,
                            onClick = { onNavigate(d) },
                            icon = { Icon(if (on) d.rounded else d.outlined, d.label) },
                            label = { Text(d.label, style = type.caption) },
                        )
                    }
                }
            }
            Box(Modifier.weight(1f)) { content(current) }
        }
    }
}

/** The single most important thing you can do on each screen. */
private data class PrimaryAction(val label: String, val onClick: () -> Unit)

@Composable
private fun primaryActionFor(dest: Destination): PrimaryAction? = when (dest) {
    Destination.Chat -> PrimaryAction("New chat") { MaterialActions.newChat?.invoke() }
    Destination.Missions -> PrimaryAction("New mission") { MaterialActions.newMission?.invoke() }
    // Deliberately none. Now is a screen whose actions belong to the things on
    // it, and a FAB there would be a second answer to "what should I do" beside
    // the one the screen already gives. System is a place you read.
    Destination.Now, Destination.System -> null
}

/**
 * Where the shell's primary actions are wired.
 *
 * A shell should not import screen internals, and screens should not have to
 * know a FAB exists — only this design has one. Registering the handlers keeps
 * both true.
 */
object MaterialActions {
    var newChat: (() -> Unit)? = null
    var newMission: (() -> Unit)? = null
}

@Suppress("unused")
private val unusedWeight = FontWeight.Normal
