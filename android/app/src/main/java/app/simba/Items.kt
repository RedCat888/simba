package com.operator.simba

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * One row of a list, rendered three genuinely different ways.
 *
 * The shells alone were not enough: three navigation models wrapped around the
 * identical card list is still mostly one app. Almost everything a person looks
 * at is *inside* a screen, so if rows render the same everywhere then so does
 * the app.
 *
 * Screens call [ItemRow] once and describe what the row *is* — a title, some
 * metadata, an optional expansion. How that becomes pixels is the design's
 * decision, which is why no screen imports a design or branches on one.
 *
 *   Fluid    — a large rounded card that expands in place with spring motion
 *              and dims its neighbours; nothing navigates away.
 *   Material — an ElevatedCard wrapping a real ListItem, with AssistChips for
 *              metadata, using the components Google actually specifies.
 *   Console  — one dense monospace line with no card at all, aligned so a list
 *              reads as a table and more rows fit on a screen.
 */

/** A small piece of metadata. Tone carries meaning; the design decides shape. */
data class ItemMeta(val text: String, val tone: Tone = Tone.Neutral)

enum class Tone { Neutral, Good, Warn, Bad, Accented }

@Composable
private fun Tone.color(): Color = when (this) {
    Tone.Neutral -> Faint
    Tone.Good -> Ok
    Tone.Warn -> Warn
    Tone.Bad -> Err
    Tone.Accented -> Accent
}

@Composable
fun ItemRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    meta: List<ItemMeta> = emptyList(),
    badge: ItemMeta? = null,
    leading: ImageVector? = null,
    onClick: (() -> Unit)? = null,
    /** Shown when the row is expanded. Null means the row does not expand. */
    expanded: (@Composable () -> Unit)? = null,
) {
    var open by remember { mutableStateOf(false) }
    val toggle: (() -> Unit)? = when {
        expanded != null -> ({ open = !open })
        else -> onClick
    }

    when (LocalDesign.current) {
        Design.Fluid -> FluidItem(title, modifier, subtitle, meta, badge, leading, toggle, open, expanded)
        Design.Material -> MaterialItem(title, modifier, subtitle, meta, badge, leading, toggle, open, expanded)
        Design.Console -> ConsoleItem(title, modifier, subtitle, meta, badge, toggle, open, expanded)
    }
}

/**
 * Fluid: the row is a surface that grows.
 *
 * Expansion happens in place rather than by navigating, because the point of
 * the design is that the thing you touched is the thing that changed. The press
 * scale is small and springy so a tap feels acknowledged before anything else
 * has happened.
 */
@Composable
private fun FluidItem(
    title: String,
    modifier: Modifier,
    subtitle: String?,
    meta: List<ItemMeta>,
    badge: ItemMeta?,
    leading: ImageVector?,
    onClick: (() -> Unit)?,
    open: Boolean,
    expanded: (@Composable () -> Unit)?,
) {
    val scale by animateFloatAsState(
        if (open) 1f else 0.995f,
        spring(dampingRatio = Spring.DampingRatioMediumBouncy),
        label = "item-scale",
    )
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 5.dp)
            .scale(scale)
            .clip(RoundedCornerShape(20.dp))
            .background(if (open) Panel2 else Panel)
            .let { if (onClick != null) it.clickable { onClick() } else it }
            .padding(18.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (leading != null) {
                Icon(leading, null, tint = Accent, modifier = Modifier.size(20.dp).padding(end = 0.dp))
                Spacer(Modifier.width(12.dp))
            }
            Text(
                title,
                color = Fg,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 21.sp,
                modifier = Modifier.weight(1f),
            )
            badge?.let {
                Text(
                    it.text,
                    color = it.tone.color(),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier
                        .clip(RoundedCornerShape(99.dp))
                        .background(it.tone.color().copy(alpha = 0.14f))
                        .padding(horizontal = 10.dp, vertical = 4.dp),
                )
            }
        }
        subtitle?.takeIf { it.isNotBlank() }?.let {
            Text(it, color = Dim, fontSize = 13.5.sp, lineHeight = 19.sp, modifier = Modifier.padding(top = 6.dp))
        }
        if (meta.isNotEmpty()) {
            Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                meta.forEach { Text(it.text, color = it.tone.color(), fontSize = 12.sp) }
            }
        }
        AnimatedVisibility(
            visible = open && expanded != null,
            enter = fadeIn(spring()) + expandVertically(spring(stiffness = Spring.StiffnessMediumLow)),
            exit = fadeOut() + shrinkVertically(),
        ) {
            Column(Modifier.padding(top = 14.dp)) { expanded?.invoke() }
        }
    }
}

