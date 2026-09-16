package app.simba

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
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
 * A reply with markdown in it, drawn.
 *
 * The parse tests prove the markers come off and the spans go on; they cannot
 * show that the result is legible — that a heading is distinguishable from the
 * paragraph under it, that inline code has room to breathe inside a line, that
 * a bullet's text lines up. That needs eyes on a bitmap, which is what the rest
 * of this suite already does for every other screen.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-xxhdpi", application = android.app.Application::class)
class MarkdownRenderTest(private val design: Design) {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun draws() {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            SimbaTheme(design = design, dark = true) {
                Column(Modifier.fillMaxSize().background(Bg).padding(space.gutter)) {
                    MessageBody(REPLY, color = Fg)
                }
            }
        }
        compose.mainClock.advanceTimeBy(900)
        ShadowLooper.idleMainLooper()

        val v = compose.activity.window.decorView
        val b = Bitmap.createBitmap(
            v.width.coerceAtLeast(1),
            v.height.coerceAtLeast(1),
            Bitmap.Config.ARGB_8888,
        )
        v.draw(Canvas(b))
        File(OUT, "markdown-${design.name.lowercase()}.png").outputStream().use {
            b.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        assertTrue(b.width > 0)
    }

    companion object {
        private val OUT = File("build/reports/screens").apply { mkdirs() }

        /** Deliberately the shape of a real answer, not a formatting sampler. */
        private val REPLY = """
            ## What I found

            The payload **is** accepted. The row lands in `missions` with
            `status='planning'` and no steps — the plan arrives later.

            - `acceptance_criteria` survived the round trip
            - the planner took 2m14s, which the UI shows as nothing happening
            - port 8788 was never exercised

            > Cancelled-but-present is the correct end state.

            ```sql
            SELECT count(*) FROM mission_steps WHERE mission_id = ${'$'}1;
            ```

            Next: decide whether _resuming_ it is safe. See [the route](https://x.test).
        """.trimIndent()

        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}")
        fun cases(): List<Array<Any>> = Design.entries.map { arrayOf<Any>(it) }
    }
}
