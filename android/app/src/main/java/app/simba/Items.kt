package com.operator.simba

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
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

/**
 * Console's status column, shared by the row, its subtitle and its expansion so
 * everything below the title lines up under it rather than merely near it.
 */
private val STATUS_COLUMN = 62.dp

/** A small piece of metadata. Tone carries meaning; the design decides shape. */
data class ItemMeta(val text: String, val tone: Tone = Tone.Neutral)

enum class Tone { Neutral, Good, Warn, Bad, Accented }

/** The colour a tone means in this design. Public so hero surfaces match rows. */
@Composable
fun Tone.color(): Color = when (this) {
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
    // 0.985 rather than 0.995: the old value moved a 368dp card by 1.8dp, which
    // is under two device pixels and cannot be seen. No bounce — a row settling
    // into place is an acknowledgement, and an acknowledgement that wobbles
    // reads as an animation rather than as a response.
    val scale by animateFloatAsState(
        if (open) 1f else 0.985f,
        spring(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMedium),
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
                style = type.heading,
                modifier = Modifier.weight(1f),
            )
            badge?.let {
                Text(
                    it.text,
                    color = it.tone.color(),
                    style = type.label,
                    modifier = Modifier
                        .clip(RoundedCornerShape(99.dp))
                        .background(it.tone.color().copy(alpha = 0.14f))
                        .padding(horizontal = 10.dp, vertical = 4.dp),
                )
            }
        }
        subtitle?.takeIf { it.isNotBlank() }?.let {
            Text(it, color = Dim, style = type.bodySmall, modifier = Modifier.padding(top = space.snug))
        }
        if (meta.isNotEmpty()) {
            Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                meta.forEach { Text(it.text, color = it.tone.color(), style = type.caption) }
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
                        label = { Text(it.text, style = type.caption) },
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
                // A leading status column rather than a trailing pill: scanning
                // a column of states is the whole reason to render a table.
                // Wide enough for the longest status this app actually produces
                // ("verifying", "cancelled"), because a status abbreviated to
                // three letters is not a status.
                Text(
                    it.text.lowercase(),
                    color = it.tone.color(),
                    style = type.micro,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.width(STATUS_COLUMN),
                )
            }
            Text(
                title,
                color = Fg,
                style = type.body,
                maxLines = 1,
                // Without this a long title is chopped mid-word with nothing to
                // mark it, so a truncated name reads as the whole name.
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            // One column, not two. Two fixed-width columns beside a status
            // column left the title with almost nothing on a phone, and the
            // second value overran the padding into the screen edge. The first
            // piece of metadata is the one screens put first because it is the
            // one that matters.
            meta.firstOrNull()?.let {
                Text(
                    it.text,
                    color = it.tone.color(),
                    style = type.micro,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(start = space.snug).widthIn(max = 96.dp),
                )
            }
        }
        subtitle?.takeIf { it.isNotBlank() }?.let {
            Text(
                it,
                color = Dim,
                style = type.caption.copy(fontFamily = FontFamily.Monospace),
                maxLines = if (open) 6 else 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = if (badge != null) STATUS_COLUMN else 0.dp),
            )
        }
        // The rest of the metadata, on its own line, where there is room for it
        // rather than in competition with the title.
        if (meta.size > 1) {
            Row(
                Modifier.padding(start = if (badge != null) STATUS_COLUMN else 0.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                meta.drop(1).forEach {
                    Text(
                        it.text,
                        color = it.tone.color(),
                        style = type.micro,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        AnimatedVisibility(visible = open && expanded != null) {
            Column(Modifier.padding(top = 6.dp, start = if (badge != null) STATUS_COLUMN else 0.dp)) {
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
            Text(text, color = Dim, style = type.label)
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
                style = type.micro,
            )
            trailing?.invoke()
        }
    }
}


/**
 * What a list says when it has nothing in it.
 *
 * A list that renders nothing when empty looks exactly like one that failed to
 * load, and making someone wonder "is this broken or is there genuinely
 * nothing?" is a question no finished product asks. The second line matters as
 * much as the first: knowing *why* it is empty is usually what someone actually
 * needed.
 */
@Composable
fun EmptyState(title: String, detail: String? = null) {
    when (LocalDesign.current) {
        Design.Console -> Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 14.dp)) {
            Text("-- empty --", color = Faint, style = type.caption.copy(fontFamily = FontFamily.Monospace))
            Text(
                title.lowercase(),
                color = Dim,
                style = type.body,
                modifier = Modifier.padding(top = space.tight),
            )
            detail?.let {
                Text(
                    it,
                    color = Faint,
                    style = type.caption.copy(fontFamily = FontFamily.Monospace),
                    modifier = Modifier.padding(top = space.hair),
                )
            }
        }

        else -> Column(
            Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 44.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                title,
                color = Dim,
                style = type.body,
                fontWeight = FontWeight.Medium,
                textAlign = TextAlign.Center,
            )
            detail?.let {
                Text(
                    it,
                    color = Faint,
                    style = type.bodySmall,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
    }
}


/**
 * Switching between facets of one screen.
 *
 * Distinct from navigation: these are views of a single question, so they stay
 * inside the screen rather than becoming destinations. Rendered per design for
 * the same reason rows are - a Material segmented button inside the Console
 * design is exactly the kind of borrowed component that makes three designs
 * collapse back into one.
 *
 *   Fluid    - a sliding capsule; the selection moves rather than blinking.
 *   Material - the real SingleChoiceSegmentedButtonRow, themed by the scheme.
 *   Console  - bracketed words, the way a TUI shows modes.
 */
@Composable
fun FacetRow(labels: List<String>, selected: Int, onSelect: (Int) -> Unit) {
    when (LocalDesign.current) {
        Design.Fluid -> Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .clip(RoundedCornerShape(99.dp))
                .background(Panel)
                .padding(4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            labels.forEachIndexed { i, label ->
                val on = i == selected
                val bg by animateColorAsState(
                    if (on) Accent.copy(alpha = 0.18f) else Color.Transparent,
                    label = "facet-bg",
                )
                val fg by animateColorAsState(if (on) Accent else Faint, label = "facet-fg")
                Box(
                    Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(99.dp))
                        .background(bg)
                        .clickable { onSelect(i) }
                        .padding(vertical = 8.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        label,
                        color = fg,
                        style = type.label,
                        fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                    )
                }
            }
        }

        Design.Material -> SingleChoiceSegmentedButtonRow(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            labels.forEachIndexed { i, label ->
                SegmentedButton(
                    selected = i == selected,
                    onClick = { onSelect(i) },
                    shape = SegmentedButtonDefaults.itemShape(i, labels.size),
                ) { Text(label, style = MaterialTheme.typography.labelLarge) }
            }
        }

        Design.Console -> Row(
            Modifier.fillMaxWidth().background(Panel).padding(horizontal = 10.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            labels.forEachIndexed { i, label ->
                val on = i == selected
                Text(
                    if (on) "[${label.lowercase()}]" else " ${label.lowercase()} ",
                    color = if (on) Accent else Faint,
                    style = type.label.copy(fontFamily = FontFamily.Monospace),
                    fontWeight = if (on) FontWeight.Bold else FontWeight.Normal,
                    modifier = Modifier.clickable { onSelect(i) },
                )
            }
        }
    }
}

/**
 * Waiting.
 *
 * A spinner in the middle of an empty screen tells you nothing except that
 * something is happening somewhere. Fluid shows placeholder rows that pulse in
 * the shape of the content about to arrive, so the layout does not jump when it
 * does; Console prints a line, because that is what a terminal does; Material
 * uses its own indicator, which is the point of Material.
 */
@Composable
fun LoadingState(rows: Int = 4) {
    when (LocalDesign.current) {
        Design.Fluid -> {
            val pulse = rememberInfiniteTransition(label = "skeleton")
            val alpha by pulse.animateFloat(
                initialValue = 0.35f,
                targetValue = 0.7f,
                animationSpec = infiniteRepeatable(
                    tween(900, easing = LinearEasing),
                    RepeatMode.Reverse,
                ),
                label = "skeleton-alpha",
            )
            Column(Modifier.fillMaxWidth()) {
                repeat(rows) { i ->
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 5.dp)
                            .clip(RoundedCornerShape(20.dp))
                            .background(Panel.copy(alpha = alpha))
                            .padding(18.dp),
                    ) {
                        Box(
                            Modifier
                                .fillMaxWidth(if (i % 2 == 0) 0.55f else 0.42f)
                                .height(13.dp)
                                .clip(RoundedCornerShape(99.dp))
                                .background(Panel2),
                        )
                        Spacer(Modifier.height(9.dp))
                        Box(
                            Modifier
                                .fillMaxWidth(if (i % 2 == 0) 0.85f else 0.7f)
                                .height(10.dp)
                                .clip(RoundedCornerShape(99.dp))
                                .background(Panel2.copy(alpha = 0.6f)),
                        )
                    }
                }
            }
        }

        Design.Material -> Box(Modifier.fillMaxWidth().padding(vertical = 48.dp), Alignment.Center) {
            CircularProgressIndicator()
        }

        Design.Console -> Text(
            "... loading",
            color = Faint,
            style = type.caption.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier.fillMaxWidth().padding(horizontal = space.gutter, vertical = space.base),
        )
    }
}

/** A failure a screen could not recover from, said the way each design says things. */
@Composable
fun FailureState(message: String, onRetry: (() -> Unit)? = null) {
    when (LocalDesign.current) {
        Design.Console -> Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 10.dp)) {
            Text("! $message", color = Err, style = type.bodySmall.copy(fontFamily = FontFamily.Monospace))
            onRetry?.let {
                Text(
                    "  [retry]",
                    color = Accent,
                    style = type.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    modifier = Modifier.clickable { it() }.padding(top = space.tight),
                )
            }
        }

        else -> Column(
            Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 40.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(message, color = Err, style = type.bodySmall, textAlign = TextAlign.Center)
            onRetry?.let {
                TextButton(onClick = it, modifier = Modifier.padding(top = 4.dp)) { Text("Retry") }
            }
        }
    }
}


