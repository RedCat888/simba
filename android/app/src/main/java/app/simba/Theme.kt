package com.operator.simba

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// Palette carried over from the web control center so the two surfaces read as
// one system rather than two apps that happen to share a backend.
val Bg = Color(0xFF0B0D10)
val Panel = Color(0xFF12151A)
val Panel2 = Color(0xFF171B21)
val Line = Color(0xFF242A33)
val Fg = Color(0xFFE6E9EF)
val Dim = Color(0xFF8B95A5)
val Faint = Color(0xFF5C6675)
val Accent = Color(0xFFF5A524)
val Ok = Color(0xFF3ECF8E)
val Warn = Color(0xFFF5A524)
val Err = Color(0xFFF5555A)
val Info = Color(0xFF5B9BF8)

private val SimbaDark = darkColorScheme(
    primary = Accent,
    onPrimary = Color(0xFF1A1206),
    secondary = Info,
    background = Bg,
    onBackground = Fg,
    surface = Panel,
    onSurface = Fg,
    surfaceVariant = Panel2,
    onSurfaceVariant = Dim,
    outline = Line,
    error = Err,
)

// The system is dark-first; a light scheme exists only so the app does not look
// broken if the OS forces light mode.
private val SimbaLight = lightColorScheme(
    primary = Color(0xFFB07000),
    secondary = Info,
    background = Color(0xFFF7F8FA),
    surface = Color.White,
    error = Err,
)

private val SimbaType = Typography(
    titleLarge = TextStyle(fontWeight = FontWeight.Bold, fontSize = 20.sp, letterSpacing = 0.3.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 16.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 12.5.sp, lineHeight = 17.sp, color = Dim),
    labelSmall = TextStyle(
        fontSize = 10.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.5.sp,
    ),
    labelMedium = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp),
)

@Composable
fun SimbaTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (dark) SimbaDark else SimbaLight,
        typography = SimbaType,
        content = content,
    )
}

/** Status colours shared by agents, sessions, missions and brains. */
fun statusColor(status: String): Color = when (status.lowercase()) {
    "running", "available", "succeeded", "completed" -> Ok
    "idle", "pending", "planning" -> Dim
    "waiting_limit", "limited", "blocked", "verifying", "paused" -> Warn
    "failed", "error", "logged_out", "cancelled" -> Err
    else -> Dim
}
