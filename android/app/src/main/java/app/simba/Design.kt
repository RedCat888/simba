package com.operator.simba

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.datastore.preferences.core.edit
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * The three presentation layers the app can wear. Stored by [name], so renaming
 * a member silently resets everyone's choice to [Default] — add members instead.
 */
enum class Design(val label: String, val blurb: String) {
    Clean(
        "Clean",
        "Quiet modern surfaces, generous spacing, one accent colour.",
    ),
    Material(
        "Material 3",
        "Real Material 3, taking its colours from the wallpaper.",
    ),
    Dense(
        "Dense",
        "Console-tight: monospace, minimal chrome, most rows per screen.",
    ),
    ;

    companion object {
        val Default = Clean

        fun from(raw: String?): Design = entries.firstOrNull { it.name == raw } ?: Default
    }
}

// The same DataStore the gateway URL lives in. The choice of design is a
// preference, not a secret, so it does not belong in Secrets.
fun Context.designFlow(): Flow<Design> = dataStore.data.map { Design.from(it[Prefs.DESIGN]) }

suspend fun Context.saveDesign(design: Design) {
    dataStore.edit { it[Prefs.DESIGN] = design.name }
}

/**
 * Static rather than dynamic: a design change restyles the whole tree anyway, so
 * recomposing the provider's content wholesale is cheaper than tracking every
 * reader individually.
 */
val LocalDesign = staticCompositionLocalOf { Design.Default }

/**
 * Theme entry point for activities. Collects the stored design so switching it
 * recomposes in place with no activity restart.
 */
@Composable
fun SimbaThemeHost(content: @Composable () -> Unit) {
    val ctx = LocalContext.current
    val flow = remember(ctx) { ctx.designFlow() }
    // DataStore's first read is asynchronous, so the first frame necessarily
    // renders the default. Harmless while all three designs look alike; once they
    // diverge this is one frame of the default before the stored choice lands.
    val design by flow.collectAsState(initial = Design.Default)
    SimbaTheme(design = design, content = content)
}
