package app.simba

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
 * Screens drawn inside the shell that actually hosts them.
 *
 * Every other render test composes a screen body on a bare background, which
 * checks the screen and says nothing about how the shell puts it on screen.
 * That gap had a real cost: the action-failure banner was added to the shell as
 * a sibling of the content, and Fluid hands its content slot to
 * `Box(Modifier.fillMaxSize())` — so the banner would have been drawn
 * *underneath* a full-size screen and never seen. An invisible notice about
 * invisible failures, caught by reading FluidShell rather than by any test.
 *
 * So this composes the real thing: the real shell, the real banner placement,
 * one screen inside it, in all three designs. What it is looking for is not a
 * crash — it is content that covers other content, which only a picture shows.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-xxhdpi", application = android.app.Application::class)
class ShellCompositionTest(
    private val design: Design,
    private val state: String,
    private val failure: String?,
) {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun draws() {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            SimbaTheme(design = design, dark = true) {
                DesignShell(
                    design = design,
                    current = Destination.Now,
                    onNavigate = {},
                    status = ShellStatus(
                        connected = true, activeSessions = 1, runningMissions = 2,
                        brainsAvailable = 6, spend7d = 14.17,
                    ),
                ) {
                    // Exactly the arrangement SimbaRoot uses, so a change there
                    // that reintroduces the overlap fails here.
                    Column(Modifier.fillMaxSize()) {
                        ActionFailure(failure) {}
                        NowQuietFixture()
                    }
                }
            }
        }
        compose.mainClock.advanceTimeBy(900)
        ShadowLooper.idleMainLooper()

        val bitmap = compose.activity.window.decorView.snap()
        File(OUT, "shell-${design.name.lowercase()}-$state.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        assertTrue(bitmap.width > 0 && bitmap.height > 0)
    }

    companion object {
        private val OUT = File("build/reports/screens").apply { mkdirs() }

        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}-{1}")
        fun cases(): List<Array<Any?>> = Design.entries.flatMap { d ->
            listOf(
                arrayOf<Any?>(d, "clean", null),
                arrayOf<Any?>(d, "actionfailed", "already claimed — the desktop answered this one first"),
            )
        }
    }
}

private fun View.snap(): Bitmap {
    val b = Bitmap.createBitmap(width.coerceAtLeast(1), height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
    draw(Canvas(b))
    return b
}
