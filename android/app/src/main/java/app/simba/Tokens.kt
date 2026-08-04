package com.operator.simba

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The scales. All of them, in one place, chosen rather than nudged.
 *
 * Before this file the app used eighteen distinct font sizes — 9.5, 10, 10.5,
 * 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 16, 17, 18, 20, 21, 32 — with
 * eleven of them inside a 5sp band. A half-point difference between two labels
 * is not a decision anybody made; it is what happens when each line is tuned
 * where it sits, and it is precisely why an interface reads as assembled rather
 * than designed. The same was true of spacing: 4, 8, 9, 11, 18 as raw literals
 * with no relationship between them.
 *
 * Eight sizes, on a ratio, is enough for any screen in this app. The constraint
 * is the point — when there is no 12.5 available, two things that were nearly
 * the same size become either the same or genuinely different, and that decision
 * is what hierarchy is made of.
 *
 * ## The type scale
 *
 * Roughly 1.2 between neighbours at the top, tightening to whole points at the
 * bottom where the eye cannot resolve finer steps anyway:
 *
 *   display 30 · title 22 · heading 17 · body 15 · bodySmall 13 · label 12 ·
 *   caption 11 · micro 10
 *
 * Negative tracking above 17sp because letterforms set at display sizes look
 * loose at the spacing that suits body text — the larger the type, the tighter
 * it wants to be. Line height is 1.35× for body and 1.15× for display, which is
 * the usual inversion: long-form text needs room between lines to track back to
 * the left edge, a two-word title does not.
 *
 * Three weights only — Regular, Medium, SemiBold. Bold is reserved for the
 * single most important thing on a screen, and if everything is bold the weight
 * has stopped carrying information.
 */
@Immutable
data class TypeScale(
    /** One per screen at most. The thing you are looking at. */
    val display: TextStyle,
    /** A section that owns a region of the screen. */
    val title: TextStyle,
    /** A group inside a section. */
    val heading: TextStyle,
    /** Prose, and the primary line of any row. */
    val body: TextStyle,
    /** Supporting prose. Explanations, subtitles, descriptions. */
    val bodySmall: TextStyle,
    /** Interactive text: buttons, links, tabs. Medium weight to feel pressable. */
    val label: TextStyle,
    /** Metadata beside something else. Never the only thing in a row. */
    val caption: TextStyle,
    /** Eyebrows and units. Tracked out because small caps close up. */
    val micro: TextStyle,
    /** Anything where alignment carries meaning: paths, hashes, diffs, output. */
    val mono: TextStyle,
)

/**
 * Spacing on a 4dp grid, named for intent rather than size.
 *
 * Named so a call site says what it means: `space.gutter` is the distance from
 * the screen edge and changes with the design, while `16.dp` is a number that
 * has to be found and changed in ninety places. Intent also survives a redesign
 * — "the gutter" is still the gutter when it becomes 20dp.
 */
@Immutable
data class SpaceScale(
    /** Between a label and the thing it labels. */
    val hair: Dp = 2.dp,
    /** Between lines inside one idea. */
    val tight: Dp = 4.dp,
    /** Between related elements. */
    val snug: Dp = 8.dp,
    /** The default gap. Between rows, inside a card. */
    val base: Dp = 12.dp,
    /** Screen edge to content. The most-used number in any layout. */
    val gutter: Dp = 16.dp,
    /** Inside a surface that wants to feel generous. */
    val roomy: Dp = 20.dp,
    /** Between one section and the next. */
    val section: Dp = 28.dp,
    /** Above the first thing and below the last. */
    val page: Dp = 40.dp,
)

/**
 * Corner radii, also named for intent.
 *
 * A design's radius is one of the two or three things the eye uses to identify
 * it at a glance, ahead of colour, which is why these live with the design
 * rather than as constants.
 */
@Immutable
data class RadiusScale(
    val sharp: Dp,
    val small: Dp,
    val medium: Dp,
    val large: Dp,
    /** For anything that should read as a capsule regardless of its height. */
    val pill: Dp = 999.dp,
)

// ---------------------------------------------------------------------------
// Per-design scales
// ---------------------------------------------------------------------------

