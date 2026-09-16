package app.simba

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.ui.Alignment
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color

/**
 * The only place in the app that touches window insets.
 *
 * `enableEdgeToEdge()` sets `decorFitsSystemWindows = false`, so the window no
 * longer resizes for the status bar, the navigation bar or the keyboard, and
 * `windowSoftInputMode="adjustResize"` in the manifest does nothing on its own.
 * Every inset has to be consumed in Compose instead. Doing that per screen is
 * how the chat header ended up drawing on top of the clock while the keyboard
 * covered the composer, so every destination goes through this shell and no
 * screen carries inset code of its own.
 *
 * The bottom inset is the union of the keyboard and the navigation bar rather
 * than the sum: when the keyboard is up it already occupies the navigation bar's
 * space, and padding for both leaves a visible dead strip.
 *
 * Because [content] is weighted, growing the bottom inset shrinks the content
 * area — so a keyboard raises the bottom bar *and* gives the scrolling content
 * less room, instead of pushing the tail of it off screen.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SimbaShell(
    header: (@Composable () -> Unit)? = null,
    bottomBar: (@Composable () -> Unit)? = null,
    /**
     * Drawn *over* the content rather than beside it, inside the same inset
     * padding. bottomBar reserves layout height, which is right for a real bar
     * and wrong for a floating control — reserving space for something that
     * floats gives back the screen area it was supposed to save.
     */
    floating: (@Composable BoxScope.() -> Unit)? = null,
    background: Color = Bg,
    /** Painted behind the system bars so they match the app's own chrome. */
    chrome: Color = Panel,
    content: @Composable () -> Unit,
) {
    Column(Modifier.fillMaxSize().background(background)) {
        Box(
            Modifier
                .fillMaxWidth()
                .background(chrome)
                .windowInsetsPadding(WindowInsets.statusBars.only(WindowInsetsSides.Top)),
        ) { header?.invoke() }

        Box(Modifier.fillMaxWidth().weight(1f)) {
            content()
            // Floating chrome shares the content box and respects the same
            // bottom insets, so it clears the navigation bar and rises with the
            // keyboard without reserving a strip of screen when idle.
            floating?.let { f ->
                Box(
                    Modifier
                        .align(Alignment.BottomCenter)
                        .windowInsetsPadding(
                            WindowInsets.ime
                                .union(WindowInsets.navigationBars)
                                .only(WindowInsetsSides.Bottom),
                        ),
                ) { f() }
            }
        }

        Box(
            Modifier
                .fillMaxWidth()
                .background(chrome)
                .windowInsetsPadding(
                    WindowInsets.ime
                        .union(WindowInsets.navigationBars)
                        .only(WindowInsetsSides.Bottom),
                ),
        ) { bottomBar?.invoke() }
    }
}
