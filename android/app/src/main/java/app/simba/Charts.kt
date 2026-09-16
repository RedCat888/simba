package app.simba

import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Data, drawn.
 *
 * Every chart here is a Canvas and about forty lines. That is deliberate: a
 * charting dependency brings a theme, an animation model and an interaction
 * model that are all somebody else's, and fighting those to match a design costs
 * more than drawing the four shapes this app actually needs. It also means the
 * charts share the app's palette, its motion timing and its idea of a baseline
 * rather than approximating them.
 *
 * Three rules hold across all of them:
 *
 *   - **A flat series is not an error.** Real data is flat all the time — a
 *     brain that cost nothing for six days, memory that did not move. Dividing
 *     by (max - min) is how a chart becomes a divide-by-zero or a wall of noise
 *     amplifying the last significant bit. Every scale here guards it and draws
 *     a flat line through the middle, which is the truth.
 *   - **Draw on appear, once.** Animation here is to show the shape arriving,
 *     not to entertain. It runs a little over half a second on a curve that
 *     decelerates, and it does not repeat.
 *   - **Nothing is drawn outside the bounds.** Stroke width is inset from the
 *     edges rather than clipped, so a peak at the maximum is a peak rather than
 *     a flat line where the stroke got cut.
 */

/** Maps a value domain onto a pixel range, tolerating a domain of zero width. */
private class Scale(values: List<Float>, private val pixels: Float, private val inset: Float) {
    private val lo = values.minOrNull() ?: 0f
    private val hi = values.maxOrNull() ?: 0f
    private val span = (hi - lo).takeIf { it > 0.0001f }

    /** y grows downward, so the maximum sits at the top. */
    fun y(v: Float): Float {
        val usable = pixels - inset * 2
        // A flat series centres rather than pinning to an edge: a line along the
        // top reads as "at maximum", which is a claim the data is not making.
        val t = span?.let { (v - lo) / it } ?: 0.5f
        return inset + usable * (1f - t)
    }
}

/** Progress 0..1 that runs once when a chart first appears. */
@Composable
private fun drawIn(key: Any?): Float {
    var started by remember(key) { mutableStateOf(false) }
    LaunchedEffect(key) { started = true }
    val p by animateFloatAsState(
        if (started) 1f else 0f,
        tween(durationMillis = 620, easing = LinearOutSlowInEasing),
        label = "chart-draw-in",
    )
    return p
}

/**
 * A line with no axes, no labels and no grid.
 *
 * For a number that is already stated beside it — the sparkline says which way
 * it has been going, and that is all it is for. Adding a scale would make it a
 * chart, which is a different component with different space requirements.
 */
@Composable
fun Sparkline(
    values: List<Float>,
    modifier: Modifier = Modifier,
    color: Color = Accent,
    height: Dp = 34.dp,
    /** A soft wash under the line. Off for dense rows where it becomes noise. */
    filled: Boolean = true,
) {
    if (values.size < 2) {
        // One point is a value, not a trend, and a single dot pretending to be a
        // chart is worse than the space being empty.
        Canvas(modifier.fillMaxWidth().height(height)) {}
        return
    }
    val progress = drawIn(values)

    Canvas(modifier.fillMaxWidth().height(height)) {
        val stroke = 1.8.dp.toPx()
        val scale = Scale(values, size.height, stroke)
        val stepX = size.width / (values.size - 1)
        val shown = (values.size * progress).toInt().coerceAtLeast(2)

        val line = Path().apply {
            for (i in 0 until shown) {
                val x = stepX * i
                val y = scale.y(values[i])
                if (i == 0) moveTo(x, y) else lineTo(x, y)
            }
        }

        if (filled) {
            val area = Path().apply {
                addPath(line)
                lineTo(stepX * (shown - 1), size.height)
                lineTo(0f, size.height)
                close()
            }
            drawPath(
                area,
                Brush.verticalGradient(
                    listOf(color.copy(alpha = 0.22f), color.copy(alpha = 0f)),
                    endY = size.height,
                ),
            )
        }
        drawPath(line, color, style = Stroke(width = stroke, cap = StrokeCap.Round))
    }
}

/**
 * Bars from a shared baseline, one per period.
 *
 * The baseline is drawn even where every bar is zero, because "nothing happened
 * on these days" and "this chart failed to load" must not look the same.
 */
@Composable
fun BarSeries(
    values: List<Float>,
    modifier: Modifier = Modifier,
    color: Color = Accent,
    height: Dp = 56.dp,
    /** Drawn in the accent; everything else in a muted tone. Usually "today". */
    highlight: Int? = null,
) {
    val progress = drawIn(values)
    // Read outside the draw lambda: DrawScope is not a composable scope, and the
    // palette aliases are composable getters.
    val rule = Faint.copy(alpha = 0.35f)

    Canvas(modifier.fillMaxWidth().height(height)) {
        val baseline = size.height - 1.dp.toPx()
        drawLine(
            rule,
            Offset(0f, baseline),
            Offset(size.width, baseline),
            strokeWidth = 1.dp.toPx(),
        )
        if (values.isEmpty()) return@Canvas

        val max = values.maxOrNull()?.takeIf { it > 0f } ?: return@Canvas
        val slot = size.width / values.size
        val bar = (slot * 0.56f).coerceAtMost(14.dp.toPx())
        val radius = bar / 2f

        values.forEachIndexed { i, v ->
            val full = (v / max) * (baseline - 2.dp.toPx())
            val h = full * progress
            if (h <= 0.5f) return@forEachIndexed
            val x = slot * i + (slot - bar) / 2f
            drawRoundRect(
                color = if (i == highlight) color else color.copy(alpha = 0.34f),
                topLeft = Offset(x, baseline - h),
                size = Size(bar, h),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(radius, radius),
            )
        }
    }
}

