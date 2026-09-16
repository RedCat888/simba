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
 * The search, drawn against the query it was built for.
 *
 * "wifi" is not an arbitrary fixture. He asked for a wifi-thru-walls project as
 * a note on a reel, asked for progress days later, and was told no such project
 * was tracked. The screen has to put that open request above everything else
 * that merely mentions the word — which is what the empty and no-match states
 * are checked for too, since a search that says nothing useful when it finds
 * nothing is where you stop trusting it.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-xxhdpi", application = android.app.Application::class)
class FindRenderTest(
    private val design: Design,
    private val state: String,
    private val body: @Composable () -> Unit,
) {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun draws() {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            SimbaTheme(design = design, dark = true) {
                Column(Modifier.fillMaxSize().background(Bg)) { body() }
            }
        }
        compose.mainClock.advanceTimeBy(900)
        ShadowLooper.idleMainLooper()

        val bitmap = compose.activity.window.decorView.snap()
        File(OUT, "find-${design.name.lowercase()}-$state.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        assertTrue(bitmap.width > 0 && bitmap.height > 0)
    }

    companion object {
        private val OUT = File("build/reports/screens").apply { mkdirs() }

        /** What the live endpoint returns for "wifi", plus neighbours. */
        private val HITS = listOf(
            Found(
                kind = "request", id = "r1", live = true, status = "open",
                title = "can you download and setup the project or code that lets wifi thru " +
                    "walls work that would be cool",
                subtitle = "reel:instagram", whenAt = "2026-07-23T05:41:00Z", score = 0.28,
            ),
            Found(
                kind = "mission", id = "m1", live = true, status = "blocked",
                title = "Rebuild the Simba Android app UI and UX",
                subtitle = "Make every screen answer a question worth opening the app for",
                whenAt = "2026-08-04T21:00:00Z", score = 0.11,
            ),
            Found(
                kind = "project", id = "p1", live = false, status = "repo",
                title = "home_surveillance", subtitle = "C:/example-workspace/home_surveillance",
                whenAt = "2018-03-26T11:02:00Z", score = 0.09,
            ),
            Found(
                kind = "capture", id = "c1", live = false, status = "done",
                title = "you can find anything seriously tho this site is unreal",
                subtitle = "https://www.instagram.com/reel/DSLeLc0gmMB/",
                whenAt = "2026-07-23T04:56:00Z", score = 0.07,
            ),
        )

        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}-{1}")
        fun cases(): List<Array<Any>> = Design.entries.flatMap { d ->
            listOf(
                arrayOf<Any>(d, "hits", @Composable { FindBody("wifi", HITS, false) }),
                arrayOf<Any>(d, "empty", @Composable { FindBody("", emptyList(), false) }),
                arrayOf<Any>(d, "nomatch", @Composable { FindBody("kubernetes", emptyList(), false) }),
            )
        }
    }
}

private fun View.snap(): Bitmap {
    val b = Bitmap.createBitmap(width.coerceAtLeast(1), height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
    draw(Canvas(b))
    return b
}
