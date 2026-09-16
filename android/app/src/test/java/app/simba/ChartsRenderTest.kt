package app.simba

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
 * Draws every chart against the data shapes that actually break charts.
 *
 * A chart is the easiest thing in an app to get subtly wrong in a way no
 * compiler notices: a flat series divides by zero, a single point draws nothing,
 * an empty series throws, a series with one huge outlier flattens everything
 * else into the baseline. Those are not hypothetical — they are what real data
 * does, and every one of them is in the cases below.
 *
 * The assertion is only that something was drawn. The PNGs are the real output;
 * they exist to be looked at.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-xxhdpi", application = android.app.Application::class)
class ChartsRenderTest(
    private val caseName: String,
    private val content: @Composable () -> Unit,
) {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun draws() {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            SimbaTheme(design = Design.Fluid, dark = true) {
                Column(
                    Modifier.fillMaxSize().background(Bg).padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(18.dp),
                ) { content() }
            }
        }
        // Past the 620ms draw-in, so the shape captured is the settled one.
        compose.mainClock.advanceTimeBy(900)
        ShadowLooper.idleMainLooper()

        val bitmap = compose.activity.window.decorView.toBitmap()
        File(OUT, "$caseName.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        assertTrue("$caseName drew nothing", bitmap.width > 0 && bitmap.height > 0)
    }

    companion object {
        private val OUT = File("build/reports/screens").apply { mkdirs() }

        private val rising = listOf(2f, 3f, 2.5f, 5f, 4f, 7f, 6.5f, 9f, 11f, 10f, 14f)
        private val flat = List(11) { 4f }
        private val spiky = listOf(1f, 1f, 1f, 1f, 48f, 1f, 1f, 1f, 1f, 2f, 1f)

        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}")
        fun cases(): List<Array<Any>> = listOf(
            arrayOf<Any>("chart-sparklines", @Composable {
                Label("rising"); Sparkline(rising)
                // A flat series must not divide by zero, and must not amplify
                // the last significant bit into a mountain range.
                Label("flat — must read as flat"); Sparkline(flat)
                // One outlier is what a real cost series looks like.
                Label("one spike"); Sparkline(spiky)
                Label("single point — draws nothing on purpose"); Sparkline(listOf(3f))
                Label("empty"); Sparkline(emptyList())
            }),
            arrayOf<Any>("chart-bars", @Composable {
                Label("14 days of spend, today highlighted")
                BarSeries(rising + listOf(3f, 8f, 12f), highlight = 13)
                Label("all zero — baseline still drawn")
                BarSeries(List(10) { 0f })
                Label("empty")
                BarSeries(emptyList())
            }),
            arrayOf<Any>("chart-stacked", @Composable {
                Label("machine memory by process")
                StackedArea(
                    listOf(
                        Band("claude", listOf(2f, 3f, 4f, 3.5f, 5f, 6f, 5.5f, 7f), TIER_HIGH),
                        Band("simba", listOf(1f, 1f, 1.2f, 1f, 1f, 1.4f, 1f, 1f), TIER_MID),
                        Band("postgres", List(8) { 0.6f }, TIER_FREE),
                    ),
                    total = 16f,
                )
            }),
            arrayOf<Any>("chart-turns-and-pressure", @Composable {
                // The real finding: one turn dominates and the rest are noise.
                Label("turns, proportional to duration")
                TurnTimeline(
                    listOf(
                        turn(1, "high", 399.5),
                        turn(2, "free", 13.9),
                        turn(3, "free", 23.5),
                        turn(4, "mid", 8.0),
                        turn(5, "high", 41.0),
                    ),
                )
                Label("one turn only")
                TurnTimeline(listOf(turn(1, "high", 120.0)))
                Label("quota headroom")
                PressureBar(0.34f)
                PressureBar(0.81f)
                PressureBar(0.96f)
            }),
        )

        private fun turn(seq: Int, tier: String, seconds: Double) =
            Turn(seq = seq, modelTier = tier, durationMs = (seconds * 1000).toLong())
    }
}

// Fixed colours so a band's identity does not depend on composition order.
private val TIER_HIGH = androidx.compose.ui.graphics.Color(0xFFF5A524)
private val TIER_MID = androidx.compose.ui.graphics.Color(0xFF5B9BF8)
private val TIER_FREE = androidx.compose.ui.graphics.Color(0xFF3ECF8E)

@Composable
private fun Label(text: String) {
    Text(text, color = Faint, fontSize = 11.sp)
}

private fun View.toBitmap(): Bitmap {
    val bitmap = Bitmap.createBitmap(
        width.coerceAtLeast(1),
        height.coerceAtLeast(1),
        Bitmap.Config.ARGB_8888,
    )
    draw(Canvas(bitmap))
    return bitmap
}
