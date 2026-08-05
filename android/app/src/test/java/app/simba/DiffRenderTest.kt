package com.operator.simba

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
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

/** The diff view, whose colours are theme-derived and therefore worth looking at. */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-xxhdpi", application = android.app.Application::class)
class DiffRenderTest(private val design: Design) {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun draws() {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            SimbaTheme(design = design, dark = true) {
                Column(Modifier.fillMaxSize().background(Bg)) { DiffFixture() }
            }
        }
        compose.mainClock.advanceTimeBy(900)
        ShadowLooper.idleMainLooper()

        val v = compose.activity.window.decorView
        val b = Bitmap.createBitmap(v.width.coerceAtLeast(1), v.height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        v.draw(Canvas(b))
        File(OUT, "diff-${design.name.lowercase()}.png").outputStream().use {
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
