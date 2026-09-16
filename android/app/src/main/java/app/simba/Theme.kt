package app.simba

import android.app.Activity
import android.os.Build
import androidx.core.content.res.use
import androidx.core.view.WindowCompat
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// ---------------------------------------------------------------------------
// Colour schemes
// ---------------------------------------------------------------------------

// The dark scheme, rebuilt after computing what the old one actually did.
//
// Two numbers condemned it. Adjacent surfaces were 1.064:1 apart — invisible on
// a phone — so the elevation ladder did no work at all and containment fell
// entirely to corner radius, which is precisely why every element on every
// screen read as a card. And the warning colour was 11.95:1 against the canvas
// while the brand accent was 9.53:1, so the loudest chromatic thing on any
// screen was a warning. Five status hues crowded into a 5.9-12.0 band all shout
// at the same volume; that is a Christmas tree, and it is arithmetic rather than
// taste.
//
// The rebuilt ladder steps 1.15 / 1.15 / 1.18 / 1.22, which is visible without
// being stripey. The accent is the loudest chromatic element at 8.55:1 and the
// status band sits beneath it at 5.3-7.6, so a screen full of "completed" no
// longer out-shouts the one thing you can act on.
//
// The accent is no longer amber. Amber on near-black is semantically
// pre-committed to *warning*, and using it for the selected tab and the primary
// button and the actual warnings is what destroyed its operational meaning.
// Amber is now warning and only warning.
private val SimbaDark = darkColorScheme(
    // Same terracotta the desktop uses. Periwinkle on cool navy made the phone
    // and the web two different products; Claude's warm coral is the house
    // accent on both, with dark ink on the fill so the label clears WCAG AA.
    primary = Color(0xFFD97757),
    onPrimary = Color(0xFF1F1E1D),
    primaryContainer = Color(0xFF3A2B24),
    onPrimaryContainer = Color(0xFFF2F0EA),
    secondary = Color(0xFF6BA3CC),
    onSecondary = Color(0xFF1E2A33),
    secondaryContainer = Color(0xFF1E2A33),
    onSecondaryContainer = Color(0xFFCDE7EF),
    tertiary = Color(0xFF5FAE83),
    onTertiary = Color(0xFF1F2E26),

    // Warm neutrals, ochre-biased, matching app/index.html. Cool navy next to
    // coral reads as a terminal theme wearing a chat-app accent.
    background = Color(0xFF232220),
    onBackground = Color(0xFFF2F0EA),
    surface = Color(0xFF2E2D2A),
    onSurface = Color(0xFFF2F0EA),
    surfaceVariant = Color(0xFF383632),
    onSurfaceVariant = Color(0xFFA9A69E),
    surfaceContainerLowest = Color(0xFF1A1917),
    surfaceContainerLow = Color(0xFF232220),
    surfaceContainer = Color(0xFF2E2D2A),
    surfaceContainerHigh = Color(0xFF383632),
    surfaceContainerHighest = Color(0xFF403E3A),

    inverseSurface = Color(0xFFF2F0EA),
    inverseOnSurface = Color(0xFF2E2D2A),
    outline = Color(0xFF7C7970),
    outlineVariant = Color(0xFF403E3A),
    error = Color(0xFFD97570),
    onError = Color(0xFF1F1E1D),
    errorContainer = Color(0xFF33211F),
    onErrorContainer = Color(0xFFF8E9E7),
    scrim = Color(0xFF000000),
)

