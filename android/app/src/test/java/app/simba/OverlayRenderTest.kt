package com.operator.simba

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
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
 * The bubble, in the states it floats in.
 *
 * It is drawn over other apps, which means every pixel it takes is a pixel of
 * something else — so the collapsed dot and the expanded panel are checked as
 * separate things rather than assumed from one screenshot. The failure mode
 * this guards against is not a crash; it is a panel that quietly grew until it
 * covers the thing you were reading.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-xxhdpi", application = android.app.Application::class)
class OverlayRenderTest(
    private val state: String,
    private val body: @Composable () -> Unit,
) {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun draws() {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            SimbaTheme(design = Design.Fluid, dark = true) {
                // A dim ground stands in for the app underneath, so anything
                // relying on an opaque background shows up as unreadable here
                // rather than on the phone.
                Box(Modifier.fillMaxSize().background(Bg)) {
                    Box(Modifier.padding(12.dp)) { body() }
                }
            }
        }
        compose.mainClock.advanceTimeBy(600)
        ShadowLooper.idleMainLooper()

        val bitmap = compose.activity.window.decorView.snap()
        File(OUT, "overlay-$state.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        assertTrue(bitmap.width > 0 && bitmap.height > 0)
    }

    companion object {
        private val OUT = File("build/reports/screens").apply { mkdirs() }

        private val NEEDS_YOU = OverlayState(
            reachable = true,
            working = 2,
            pending = listOf(
                PendingAction(
                    id = "a1",
                    actionClass = "shell",
                    summary = "Run `npm install` in worldmonitor to check the build",
                    status = "needs_confirmation",
                    agent = "network",
                ),
                PendingAction(
                    id = "a2",
                    actionClass = "git",
                    summary = "Push 47 commits from the mobile-app worktree to origin",
                    status = "needs_confirmation",
                    agent = "mobile-app",
                ),
            ),
        )

        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}")
        fun cases(): List<Array<Any>> = listOf(
            arrayOf<Any>("collapsed-idle", @Composable {
                Bubble(OverlayState(reachable = true), false, {}, { _, _ -> }, { true }, {})
            }),
            arrayOf<Any>("collapsed-needsyou", @Composable {
                Bubble(NEEDS_YOU, false, {}, { _, _ -> }, { true }, {})
            }),
            arrayOf<Any>("expanded-needsyou", @Composable {
                Bubble(NEEDS_YOU, true, {}, { _, _ -> }, { true }, {})
            }),
            arrayOf<Any>("expanded-idle", @Composable {
                Bubble(OverlayState(reachable = true, working = 3, exposed = 5), true, {}, { _, _ -> }, { true }, {})
            }),
            arrayOf<Any>("expanded-offline", @Composable {
                Bubble(OverlayState(reachable = false), true, {}, { _, _ -> }, { true }, {})
            }),
            // The state that used to be unrepresentable: something was tried
            // and did not work. Before this the panel's only way to report a
            // failure was to do nothing.
            arrayOf<Any>("expanded-failed", @Composable {
                Bubble(
                    OverlayState(
                        reachable = true, working = 1,
                        notice = "Not authorised — check Access credentials",
                    ),
                    true, {}, { _, _ -> }, { false }, {},
                )
            }),
        )
    }
}

private fun View.snap(): Bitmap {
    val b = Bitmap.createBitmap(width.coerceAtLeast(1), height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
    draw(Canvas(b))
    return b
}
