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
 * The inventory, drawn from what the first real scan actually returned.
 *
 * Using the real findings rather than invented ones matters here: the case the
 * screen exists for is a repository with no remote at all, and that turned out
 * to be ReelAgent — the project that had just had a fortnight of durability work
 * done to it, sitting on one disk. An invented fixture would have had a tidier
 * example and would not have shown that the sharpest row is the one whose
 * unpushed count has no remote to be counted against.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-xxhdpi", application = android.app.Application::class)
class ProjectsRenderTest(
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
        File(OUT, "projects-${design.name.lowercase()}-$state.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        assertTrue(bitmap.width > 0 && bitmap.height > 0)
    }

    companion object {
        private val OUT = File("build/reports/screens").apply { mkdirs() }

        /** Exactly what the scan reported on 15 August. */
        private val REAL = listOf(
            Project(
                id = "p1", slug = "simba", name = "Simba itself", rootPath = "C:\\Users\\operator\\simba",
                gitRemote = "https://github.com/PROJECT_OWNER/simba.git", branch = "master",
                dirtyFiles = 5, unpushed = 6, atRisk = true, owner = "simba",
                lastCommitAt = "2026-08-15T09:12:00Z",
            ),
            Project(
                id = "p2", slug = "reelagent", name = "Instagram intake (legacy)",
                rootPath = "C:\\Users\\operator\\ReelAgent", gitRemote = null, branch = "master",
                dirtyFiles = 0, unpushed = 2, atRisk = true,
                lastCommitAt = "2026-08-15T09:44:00Z",
            ),
            Project(
                id = "p3", slug = "home-surveillance", name = "home_surveillance",
                rootPath = "C:\\Users\\operator\\home_surveillance",
                gitRemote = "https://github.com/PROJECT_OWNER/home_surveillance.git", branch = "master",
                dirtyFiles = 11, unpushed = 0, atRisk = true,
                lastCommitAt = "2018-03-26T11:02:00Z",
            ),
            Project(
                id = "p4", slug = "knowledge-mcp", name = "knowledge-mcp",
                rootPath = "C:\\Users\\operator\\Documents\\Codex\\2026-07-02\\knowledge-mcp",
                gitRemote = "https://github.com/PROJECT_OWNER/knowledge-mcp.git", branch = "main",
                lastCommitAt = "2026-07-03T14:00:00Z",
            ),
            Project(
                id = "p5", slug = "gyrosteeringapp", name = "GyroSteeringApp",
                rootPath = "C:\\Users\\operator\\GyroSteeringApp",
                scanError = "not readable as a git repository",
            ),
        )

        private val CLEAR = REAL.map {
            it.copy(dirtyFiles = 0, unpushed = 0, atRisk = false, scanError = null,
                    gitRemote = it.gitRemote ?: "https://github.com/PROJECT_OWNER/x.git")
        }

        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}-{1}")
        fun cases(): List<Array<Any>> = Design.entries.flatMap { d ->
            listOf(
                arrayOf<Any>(d, "atrisk", @Composable { ProjectsBody(REAL) }),
                arrayOf<Any>(d, "clear", @Composable { ProjectsBody(CLEAR) }),
                arrayOf<Any>(d, "scanning", @Composable { ProjectsBody(REAL, scanning = true) }),
            )
        }
    }
}

private fun View.snap(): Bitmap {
    val b = Bitmap.createBitmap(width.coerceAtLeast(1), height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
    draw(Canvas(b))
    return b
}
