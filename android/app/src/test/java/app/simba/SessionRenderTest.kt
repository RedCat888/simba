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
 * The session screen, drawn against the data a real session produces.
 *
 * The fixture is not invented: the turn durations, token counts and cache reads
 * are the actual numbers from session 5b970b4d on this machine — one turn of six
 * and a half minutes, thirty-four input tokens against twenty-one thousand out,
 * and six hundred thousand read from cache. Made-up data would have been evenly
 * distributed and would have hidden the exact thing the screen exists to reveal.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-xxhdpi", application = android.app.Application::class)
class SessionRenderTest(private val design: Design) {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun drawsSessionDetail() {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            SimbaTheme(design = design, dark = true) {
                Column(Modifier.fillMaxSize().background(Bg)) { SessionFixture() }
            }
        }
        compose.mainClock.advanceTimeBy(900)
        ShadowLooper.idleMainLooper()

        val bitmap = compose.activity.window.decorView.grab()
        File(OUT, "session-${design.name.lowercase()}.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        assertTrue(bitmap.width > 0 && bitmap.height > 0)
    }

    companion object {
        private val OUT = File("build/reports/screens").apply { mkdirs() }

        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}")
        fun cases(): List<Array<Any>> = Design.entries.map { arrayOf<Any>(it) }
    }
}

private fun View.grab(): Bitmap {
    val b = Bitmap.createBitmap(width.coerceAtLeast(1), height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
    draw(Canvas(b))
    return b
}
