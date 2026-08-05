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

/** Mission detail in the two states where the payload differs most. */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-xxhdpi", application = android.app.Application::class)
class MissionRenderTest(
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

        val b = compose.activity.window.decorView.let {
            val bm = Bitmap.createBitmap(it.width.coerceAtLeast(1), it.height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
            it.draw(Canvas(bm)); bm
        }
        File(OUT, "mission-${design.name.lowercase()}-$state.png").outputStream().use {
            b.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        assertTrue(b.width > 0)
    }

    companion object {
        private val OUT = File("build/reports/screens").apply { mkdirs() }

        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}-{1}")
        fun cases(): List<Array<Any>> = Design.entries.flatMap { d ->
            listOf(
                arrayOf<Any>(d, "blocked", @Composable { MissionBlockedFixture() }),
                arrayOf<Any>(d, "done", @Composable { MissionDoneFixture() }),
            )
        }
    }
}