/** Material: the components Google specifies, used as specified. */
@Composable
private fun MaterialItem(
    title: String,
    modifier: Modifier,
    subtitle: String?,
    meta: List<ItemMeta>,
    badge: ItemMeta?,
    leading: ImageVector?,
    onClick: (() -> Unit)?,
    open: Boolean,
    expanded: (@Composable () -> Unit)?,
) {
    ElevatedCard(
        modifier = modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
        onClick = onClick ?: {},
        enabled = onClick != null,
    ) {
        ListItem(
            headlineContent = { Text(title) },
            supportingContent = subtitle?.takeIf { it.isNotBlank() }?.let { { Text(it) } },
            leadingContent = leading?.let { { Icon(it, contentDescription = null) } },
            trailingContent = badge?.let {
                {
                    // Badges are Material's own component for exactly this, and
                    // reaching for a coloured Text instead is how an app ends up
                    // Material-flavoured rather than Material.
                    Text(
                        it.text,
                        style = MaterialTheme.typography.labelMedium,
                        color = it.tone.color(),
                    )
                }
            },
            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        )
        if (meta.isNotEmpty()) {
            Row(
                Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                meta.take(4).forEach {
                    AssistChip(
                        onClick = {},
                        label = { Text(it.text, fontSize = 11.sp) },
                        colors = AssistChipDefaults.assistChipColors(labelColor = it.tone.color()),
                    )
                }
            }
        }
        AnimatedVisibility(visible = open && expanded != null) {
            Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 14.dp)) { expanded?.invoke() }
        }
    }
}

/**
 * Console: a table, not a list of cards.
 *
 * No card, no elevation, no rounded corners — a card costs about 30dp of
 * vertical space per row for decoration, and in a tool where you are scanning
 * for the thing that is wrong, rows per screen is the metric that matters.
 * Metadata sits right-aligned in a fixed column so the eye can run down it.
 */
@Composable
private fun ConsoleItem(
    title: String,
    modifier: Modifier,
    subtitle: String?,
    meta: List<ItemMeta>,
    badge: ItemMeta?,
    onClick: (() -> Unit)?,
    open: Boolean,
    expanded: (@Composable () -> Unit)?,
) {
    Column(
        modifier
            .fillMaxWidth()
            .let { if (onClick != null) it.clickable { onClick() } else it }
            .background(if (open) Panel2 else Color.Transparent)
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            badge?.let {
                // A leading status glyph rather than a trailing pill: scanning
                // a column of states is the whole reason to render a table.
                Text(
                    it.text.take(3).lowercase(),
                    color = it.tone.color(),
                    fontSize = 10.5.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.width(30.dp),
                )
            }
            Text(
                title,
                color = Fg,
                fontSize = 12.5.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                modifier = Modifier.weight(1f),
            )
            meta.take(2).forEach {
                Text(
                    it.text,
                    color = it.tone.color(),
                    fontSize = 10.5.sp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
        }
        subtitle?.takeIf { it.isNotBlank() }?.let {
            Text(
                it,
                color = Dim,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = if (open) 6 else 1,
                modifier = Modifier.padding(start = if (badge != null) 30.dp else 0.dp),
            )
        }
        AnimatedVisibility(visible = open && expanded != null) {
            Column(Modifier.padding(top = 6.dp, start = if (badge != null) 30.dp else 0.dp)) {
                expanded?.invoke()
            }
        }
    }
}

/**
 * A section heading, which is also a design decision rather than a constant.
 * Fluid gives it air, Material uses the type scale, Console makes it a rule.
 */
@Composable
fun SectionHeading(text: String, trailing: (@Composable () -> Unit)? = null) {
    when (LocalDesign.current) {
        Design.Fluid -> Row(
            Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 18.dp, bottom = 6.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(text, color = Dim, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            trailing?.invoke()
        }

        Design.Material -> Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text,
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.primary,
            )
            trailing?.invoke()
        }

        Design.Console -> Row(
            Modifier.fillMaxWidth().background(Panel2).padding(horizontal = 10.dp, vertical = 3.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "-- ${text.lowercase()} " + "-".repeat((26 - text.length).coerceAtLeast(2)),
                color = Faint,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
            )
            trailing?.invoke()
        }
    }
}