// A real light scheme, not a stub. It exists for two reasons: the OS may be in
// light mode, and it is the pre-API-31 fallback when dynamic colour is
// unavailable. Every role the app reads is set explicitly.
private val SimbaLight = lightColorScheme(
    // Dark terracotta fill so cream labels clear 4.5:1. The brighter coral
    // (#C4643C) is only ~4:1 on white and failed the same check the desktop
    // Panic / Send buttons just failed.
    primary = Color(0xFF7A341F),
    onPrimary = Color(0xFFF5F4EF),
    primaryContainer = Color(0xFFF6EAE3),
    onPrimaryContainer = Color(0xFF7A341F),
    secondary = Color(0xFF3A6E96),
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFE7EFF6),
    onSecondaryContainer = Color(0xFF1E2A33),
    tertiary = Color(0xFF3F7F5B),
    onTertiary = Color(0xFFFFFFFF),
    background = Color(0xFFF5F4EF),
    onBackground = Color(0xFF1F1E1D),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF1F1E1D),
    surfaceVariant = Color(0xFFF0EEE7),
    onSurfaceVariant = Color(0xFF6B6A65),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFF9F8F3),
    surfaceContainer = Color(0xFFF0EEE7),
    surfaceContainerHigh = Color(0xFFE8E5DC),
    surfaceContainerHighest = Color(0xFFE3E0D8),
    inverseSurface = Color(0xFF2E2D2A),
    inverseOnSurface = Color(0xFFF2F0EA),
    outline = Color(0xFF94928B),
    outlineVariant = Color(0xFFE3E0D8),
    error = Color(0xFF8A322C),
    onError = Color(0xFFF5F4EF),
    errorContainer = Color(0xFFF8E9E7),
    onErrorContainer = Color(0xFF8A322C),
    scrim = Color(0xFF000000),
)

/**
 * What a chat notice means, not what colour it is. Notices are built off the
 * websocket, outside composition, where the palette can no longer be read — so
 * they carry meaning and the row resolves the colour when it draws.
 */
enum class NoticeTone { Neutral, Warn, Error }

@Composable
@ReadOnlyComposable
fun noticeColor(tone: NoticeTone): Color = when (tone) {
    NoticeTone.Neutral -> Accent
    NoticeTone.Warn -> Warn
    NoticeTone.Error -> Err
}

/**
 * Status hues Material 3 has no role for. "Succeeded" and "rate limited" are
 * meanings, not tones, so they cannot be derived from a wallpaper — under
 * dynamic colour these stay fixed while everything else moves.
 */
@Immutable
data class SimbaStatusColors(val ok: Color, val warn: Color, val info: Color)

// Deliberately quieter than the accent (8.55:1). Status appears on nearly every
// row; the accent appears once per screen. The frequent thing must be the
// quieter thing or the screen reads as noise with an action hidden in it.
private val DarkStatus = SimbaStatusColors(
    ok = Color(0xFF4FAE85),
    warn = Color(0xFFC99A3B),
    info = Color(0xFF5AA7BC),
)

private val LightStatus = SimbaStatusColors(
    ok = Color(0xFF0B7A48),
    warn = Color(0xFF8A5A00),
    info = Color(0xFF1B5FBE),
)

private val LocalStatusColors = staticCompositionLocalOf { DarkStatus }

// ---------------------------------------------------------------------------
// Palette aliases
//
// These keep the ~250 existing call sites compiling, but they are no longer
// frozen literals: each one resolves out of the active MaterialTheme, so
// switching design — or the wallpaper, under dynamic colour — actually moves
// them. They are composable getters, so they can only be read during
// composition; anything outside composition must carry a semantic value and
// resolve it at render time (see ChatItem.Notice).
// ---------------------------------------------------------------------------

val Bg: Color @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.background
val Panel: Color @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.surface
val Panel2: Color @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.surfaceContainerHigh

/**
 * A surface that must be visible as a container on any scheme.
 *
 * `Panel` maps to `surface`, and in Material 3 `surface` and `background` are
 * the same role — so a hand-built card painted with `Panel` on a `Bg` canvas is
 * invisible under dynamic colour. It only ever looked right because Fluid and
 * Console use hand-written schemes where the two differ. Anything that draws its
 * own card rather than going through ItemRow uses this instead, which is a real
 * step above the canvas in all three.
 */
val Raised: Color @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.surfaceContainerHigh

/**
 * A control sitting *on* a raised surface.
 *
 * The third step, and it is needed for exactly the reason the second was: a
 * secondary button painted the same colour as the card under it has no
 * container at all. Moving the cards to [Raised] created that collision for
 * every control that had been using the same role, which is the sort of thing
 * only visible by rendering it.
 */
val Inset: Color @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.surfaceContainerHighest
val Line: Color @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.outlineVariant
val Fg: Color @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.onBackground
val Dim: Color @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.onSurfaceVariant
val Faint: Color @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.outline
val Accent: Color @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.primary
val OnAccent: Color @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.onPrimary
val Err: Color @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.error
val Ok: Color @Composable @ReadOnlyComposable get() = LocalStatusColors.current.ok
val Warn: Color @Composable @ReadOnlyComposable get() = LocalStatusColors.current.warn
val Info: Color @Composable @ReadOnlyComposable get() = LocalStatusColors.current.info