/**
 * Going back.
 *
 * Small enough to feel like a detail, which is why it was the same filled
 * Material arrow in all three designs and in three different sizes. It is also
 * the control people touch most after the thing they came for, so it is worth
 * being the design's own: a stroke chevron with a press spring in Fluid, the
 * specified auto-mirrored IconButton in Material, and `<` in Console, where a
 * vector icon would be the only one on the screen.
 */
@Composable
fun BackButton(onBack: () -> Unit) {
    when (LocalDesign.current) {
        Design.Fluid -> {
            var pressed by remember { mutableStateOf(false) }
            val scale by animateFloatAsState(
                if (pressed) 0.88f else 1f,
                spring(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMedium),
                label = "back-press",
            )
            Box(
                Modifier
                    .size(38.dp)
                    .scale(scale)
                    .clip(RoundedCornerShape(99.dp))
                    .background(Panel2)
                    .clickable {
                        pressed = true
                        onBack()
                    },
                contentAlignment = Alignment.Center,
            ) {
                Icon(SimbaIcons.Back, "Back", tint = Dim, modifier = Modifier.size(17.dp))
            }
        }

        Design.Material -> IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
        }

        Design.Console -> Text(
            "<",
            color = Accent,
            style = type.body,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.clickable { onBack() }.padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
}


/**
 * The horizontal inset a screen's own controls should use.
 *
 * Rows set their own, per design; anything else on the screen — a button, a
 * banner, a form — has to match it or the column visibly steps in and out as
 * you scroll. This is that number, and it is the design's, not a constant.
 */
@Composable
fun Modifier.screenPad(): Modifier = this.padding(
    horizontal = when (LocalDesign.current) {
        Design.Fluid -> 16.dp
        Design.Material -> 12.dp
        Design.Console -> 10.dp
    },
)


/**
 * A small action in a header or a strip.
 *
 * Two representations of the same action, not a fallback: Fluid and Material
 * get the vector, Console gets the word or the sigil. Console's whole claim is
 * that it is a terminal, and one Material glyph in a header is enough to make
 * that read as a theme rather than a design.
 */
@Composable
fun ActionIcon(
    icon: ImageVector,
    glyph: String,
    label: String,
    tint: Color = Dim,
    onClick: () -> Unit,
) {
    if (LocalDesign.current == Design.Console) {
        Text(
            glyph,
            color = tint,
            style = type.label.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier.clickable { onClick() }.padding(horizontal = space.snug, vertical = space.tight),
        )
    } else {
        IconButton(onClick = onClick, modifier = Modifier.size(34.dp)) {
            Icon(icon, label, tint = tint, modifier = Modifier.size(18.dp))
        }
    }
}

/** The open/closed indicator on anything that expands. */
@Composable
fun Chevron(expanded: Boolean, tint: Color = Dim) {
    if (LocalDesign.current == Design.Console) {
        Text(
            if (expanded) "[-]" else "[+]",
            color = tint,
            style = type.micro,
        )
    } else {
        Icon(
            if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
            contentDescription = if (expanded) "Collapse" else "Expand",
            tint = tint,
            modifier = Modifier.size(16.dp),
        )
    }
}


/**
 * A path shortened from the left, along segment boundaries.
 *
 * Naive truncation of a path is worse than useless. `takeLast(52)` on
 * `android/app/src/main/java/com/operator/simba/Session.kt` yields
 * `ndroid/app/src/main/java/com/operator/simba/` — cut mid-segment, and with the
 * filename gone, which is the one part being looked for. Dropping whole leading
 * segments and marking the cut keeps the answer to "which file" intact and
 * spends the remaining width on however much parent context fits.
 */
fun shortPath(path: String, maxChars: Int = 40): String {
    val parts = path.replace('\\', '/').split('/').filter { it.isNotBlank() }
    if (parts.isEmpty()) return path
    val name = parts.last()
    // A filename alone longer than the budget is the one case where cutting
    // inside a segment is right — and it is cut from the front, because
    // extensions and suffixes disambiguate more than prefixes do.
    if (name.length >= maxChars) return "…" + name.takeLast(maxChars - 1)

    val out = StringBuilder(name)
    for (i in parts.size - 2 downTo 0) {
        if (parts[i].length + 1 + out.length > maxChars) return "…/$out"
        out.insert(0, parts[i] + "/")
    }
    return out.toString()
}
