package com.operator.simba

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Fluid: motion is the interface.
 *
 * There is no persistent navigation bar. A single floating control sits over
 * the content and *becomes* the destination list when touched — the same
 * surface morphing rather than a menu appearing on top of one. Destination
 * changes cross-fade with a slight scale, so moving between areas reads as the
 * same space rearranging instead of a hard cut between screens.
 *
 * The argument for it: on a phone held one-handed, the thumb arc is the bottom
 * third of the screen and permanent chrome there is permanently in the way. A
 * control that is small until wanted gives that space back to the content, and
 * motion is what makes it legible — without it, things appearing and vanishing
 * is just confusing.
 *
 * Everything here uses spring physics rather than fixed-duration curves.
 * Springs settle in proportion to how far they travelled, which is what makes
 * an interface feel responsive to *you* rather than played back at you.
 */
@Composable
fun FluidShell(
    current: Destination,
    onNavigate: (Destination) -> Unit,
    status: ShellStatus,
    content: @Composable (Destination) -> Unit,
) {
    var open by remember { mutableStateOf(false) }

    SimbaShell(
        header = {
            // An expressive header that shrinks to nothing rather than a bar
            // that is always there. The destination name is the largest thing
            // on screen for a moment, then the content takes over.
            AnimatedContent(
                targetState = current,
                transitionSpec = {
                    (fadeIn(tween(220)) + expandVertically(spring(stiffness = Spring.StiffnessLow)))
                        .togetherWith(fadeOut(tween(120)) + shrinkVertically())
                },
                label = "fluid-header",
            ) { dest ->
                Column(Modifier.fillMaxWidth().padding(start = space.roomy, end = space.roomy, top = space.base, bottom = space.tight)) {
                    Text(
                        dest.label,
                        style = type.display,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = (-0.8).sp,
                        color = Fg,
                    )
                    Row(
                        Modifier.padding(top = space.hair),
                        horizontalArrangement = Arrangement.spacedBy(space.base),
                    ) {
                        StatusDot(status.connected)
                        if (status.activeSessions > 0) {
                            Text("${status.activeSessions} live", style = type.label, color = Accent)
                        }
                        if (status.runningMissions > 0) {
                            Text("${status.runningMissions} running", style = type.label, color = Faint)
                        }
                    }
                }
            }
        },
        floating = {
            FluidNav(current, open, onToggle = { open = !open }) {
                open = false
                onNavigate(it)
            }
        },
    ) {
        // Content itself cross-fades, so a destination change reads as one
        // space rearranging rather than a page swap. The lambda renders the
        // destination it is *given*, not the current one — otherwise both
        // halves of the transition are the same screen and nothing crosses.
        AnimatedContent(
            targetState = current,
            transitionSpec = {
                (fadeIn(tween(260)) togetherWith fadeOut(tween(160)))
            },
            label = "fluid-content",
        ) { dest ->
            Box(Modifier.fillMaxSize()) { content(dest) }
        }
    }
}

/**
 * The morphing control.
 *
 * Closed it is a pill showing where you are. Open it expands upward into the
 * full list, in place, with the pill's own corner radius and width animating
 * rather than a sheet sliding over the top. That continuity is the whole point:
 * the thing you touched is the thing that grew.
 */
@Composable
private fun FluidNav(
    current: Destination,
    open: Boolean,
    onToggle: () -> Unit,
    onPick: (Destination) -> Unit,
) {
    val radius by animateDpAsState(
        if (open) 26.dp else 30.dp,
        spring(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMediumLow),
        label = "radius",
    )
    val scrimAlpha by animateFloatAsState(if (open) 0.55f else 0f, tween(220), label = "scrim")

    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.BottomCenter) {
        if (scrimAlpha > 0.01f) {
            Box(
                Modifier.fillMaxSize().alpha(scrimAlpha).background(Color.Black)
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = onToggle,
                    ),
            )
        }

        Column(
            Modifier
                .padding(bottom = space.roomy)
                .clip(RoundedCornerShape(radius))
                .background(
                    Brush.verticalGradient(listOf(Panel2, Panel)),
                )
                .animateContentSize(spring(stiffness = Spring.StiffnessMediumLow)),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (open) {
                Destination.entries.forEach { d ->
                    val on = d == current
                    val tint by animateColorAsState(if (on) Accent else Dim, label = "tint")
                    Row(
                        Modifier
                            .widthIn(min = 226.dp)
                            .clickable { onPick(d) }
                            .padding(horizontal = space.roomy, vertical = space.base),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(space.base),
                    ) {
                        Icon(
                            d.fluid,
                            contentDescription = d.label,
                            tint = tint,
                            modifier = Modifier.size(21.dp),
                        )
                        Text(
                            d.label,
                            color = tint,
                            style = type.body,
                            fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                        )
                    }
                }
                Row(
                    Modifier.clickable { onToggle() }.padding(vertical = space.base),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // A handle rather than a cross: the sheet is being put
                    // back, not dismissed, and the shape says which.
                    Box(
                        Modifier
                            .width(34.dp)
                            .height(3.dp)
                            .clip(RoundedCornerShape(99.dp))
                            .background(Faint),
                    )
                }
            } else {
                val pressed = remember { mutableStateOf(false) }
                val scale by animateFloatAsState(
                    if (pressed.value) 0.94f else 1f,
                    spring(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMedium),
                    label = "press",
                )
                Row(
                    Modifier
                        .scale(scale)
                        .clickable { onToggle() }
                        .padding(horizontal = space.roomy, vertical = space.base),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(space.snug),
                ) {
                    Icon(
                        current.fluid,
                        contentDescription = current.label,
                        tint = Accent,
                        modifier = Modifier.size(19.dp),
                    )
                    Text(current.label, color = Fg, style = type.body, fontWeight = FontWeight.Medium)
                }
            }
        }
    }
}

@Composable
private fun StatusDot(connected: Boolean) {
    val c by animateColorAsState(if (connected) Ok else Err, label = "dot")
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(space.tight)) {
        Box(Modifier.size(6.dp).clip(RoundedCornerShape(99.dp)).background(c))
        Text(if (connected) "connected" else "offline", style = type.label, color = Faint)
    }
}