// ---------------------------------------------------------------------------
// Typography and shapes
// ---------------------------------------------------------------------------

private val SimbaType = Typography(
    titleLarge = TextStyle(fontWeight = FontWeight.Bold, fontSize = 20.sp, letterSpacing = 0.3.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 16.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    // No colour here: a colour baked into a TextStyle overrides the scheme and
    // would survive every design switch.
    bodySmall = TextStyle(fontSize = 12.5.sp, lineHeight = 17.sp),
    labelSmall = TextStyle(
        fontSize = 10.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.5.sp,
    ),
    labelMedium = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp),
)

// ---------------------------------------------------------------------------
// Design dispatch
// ---------------------------------------------------------------------------

/** Wallpaper-derived colour is API 31+; below that the static schemes stand in. */
private val dynamicColorAvailable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

/**
 * Console reads as a terminal: near-black, cool grey text, a cold accent.
 *
 * A separate palette rather than a tint of the house one, because the point of
 * offering three designs is that they are genuinely different — three names
 * over one appearance is worse than not offering the choice, since it invites
 * someone to keep switching looking for a difference that is not there.
 */
private val ConsoleDark = darkColorScheme(
    background = Color(0xFF06080C),
    surface = Color(0xFF10161F),
    surfaceVariant = Color(0xFF18202B),
    surfaceContainerLow = Color(0xFF0B0F16),
    surfaceContainer = Color(0xFF10161F),
    surfaceContainerHigh = Color(0xFF18202B),
    surfaceContainerHighest = Color(0xFF212B38),
    onBackground = Color(0xFFDCE6F0),
    onSurface = Color(0xFFDCE6F0),
    onSurfaceVariant = Color(0xFFAAB7C6),
    outline = Color(0xFF7C8A9B),
    outlineVariant = Color(0xFF232D3A),
    primary = Color(0xFF6FD3F5),
    onPrimary = Color(0xFF04121A),
    error = Color(0xFFE0737B),
)

/**
 * Console in light mode.
 *
 * This was missing, so a phone in light mode showed Console wearing Fluid's
 * palette — warm amber accent, soft off-white surfaces, no terminal in sight.
 * Picking a design and getting a different one is worse than the design being
 * plain. A paper terminal rather than an inverted one: cool near-white, ink-blue
 * text, the same cold accent so the identity survives the mode change.
 */
private val ConsoleLight = lightColorScheme(
    background = Color(0xFFF4F6F8),
    onBackground = Color(0xFF11181F),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF11181F),
    surfaceVariant = Color(0xFFE7ECF1),
    onSurfaceVariant = Color(0xFF4E5A67),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFFAFBFC),
    surfaceContainer = Color(0xFFEFF2F5),
    surfaceContainerHigh = Color(0xFFE7ECF1),
    surfaceContainerHighest = Color(0xFFDEE5EC),
    outline = Color(0xFF7B8794),
    outlineVariant = Color(0xFFCBD4DD),
    primary = Color(0xFF0A6E93),
    onPrimary = Color(0xFFFFFFFF),
    error = Color(0xFFB3261E),
    onError = Color(0xFFFFFFFF),
)

/** Fluid is the house look: warm paper, terracotta accent, same as the desktop. */
private val FluidDark = SimbaDark

@Composable
@ReadOnlyComposable
private fun schemeFor(design: Design, dark: Boolean): ColorScheme {
    // Only the Material design claims to be Material 3 with dynamic colour. The
    // other two are deliberate house palettes; taking their colours from the
    // wallpaper would make them the same design three times.
    if (design == Design.Material && dynamicColorAvailable) {
        val ctx = LocalContext.current
        return if (dark) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
    }
    return when {
        design == Design.Console -> if (dark) ConsoleDark else ConsoleLight
        dark -> FluidDark
        else -> SimbaLight
    }
}

/**
 * Console's status hues, which have to be readable on ink-on-paper rather than
 * on near-black — the dark set's mint and amber vanish on white.
 */
private val ConsoleLightStatus = SimbaStatusColors(
    ok = Color(0xFF0A6B42),
    warn = Color(0xFF8A5A00),
    info = Color(0xFF0A6E93),
)

