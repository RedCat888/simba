package com.operator.simba

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

// The dark scheme is the house palette, carried over from the web control center
// so the two surfaces read as one system. Written out as full Material 3 roles
// rather than as loose constants, so a design switch or dynamic colour can
// replace the whole thing in one substitution.
private val SimbaDark = darkColorScheme(
    primary = Color(0xFFF5A524),
    onPrimary = Color(0xFF1A1206),
    primaryContainer = Color(0xFF5A3D06),
    onPrimaryContainer = Color(0xFFFFDEA8),
    secondary = Color(0xFF5B9BF8),
    onSecondary = Color(0xFF06172E),
    secondaryContainer = Color(0xFF1B3557),
    onSecondaryContainer = Color(0xFFCFE0FA),
    tertiary = Color(0xFF3ECF8E),
    onTertiary = Color(0xFF042315),
    background = Color(0xFF0B0D10),
    onBackground = Color(0xFFE6E9EF),
    surface = Color(0xFF12151A),
    onSurface = Color(0xFFE6E9EF),
    surfaceVariant = Color(0xFF171B21),
    onSurfaceVariant = Color(0xFF8B95A5),
    surfaceContainerLowest = Color(0xFF080A0C),
    surfaceContainerLow = Color(0xFF101318),
    surfaceContainer = Color(0xFF12151A),
    surfaceContainerHigh = Color(0xFF171B21),
    surfaceContainerHighest = Color(0xFF1D2229),
    inverseSurface = Color(0xFFE6E9EF),
    inverseOnSurface = Color(0xFF12151A),
    outline = Color(0xFF5C6675),
    outlineVariant = Color(0xFF242A33),
    error = Color(0xFFF5555A),
    onError = Color(0xFF2A0407),
    errorContainer = Color(0xFF54151A),
    onErrorContainer = Color(0xFFFFDAD9),
    scrim = Color(0xFF000000),
)

// A real light scheme, not a stub. It exists for two reasons: the OS may be in
// light mode, and it is the pre-API-31 fallback when dynamic colour is
// unavailable. Every role the app reads is set explicitly.
private val SimbaLight = lightColorScheme(
    primary = Color(0xFF8A5300),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFFFDEA8),
    onPrimaryContainer = Color(0xFF2C1A00),
    secondary = Color(0xFF1B5FBE),
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFD6E3FF),
    onSecondaryContainer = Color(0xFF001B3C),
    tertiary = Color(0xFF08703F),
    onTertiary = Color(0xFFFFFFFF),
    background = Color(0xFFF7F8FA),
    onBackground = Color(0xFF14181D),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF14181D),
    surfaceVariant = Color(0xFFEDF0F5),
    onSurfaceVariant = Color(0xFF5A6472),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFF9FAFC),
    surfaceContainer = Color(0xFFF2F4F8),
    surfaceContainerHigh = Color(0xFFECEFF4),
    surfaceContainerHighest = Color(0xFFE5E9F0),
    inverseSurface = Color(0xFF2A2F36),
    inverseOnSurface = Color(0xFFF2F4F8),
    outline = Color(0xFF8B95A5),
    outlineVariant = Color(0xFFD3D9E2),
    error = Color(0xFFB3261E),
    onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFF9DEDC),
    onErrorContainer = Color(0xFF410E0B),
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

private val DarkStatus = SimbaStatusColors(
    ok = Color(0xFF3ECF8E),
    warn = Color(0xFFF5C451),
    info = Color(0xFF5B9BF8),
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
    background = Color(0xFF07090C),
    surface = Color(0xFF0C1015),
    surfaceContainerHigh = Color(0xFF141A21),
    onBackground = Color(0xFFC8D3DE),
    onSurfaceVariant = Color(0xFF8A97A6),
    outline = Color(0xFF4A5563),
    primary = Color(0xFF56C7F0),
    onPrimary = Color(0xFF04121A),
    error = Color(0xFFF0757A),
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

/** Fluid is the house look: warmer ink, softer surfaces, the amber accent. */
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
