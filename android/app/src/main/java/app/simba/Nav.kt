package com.operator.simba

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Insights
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.Forum
import androidx.compose.material.icons.rounded.Hub
import androidx.compose.material.icons.rounded.Insights
import androidx.compose.material.icons.rounded.Terminal
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * Where you can go, separated from how you get there.
 *
 * The previous version had a single NavigationBar hard-coded into the root, so
 * every design was guaranteed to be the same app in different colours — the
 * navigation model *is* most of what makes an interface feel like itself, and
 * it was the one thing all three shared.
 *
 * Destinations are now data. Each design supplies its own shell, and those
 * shells are genuinely different structures rather than restyled copies:
 *
 *   Fluid    — no persistent bar. A floating morphing control that expands into
 *              the destination list, with spring motion and content that
 *              animates in place instead of cutting between screens.
 *   Material — Google's actual system, used as specified: NavigationBar,
 *              LargeTopAppBar with scroll behaviour, FAB for the primary
 *              action, M3 motion.
 *   Console  — no tabs at all. A command bar owns the bottom of the screen and
 *              everything is reachable by typing, with a dense status strip
 *              above it. Argued for below.
 */
enum class Destination(
    val label: String,
    /** Console addresses destinations by name typed into the command bar. */
    val command: String,
    /**
     * Console's icon: one character.
     *
     * Not a compromise — a terminal identifies things with sigils, and these are
     * the conventional ones (`@` an entity, `#` a system, `?` a query, `*` a job,
     * `>` a prompt). Dropping in Material glyphs here would undo the design.
     */
    val glyph: String,
    /** Material's own icons, because that is what the Material design is. */
    val rounded: ImageVector,
    val outlined: ImageVector,
    /** Fluid draws its own, in one stroke weight on one grid. See [SimbaIcons]. */
    val fluid: ImageVector,
) {
    Chat("Chat", "chat", ">", Icons.Rounded.Forum, Icons.Outlined.Forum, SimbaIcons.Chat),
    Missions("Missions", "missions", "*", Icons.Rounded.Bolt, Icons.Outlined.Bolt, SimbaIcons.Missions),
    Agents("Agents", "agents", "@", Icons.Rounded.Hub, Icons.Outlined.Hub, SimbaIcons.Agents),
    Knowledge("Knowledge", "know", "?", Icons.Rounded.Insights, Icons.Outlined.Insights, SimbaIcons.Knowledge),
    System("System", "sys", "#", Icons.Rounded.Terminal, Icons.Outlined.Terminal, SimbaIcons.System),
    ;

    companion object {
        fun match(input: String): Destination? {
            val q = input.trim().lowercase()
            if (q.isEmpty()) return null
            return entries.firstOrNull { it.command == q }
                ?: entries.firstOrNull { it.command.startsWith(q) }
                ?: entries.firstOrNull { it.label.lowercase().startsWith(q) }
        }
    }
}

/**
 * What a shell must provide. Deliberately small: a shell owns navigation,
 * chrome and motion, and nothing else, so screens do not need to know which
 * design is running.
 */
@Composable
fun DesignShell(
    design: Design,
    current: Destination,
    onNavigate: (Destination) -> Unit,
    /** Live status the shell may surface however it wants — or ignore. */
    status: ShellStatus,
    content: @Composable () -> Unit,
) {
    when (design) {
        Design.Fluid -> FluidShell(current, onNavigate, status, content)
        Design.Material -> MaterialShell(current, onNavigate, status, content)
        Design.Console -> ConsoleShell(current, onNavigate, status, content)
    }
}

/**
 * The handful of facts every shell might show.
 *
 * Passed as one object rather than as parameters so adding a fact does not
 * force all three shells to change; a shell shows what suits it and ignores
 * the rest, which is part of what makes them different designs.
 */
data class ShellStatus(
    val connected: Boolean = false,
    val activeSessions: Int = 0,
    val runningMissions: Int = 0,
    val brainsAvailable: Int = 0,
    val spend7d: Double = 0.0,
    val error: String? = null,
)