/**
 * Console is monospace throughout and a step smaller, which is what actually
 * buys the extra rows per screen. Fluid keeps the proportional face with roomier
 * line height; Material takes the platform's own type scale so it looks like a
 * Material app rather than this app wearing Material colours.
 */
private val ConsoleType = Typography(
    titleLarge = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 17.sp),
    titleMedium = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold, fontSize = 14.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.5.sp, lineHeight = 16.sp),
    bodySmall = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 14.sp),
    labelSmall = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 9.5.sp),
    labelMedium = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 11.sp),
)

private val FluidType = Typography(
    titleLarge = TextStyle(fontWeight = FontWeight.Bold, fontSize = 21.sp, letterSpacing = 0.2.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 16.sp),
    bodyMedium = TextStyle(fontSize = 14.5.sp, lineHeight = 22.sp),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 19.sp),
    labelSmall = TextStyle(fontSize = 10.sp),
    labelMedium = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp),
)

private fun typographyFor(design: Design): Typography = when (design) {
    Design.Fluid -> FluidType
    Design.Console -> ConsoleType
    // Material's own defaults, deliberately not overridden.
    Design.Material -> Typography()
}

/**
 * Corner radius carries as much of a design's character as colour does. Fluid
 * is generously rounded, Console is nearly square so rows read as a table, and
 * Material takes the platform defaults.
 */
private fun shapesFor(design: Design): Shapes = when (design) {
    Design.Fluid -> Shapes(
        extraSmall = RoundedCornerShape(8.dp),
        small = RoundedCornerShape(12.dp),
        medium = RoundedCornerShape(16.dp),
        large = RoundedCornerShape(22.dp),
    )
    Design.Console -> Shapes(
        extraSmall = RoundedCornerShape(2.dp),
        small = RoundedCornerShape(3.dp),
        medium = RoundedCornerShape(4.dp),
        large = RoundedCornerShape(6.dp),
    )
    Design.Material -> Shapes()
}

/**
 * How much air a design leaves around things.
 *
 * Colour and type alone still leave three variations of the same layout. This
 * is what makes Console actually dense: components multiply their padding by it,
 * so one value changes the whole app's rhythm without every component knowing
 * which design is active.
 */
val LocalDensityScale = staticCompositionLocalOf { 1f }

fun densityFor(design: Design): Float = when (design) {
    Design.Fluid -> 1.15f
    Design.Material -> 1f
    Design.Console -> 0.72f
}

/**
 * Prefer [SimbaThemeHost] from an activity — it reads the stored design. This
 * overload takes the design explicitly so previews and tests can pin one.
 */
@Composable
fun SimbaTheme(
    design: Design = Design.Default,
    dark: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    SystemBarAppearance(dark)
    CompositionLocalProvider(
        LocalDesign provides design,
        LocalDensityScale provides densityFor(design),
        // The scales the whole UI is measured against. See Tokens.kt for why
        // there are eight type sizes rather than the eighteen this app had.
        LocalTypeScale provides typeScaleFor(design),
        LocalSpaceScale provides spaceScaleFor(design),
        LocalRadiusScale provides radiusScaleFor(design),
        LocalStatusColors provides when {
            dark -> DarkStatus
            design == Design.Console -> ConsoleLightStatus
            else -> LightStatus
        },
    ) {
        MaterialTheme(
            colorScheme = schemeFor(design, dark),
            typography = typographyFor(design),
            shapes = shapesFor(design),
            content = content,
        )
    }
}

/**
 * Draws the clock and wifi icons the opposite way round from the chrome behind
 * them. Edge-to-edge means the app's own background is what sits under the
 * status bar, so this can only be decided here, where the scheme is known —
 * the bars have no colour of their own to fall back on.
 *
 * Skipped for floating windows: ShareActivity's translucent sheet sits over
 * another app, whose bars are not ours to restyle.
 */
@Composable
private fun SystemBarAppearance(dark: Boolean) {
    val view = LocalView.current
    if (view.isInEditMode) return
    val activity = view.context as? Activity ?: return
    val floating = remember(activity) {
        activity.theme.obtainStyledAttributes(intArrayOf(android.R.attr.windowIsTranslucent)).use {
            it.getBoolean(0, false)
        }
    }
    if (floating) return
    SideEffect {
        WindowCompat.getInsetsController(activity.window, view).run {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }
}