private fun proportional(
    scale: Float = 1f,
    weightShift: FontWeight? = null,
) = TypeScale(
    display = TextStyle(
        fontSize = (30 * scale).sp,
        lineHeight = (34 * scale).sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = (-0.7).sp,
    ),
    title = TextStyle(
        fontSize = (22 * scale).sp,
        lineHeight = (27 * scale).sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = (-0.4).sp,
    ),
    heading = TextStyle(
        fontSize = (17 * scale).sp,
        lineHeight = (22 * scale).sp,
        fontWeight = weightShift ?: FontWeight.SemiBold,
        letterSpacing = (-0.1).sp,
    ),
    body = TextStyle(
        fontSize = (15 * scale).sp,
        lineHeight = (20 * scale).sp,
        fontWeight = FontWeight.Normal,
    ),
    bodySmall = TextStyle(
        fontSize = (13 * scale).sp,
        lineHeight = (18 * scale).sp,
        fontWeight = FontWeight.Normal,
    ),
    label = TextStyle(
        fontSize = (12 * scale).sp,
        lineHeight = (16 * scale).sp,
        fontWeight = FontWeight.Medium,
    ),
    caption = TextStyle(
        fontSize = (11 * scale).sp,
        lineHeight = (15 * scale).sp,
        fontWeight = FontWeight.Normal,
    ),
    micro = TextStyle(
        fontSize = (10 * scale).sp,
        lineHeight = (13 * scale).sp,
        fontWeight = FontWeight.Medium,
        letterSpacing = 0.4.sp,
    ),
    mono = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontSize = (12 * scale).sp,
        lineHeight = (17 * scale).sp,
    ),
)

/**
 * Console is monospace throughout and one step down.
 *
 * Not a stylistic choice: a fixed advance width is what lets a column of values
 * line up without a table, which is the entire reason the design exists. The
 * step down is what buys the extra rows per screen — density claimed in
 * typography rather than by removing whitespace, because removing whitespace
 * makes something cramped and setting it smaller makes it dense.
 */
private val ConsoleType = TypeScale(
    display = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 22.sp, lineHeight = 26.sp, fontWeight = FontWeight.Bold),
    title = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 17.sp, lineHeight = 21.sp, fontWeight = FontWeight.Bold),
    heading = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 14.sp, lineHeight = 18.sp, fontWeight = FontWeight.Bold),
    body = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 17.sp),
    bodySmall = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 16.sp),
    label = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Bold),
    caption = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 14.sp),
    micro = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 10.sp, lineHeight = 13.sp),
    mono = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 16.sp),
)

fun typeScaleFor(design: Design): TypeScale = when (design) {
    // Fluid runs a hair larger: its argument is air, and air with small type
    // reads as empty rather than generous.
    Design.Fluid -> proportional(scale = 1.02f)
    Design.Material -> proportional()
    Design.Console -> ConsoleType
}

fun spaceScaleFor(design: Design): SpaceScale = when (design) {
    Design.Fluid -> SpaceScale(
        hair = 2.dp, tight = 5.dp, snug = 10.dp, base = 14.dp,
        gutter = 18.dp, roomy = 22.dp, section = 32.dp, page = 44.dp,
    )
    Design.Material -> SpaceScale()
    // Console's grid is 3dp, not 4: the whole design is a claim about density,
    // and a 4dp grid is what everything else uses.
    Design.Console -> SpaceScale(
        hair = 1.dp, tight = 3.dp, snug = 6.dp, base = 9.dp,
        gutter = 10.dp, roomy = 12.dp, section = 18.dp, page = 24.dp,
    )
}

fun radiusScaleFor(design: Design): RadiusScale = when (design) {
    Design.Fluid -> RadiusScale(sharp = 6.dp, small = 12.dp, medium = 18.dp, large = 26.dp)
    Design.Material -> RadiusScale(sharp = 4.dp, small = 8.dp, medium = 12.dp, large = 16.dp)
    // Nearly square, so a column of rows reads as a table rather than as cards.
    Design.Console -> RadiusScale(sharp = 0.dp, small = 2.dp, medium = 3.dp, large = 4.dp)
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

val LocalTypeScale = staticCompositionLocalOf { proportional() }
val LocalSpaceScale = staticCompositionLocalOf { SpaceScale() }
val LocalRadiusScale = staticCompositionLocalOf { radiusScaleFor(Design.Fluid) }

/**
 * Short names, because these are read constantly.
 *
 * `type.body` and `space.gutter` at a call site stay out of the way of what the
 * layout is actually saying; `LocalTypeScale.current.body` does not.
 */
val type: TypeScale @Composable @ReadOnlyComposable get() = LocalTypeScale.current
val space: SpaceScale @Composable @ReadOnlyComposable get() = LocalSpaceScale.current
val radius: RadiusScale @Composable @ReadOnlyComposable get() = LocalRadiusScale.current
