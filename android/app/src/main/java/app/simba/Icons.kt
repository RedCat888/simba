package app.simba

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * Simba's own icons, drawn for the Fluid design.
 *
 * Material's icon set is the right choice inside the Material design — using
 * Google's components *and* Google's icons is what that design is — but shipping
 * the same five stock glyphs in all three is how three designs quietly become
 * one. Console solves it by having no icons at all, which is honest for a
 * terminal. Fluid needs its own.
 *
 * These are open strokes with round caps and joins, at a single weight, built
 * from circles and straight runs on a common grid. That reads as one family
 * rather than five separate drawings, and it matches a design whose whole
 * argument is soft geometry and motion — Material's icons are filled, tightly
 * optically-corrected shapes that fight that.
 *
 * All paths are stroked in black and tinted at draw time, because [Icon] applies
 * a colour filter over the whole vector; the declared colour here never shows.
 */
private const val STROKE = 1.85f

private fun simbaIcon(
    name: String,
    fill: (PathBuilder.() -> Unit)? = null,
    stroke: PathBuilder.() -> Unit,
): ImageVector = ImageVector.Builder(
    name = name,
    defaultWidth = 24.dp,
    defaultHeight = 24.dp,
    viewportWidth = 24f,
    viewportHeight = 24f,
).apply {
    path(
        stroke = SolidColor(Color.Black),
        strokeLineWidth = STROKE,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
        pathBuilder = stroke,
    )
    fill?.let {
        path(fill = SolidColor(Color.Black), pathFillType = PathFillType.NonZero, pathBuilder = it)
    }
}.build()

/** A full circle as two half arcs — the primitive most of these are built from. */
private fun PathBuilder.circle(cx: Float, cy: Float, r: Float) {
    moveTo(cx - r, cy)
    arcTo(r, r, 0f, false, true, cx + r, cy)
    arcTo(r, r, 0f, false, true, cx - r, cy)
    close()
}

object SimbaIcons {

    /** Chat: a speech surface with a tail, drawn as one continuous stroke. */
    val Chat: ImageVector by lazy {
        simbaIcon("simba_chat") {
            moveTo(8f, 4.6f)
            horizontalLineTo(16f)
            arcTo(4f, 4f, 0f, false, true, 20f, 8.6f)
            verticalLineTo(11.8f)
            arcTo(4f, 4f, 0f, false, true, 16f, 15.8f)
            horizontalLineTo(12.6f)
            lineTo(8.3f, 19.6f)
            verticalLineTo(15.8f)
            arcTo(4f, 4f, 0f, false, true, 4f, 11.8f)
            verticalLineTo(8.6f)
            arcTo(4f, 4f, 0f, false, true, 8f, 4.6f)
            close()
        }
    }

    /**
     * Missions: a target.
     *
     * A mission is an objective with an end condition, not an event — concentric
     * rings say "converging on something" where a lightning bolt says "fast",
     * which is the wrong claim for work that runs for hours.
     */
    val Missions: ImageVector by lazy {
        simbaIcon("simba_missions", fill = { circle(12f, 12f, 2.1f) }) {
            circle(12f, 12f, 8.4f)
            circle(12f, 12f, 4.6f)
        }
    }

    /** Agents: three nodes that know about each other. */
    val Agents: ImageVector by lazy {
        simbaIcon("simba_agents") {
            circle(12f, 5.4f, 2.7f)
            circle(5.6f, 17.4f, 2.7f)
            circle(18.4f, 17.4f, 2.7f)
            moveTo(10.6f, 7.9f)
            lineTo(7f, 14.9f)
            moveTo(13.4f, 7.9f)
            lineTo(17f, 14.9f)
            moveTo(8.3f, 17.4f)
            horizontalLineTo(15.7f)
        }
    }

    /** Knowledge: strata, because it is the thing that accumulates. */
    val Knowledge: ImageVector by lazy {
        simbaIcon("simba_knowledge") {
            moveTo(3.6f, 18.6f)
            arcTo(8.4f, 8.4f, 0f, false, true, 20.4f, 18.6f)
            moveTo(7.2f, 18.6f)
            arcTo(4.8f, 4.8f, 0f, false, true, 16.8f, 18.6f)
            moveTo(10.6f, 18.6f)
            arcTo(1.4f, 1.4f, 0f, false, true, 13.4f, 18.6f)
        }
    }

    /**
     * System: rails and knobs.
     *
     * The System screen is where things get set, so it is a control surface
     * rather than a machine — sliders say "you may change this", a gear says
     * "settings" in the vague way every app's gear does.
     */
    val System: ImageVector by lazy {
        simbaIcon(
            "simba_system",
            fill = {
                circle(9.2f, 7f, 2.15f)
                circle(15.6f, 12f, 2.15f)
                circle(7.4f, 17f, 2.15f)
            },
        ) {
            moveTo(3.6f, 7f)
            horizontalLineTo(20.4f)
            moveTo(3.6f, 12f)
            horizontalLineTo(20.4f)
            moveTo(3.6f, 17f)
            horizontalLineTo(20.4f)
        }
    }

    /** Back, as a stroke rather than Material's filled triangle-and-bar. */
    val Back: ImageVector by lazy {
        simbaIcon("simba_back") {
            moveTo(14.5f, 5.5f)
            lineTo(8f, 12f)
            lineTo(14.5f, 18.5f)
        }
    }

    /** Send: an open chevron, pointing the way the message goes. */
    val Send: ImageVector by lazy {
        simbaIcon("simba_send") {
            moveTo(4.2f, 12f)
            horizontalLineTo(19f)
            moveTo(13f, 6f)
            lineTo(19.4f, 12f)
            lineTo(13f, 18f)
        }
    }
}
