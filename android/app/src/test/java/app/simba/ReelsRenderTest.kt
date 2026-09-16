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
import org.junit.Assert.assertEquals
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
 * The reel pipeline screen, in the three states that matter.
 *
 * "Off" is the one this screen exists for. The pipeline was dead for eleven
 * days and nothing anywhere said so — a list of processed reels looks identical
 * whether the thing is healthy or has not run since July, because the
 * difference is entirely in what is missing. So it is rendered here as a
 * first-class state rather than an error case.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-xxhdpi", application = android.app.Application::class)
class ReelsRenderTest(
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
        File(OUT, "reels-${design.name.lowercase()}-$state.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        assertTrue(bitmap.width > 0 && bitmap.height > 0)
    }

    companion object {
        private val OUT = File("build/reports/screens").apply { mkdirs() }

        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}-{1}")
        fun cases(): List<Array<Any>> = Design.entries.flatMap { d ->
            listOf(
                arrayOf<Any>(d, "working", @Composable { ReelsBody(WORKING) {} }),
                arrayOf<Any>(d, "off", @Composable { ReelsBody(OFF) {} }),
                arrayOf<Any>(d, "empty", @Composable { ReelsBody(EMPTY) {} }),
                arrayOf<Any>(d, "detail", @Composable { ReelDetailBody(DETAIL) }),
            )
        }
    }
}

/** Mid-backlog: some done, one still in the machine, more owed behind it. */
private val WORKING = ReelFeed(
    reachable = true,
    health = ReelHealth(loggedInAs = "sample-account", agents = 21, working = 2, owed = 5, items = 19),
    items = listOf(
        Reel(
            id = "20260805-193322_new-open-source-projects",
            title = "new open source projects",
            received = "20260805-193322",
            done = true,
            summary = "[tech] 5 New Open-Source Projects — solid batch. Instatic, a self-hosted " +
                "Framer alternative that outputs plain HTML; 4k stars, MIT.",
            hasNotes = true, hasMedia = true, frames = 10,
            sourceUrl = "https://www.instagram.com/p/DbaeuS8kizV/",
        ),
        Reel(
            id = "20260805-193711_college-starts-before-the-first-day",
            title = "college starts before the first day of c",
            received = "20260805-193711",
            done = false,
            hasMedia = true, frames = 7,
        ),
        Reel(
            id = "20260725-142551_pending",
            title = "pending",
            received = "20260725-142551",
            done = false,
            hasMedia = true, frames = 7,
        ),
    ),
)

/** The state that went unnoticed for eleven days. */
private val OFF = ReelFeed(reachable = false, items = emptyList())

private val EMPTY = ReelFeed(
    reachable = true,
    health = ReelHealth(loggedInAs = "sample-account", agents = 0, working = 0, owed = 0, items = 0),
)

private val DETAIL = ReelDetail(
    id = "20260805-193045_comment-world-and-ill-send-you-the-link",
    sourceUrl = "https://www.instagram.com/reel/DbpqF4UMeZp/",
    status = "[repo] World Monitor — legit, high-quality, 79k stars\n\n" +
        "• github.com/koala73/worldmonitor — free open-source global intelligence dashboard\n" +
        "• Pulls 500+ news feeds, live markets, shipping lanes\n" +
        "• cloned → repos/worldmonitor, full notes on PC\n" +
        "Reply \"run it\" to set it up.",
    notes = "The reel shows a dark dashboard with a rotating globe and does not name the repo " +
        "on screen at any point. The link is in the top comment, which is the usual pattern.",
    caption = "comment WORLD and I'll send you the link",
    transcript = "This is the most insane open source project I've seen this year.",
    comments = "@koala73 (1.2k likes): github.com/koala73/worldmonitor",
)

private fun View.snap(): Bitmap {
    val b = Bitmap.createBitmap(width.coerceAtLeast(1), height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
    draw(Canvas(b))
    return b
}

/** The folder name is the only metadata a half-processed item is guaranteed. */
class ReceivedFormatTest {
    @Test
    fun readsFolderStamps() {
        assertEquals("5 Aug 19:33", received("20260805-193322"))
        assertEquals("25 Jul 14:25", received("20260725-142551"))
        assertEquals("1 Jan 00:00", received("20260101-000000"))
    }

    @Test
    fun leavesUnrecognisableStampsAlone() {
        // Better a raw string on screen than a confidently wrong date.
        assertEquals("", received(""))
        assertEquals("pending", received("pending"))
        assertEquals("2026", received("2026"))
        assertEquals("20261305-120000", received("20261305-120000")) // month 13
    }
}
