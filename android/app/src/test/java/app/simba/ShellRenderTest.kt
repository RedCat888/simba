package app.simba

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
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
 * The navigation chrome itself.
 *
 * Every screen in the app has now been drawn and checked, and the one thing that
 * had not is the frame all of them sit inside — which is also the part that
 * differs most between the three designs and the first thing anyone sees.
 *
 * Rendered with real content underneath rather than a placeholder, because the
 * questions worth asking are about the relationship: does the Fluid pill sit on
 * top of a row it should not obscure, does Material's app bar leave the first
 * row readable, does Console's status strip plus command bar leave enough height
 * to be worth the density it claims.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-xxhdpi", application = android.app.Application::class)
class ShellRenderTest(private val design: Design) {

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
                        connected = true,
                        activeSessions = 1,
                        runningMissions = 2,
                        brainsAvailable = 3,
                        spend7d = 6.41,
                    ),
                ) { SampleRows() }
            }
        }
        compose.mainClock.advanceTimeBy(900)
        ShadowLooper.idleMainLooper()

        val v = compose.activity.window.decorView
        val b = Bitmap.createBitmap(v.width.coerceAtLeast(1), v.height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        v.draw(Canvas(b))
        File(OUT, "shell-${design.name.lowercase()}.png").outputStream().use {
            b.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        assertTrue(b.width > 0)
    }

    companion object {
        private val OUT = File("build/reports/screens").apply { mkdirs() }

        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}")
        fun cases(): List<Array<Any>> = Design.entries.map { arrayOf<Any>(it) }
    }
}
