package com.operator.simba

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowLooper
import java.io.File

/**
 * Renders every screen in every design, on the JVM, and writes a PNG of each.
 *
 * The emulator on this machine crashes at startup, but even a working one is the
 * wrong tool for the question being asked here. The question is not "does it
 * run" — the build answers that — it is "does each of the three designs look
 * right on each screen", which is fifteen combinations that would otherwise be
 * checked by hand once and never again.
 *
 * Two things are asserted per combination, and they are deliberately weak:
 *
 *   - it renders at all, without throwing. Most Compose mistakes that survive
 *     the compiler are runtime ones — reading a CompositionLocal outside
 *     composition, a lazy list built from a non-composable lambda, an infinite
 *     constraint — and every one of those throws here rather than on your phone.
 *   - the result is not one flat colour. A screen that "renders" as a solid
 *     background is the classic symptom of content laid out at zero height or
 *     drawn off screen, and no assertion about composition succeeding sees it.
 *
 * Anything finer would be a pixel baseline, which on a UI still being shaped is
 * a test that fails every time the work goes well. The PNGs exist for a person
 * to look at; the assertions exist to fail the build when a screen stops
 * drawing.
 *
 * Parameterized rather than looped: `setContent` may only be called once per
 * test, so a loop over fifteen combinations renders the first and reports
 * "Cannot call setContent twice" for the other fourteen — which reads as
 * fourteen broken screens when only the harness was wrong.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(
    sdk = [34],
    qualifiers = "w411dp-h914dp-xxhdpi",
    // The plain Application, not SimbaApp: its onCreate schedules WorkManager
    // polling, which on a device is initialised by a content provider that does
    // not exist here. Nothing being drawn needs it.
    application = android.app.Application::class,
)
class ScreensRenderTest(
    private val design: Design,
    private val screenName: String,
    private val screen: @Composable () -> Unit,
) {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun renders() {
        val label = "${design.name.lowercase()}-$screenName"

        // Hand-driven rather than automatic. Fluid's loading skeleton pulses on
        // a rememberInfiniteTransition, and an infinite animation is never idle
        // by definition — anything that waits for idle waits forever. Advancing
        // the clock settles every finite animation (a row's press spring, an
        // expansion) and leaves the infinite ones mid-cycle, which is what they
        // look like on a real screen anyway.
        compose.mainClock.autoAdvance = false
        compose.setContent {
            SimbaTheme(design = design, dark = true) {
                // On the bare activity window the background is white, so every
                // screenshot showed dark chrome floating on a colour the app
                // never draws. SimbaShell paints this in the real app.
                Column(Modifier.fillMaxSize().background(Bg)) { screen() }
            }
        }
        compose.mainClock.advanceTimeBy(1_200)
        ShadowLooper.idleMainLooper()

        val root = compose.activity.window.decorView
        val bitmap = root.drawToBitmap()
        File(OUT, "$label.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }

        assertTrue("$label rendered nothing", bitmap.width > 0 && bitmap.height > 0)
        assertTrue("$label is a single flat colour — nothing drew", bitmap.hasDetail())
    }

    companion object {
        private val OUT = File("build/reports/screens").apply { mkdirs() }

        /** Every surface that can be drawn without a live gateway behind it. */
        private val SCREENS: List<Pair<String, @Composable () -> Unit>> = listOf(
            "rows" to { SampleRows() },
            "empty" to { EmptyState("No missions yet", "A mission is an objective that runs itself.") },
            "loading" to { LoadingState() },
            "failure" to { FailureState("Cannot reach Simba") },
            "chat" to { SampleChat() },
        )

        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}-{1}")
        fun cases(): List<Array<Any>> = Design.entries.flatMap { design ->
            SCREENS.map { (name, screen) -> arrayOf<Any>(design, name, screen) }
        }
    }
}

/**
 * Draw a view hierarchy onto a bitmap.
 *
 * Compose's own `captureToImage()` goes through PixelCopy, which needs a real
 * surface and simply times out with no window behind it. Drawing to a Canvas is
 * the same pixels by a route that does not care whether a display exists.
 */
private fun View.drawToBitmap(): Bitmap {
    val w = width.coerceAtLeast(1)
    val h = height.coerceAtLeast(1)
    val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    draw(Canvas(bitmap))
    return bitmap
}

/**
 * Does this bitmap contain more than one colour?
 *
 * Sampled on a grid rather than read whole: a full-screen scan of every pixel is
 * a million reads per screenshot for a question two differing pixels answer.
 */
private fun Bitmap.hasDetail(): Boolean {
    val first = getPixel(0, 0)
    for (x in 0 until width step 8) {
        for (y in 0 until height step 8) {
            if (getPixel(x, y) != first) return true
        }
    }
    return false
}
