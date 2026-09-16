package app.simba

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
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
 * The screens at the font sizes people actually use.
 *
 * Android's display settings go to 2x, and the people who turn that on leave it
 * on permanently. Every layout decision in this app was made at 1x and looked at
 * once at 1x.
 *
 * This exists because of a specific claim. The session stat tiles were changed
 * from four across to two by two, and the reason given was that four would stop
 * fitting the moment the font scale was raised. That was an argument, not a
 * measurement, and it went in unverified — so here is the measurement.
 *
 * 1.3 is the common case (Android's second-largest step). 2.0 is the ceiling.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-xxhdpi", application = android.app.Application::class)
class FontScaleRenderTest(
    private val scale: Float,
    private val screen: String,
    private val body: @Composable () -> Unit,
) {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun draws() {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            val base = LocalDensity.current
            CompositionLocalProvider(
                LocalDensity provides Density(base.density, fontScale = scale),
            ) {
                SimbaTheme(design = Design.Fluid, dark = true) {
                    Column(Modifier.fillMaxSize().background(Bg)) { body() }
                }
            }
        }
        compose.mainClock.advanceTimeBy(900)
        ShadowLooper.idleMainLooper()

        val v = compose.activity.window.decorView
        val b = Bitmap.createBitmap(v.width.coerceAtLeast(1), v.height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        v.draw(Canvas(b))
        val tag = scale.toString().replace('.', '_')
        File(OUT, "scale$tag-$screen.png").outputStream().use {
            b.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        assertTrue(b.width > 0)
    }

    companion object {
        private val OUT = File("build/reports/screens").apply { mkdirs() }

        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{1}@{0}x")
        fun cases(): List<Array<Any>> = listOf(1.3f, 2.0f).flatMap { s ->
            listOf(
                // The screen whose layout the 2x2 claim was about.
                arrayOf<Any>(s, "session", @Composable { SessionFixture() }),
                // The landing screen, and the one with the most competing text.
                arrayOf<Any>(s, "now", @Composable { NowBusyFixture() }),
                // A mission, which stacks a rail, meters and a button row.
                arrayOf<Any>(s, "mission", @Composable { MissionBlockedFixture() }),
            )
        }
    }
}