/** One named band in a stacked area. */
data class Band(val label: String, val values: List<Float>, val color: Color)

/**
 * Stacked bands over time — what is consuming the machine.
 *
 * Stacked rather than overlaid because the question is "what is the total, and
 * whose is it", and overlaid lines answer neither at a glance. Drawn back to
 * front so the largest contributor sits underneath and the reading is
 * cumulative, which is what a stack means.
 */
@Composable
fun StackedArea(
    bands: List<Band>,
    modifier: Modifier = Modifier,
    height: Dp = 96.dp,
    /** The ceiling. Without it the stack rescales every refresh and reads as noise. */
    total: Float? = null,
) {
    val points = bands.firstOrNull()?.values?.size ?: 0
    if (points < 2 || bands.isEmpty()) {
        Canvas(modifier.fillMaxWidth().height(height)) {}
        return
    }
    val progress = drawIn(bands.map { it.values })

    Canvas(modifier.fillMaxWidth().height(height)) {
        val stepX = size.width / (points - 1)
        val ceiling = total
            ?: (0 until points).maxOf { i -> bands.sumOf { it.values.getOrElse(i) { 0f }.toDouble() } }
                .toFloat().takeIf { it > 0f }
            ?: return@Canvas

        val shown = (points * progress).toInt().coerceAtLeast(2)
        val running = FloatArray(points)

        for (band in bands) {
            val top = Path()
            for (i in 0 until shown) {
                val v = running[i] + band.values.getOrElse(i) { 0f }
                val y = size.height * (1f - (v / ceiling).coerceIn(0f, 1f))
                if (i == 0) top.moveTo(0f, y) else top.lineTo(stepX * i, y)
            }
            // Close down the previous band's ceiling, walking back, so the fill
            // is the band itself rather than everything beneath it.
            for (i in shown - 1 downTo 0) {
                val y = size.height * (1f - (running[i] / ceiling).coerceIn(0f, 1f))
                top.lineTo(stepX * i, y)
            }
            top.close()
            drawPath(top, band.color.copy(alpha = 0.55f))

            for (i in 0 until points) running[i] += band.values.getOrElse(i) { 0f }
        }
    }
}

/**
 * A session's turns, laid out in proportion to how long each took.
 *
 * Proportional rather than one-slot-per-turn because that is the whole finding:
 * a session is usually one turn that took six minutes and four that took
 * seconds, and equal slots hide exactly the thing worth seeing. Colour carries
 * the model tier, so a brain swap mid-session is visible as a change in the band
 * rather than something you have to read a table to discover.
 */
@Composable
fun TurnTimeline(
    turns: List<Turn>,
    modifier: Modifier = Modifier,
    height: Dp = 12.dp,
    tierColor: @Composable (String?) -> Color = { defaultTierColor(it) },
) {
    if (turns.isEmpty()) return
    val progress = drawIn(turns)
    val colors = turns.map { tierColor(it.modelTier) }
    // A turn still running has no duration yet; giving it zero would make it
    // vanish from the one view meant to show it is happening.
    val spans = turns.map { it.seconds.toFloat().coerceAtLeast(0.5f) }
    val total = spans.sum().takeIf { it > 0f } ?: return

    Canvas(modifier.fillMaxWidth().height(height)) {
        val gap = 1.5.dp.toPx()
        val radius = size.height / 2f
        var x = 0f
        spans.forEachIndexed { i, span ->
            val w = (size.width * (span / total)) - gap
            if (w > 0.5f) {
                drawRoundRect(
                    color = colors[i],
                    topLeft = Offset(x, 0f),
                    size = Size(w * progress, size.height),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(radius, radius),
                )
            }
            x += w + gap
        }
    }
}

/**
 * A bar showing how much of a budget is gone.
 *
 * Used for quota headroom and memory pressure, which are the same shape of fact.
 * Turns amber then red on its own rather than at the call site, so every
 * pressure bar in the app agrees about when to be alarming.
 */
@Composable
fun PressureBar(
    fraction: Float,
    modifier: Modifier = Modifier,
    height: Dp = 6.dp,
    track: Color = Panel2,
) {
    val target = fraction.coerceIn(0f, 1f)
    val shown by animateFloatAsState(target, tween(620, easing = LinearOutSlowInEasing), label = "pressure")
    val tone = when {
        target >= 0.9f -> Err
        target >= 0.75f -> Warn
        else -> Accent
    }
    Canvas(modifier.fillMaxWidth().height(height)) {
        val r = size.height / 2f
        drawRoundRect(track, size = size, cornerRadius = androidx.compose.ui.geometry.CornerRadius(r, r))
        if (shown > 0f) {
            drawRoundRect(
                tone,
                size = Size(size.width * shown, size.height),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(r, r),
            )
        }
    }
}

/** A dashed rule, for a threshold or a "now" marker. */
fun DrawScope.dashedRule(y: Float, color: Color) {
    drawLine(
        color,
        Offset(0f, y),
        Offset(size.width, y),
        strokeWidth = 1f,
        pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f)),
    )
}

/**
 * Tier as colour, in one place.
 *
 * Free work costing nothing is the system working as designed, so it reads as
 * good rather than as lesser; the expensive tier is the accent because that is
 * the one worth noticing on a bill.
 */
@Composable
fun defaultTierColor(tier: String?): Color = when (tier) {
    "high" -> Accent
    "mid" -> Info
    "free", "low" -> Ok
    else -> Faint
}
