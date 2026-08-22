package com.operator.simba

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/**
 * Bounded text presentation.
 *
 * Long bodies used to be dumped into a raw [Text] with no ceiling, and the other
 * call sites papered over that with arbitrary `take(N)` truncation — which
 * destroys the text outright, so the one thing you actually want from a stack
 * trace (all of it) was unreachable. Everything here does the opposite: collapse
 * for reading, never discard, and always offer a copy.
 *
 * Nothing in this file hardcodes a colour or a text size. The per-design steps
 * restyle these blocks through [MaterialTheme] alone.
 */

/** Height ceiling for an expanded body, so nothing can grow without bound. */
private val ExpandedMaxHeight = 260.dp

/** Below this, a body is short enough to just show. */
private const val InlineLineLimit = 6
private const val InlineCharLimit = 360

/** A message body is a sequence of prose runs and fenced code blocks. */
sealed interface BodySegment {
    data class Prose(val text: String) : BodySegment
    data class Code(val lang: String, val code: String) : BodySegment
}

/**
 * Splits ``` fences out of a body. An unterminated fence is treated as code to
 * the end of the body, which is what a truncated streamed reply looks like.
 */
fun parseBody(text: String): List<BodySegment> {
    if (!text.contains("```")) return listOf(BodySegment.Prose(text))
    val out = mutableListOf<BodySegment>()
    val lines = text.lines()
    val buf = StringBuilder()
    var inCode = false
    var lang = ""

    fun flush() {
        val s = buf.toString().trim('\n')
        if (s.isNotBlank()) {
            out += if (inCode) BodySegment.Code(lang, s) else BodySegment.Prose(s)
        }
        buf.setLength(0)
    }

    for (line in lines) {
        if (line.trimStart().startsWith("```")) {
            flush()
            if (inCode) {
                inCode = false
                lang = ""
            } else {
                inCode = true
                lang = line.trimStart().removePrefix("```").trim()
            }
            continue
        }
        buf.append(line).append('\n')
    }
    flush()
    return if (out.isEmpty()) listOf(BodySegment.Prose(text)) else out
}

/** First line with something on it — what a human would read to identify this. */
fun firstMeaningfulLine(text: String): String =
    text.lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty()

private fun sizeLabel(text: String): String {
    val lines = text.count { it == '\n' } + 1
    return if (lines > 1) "$lines lines · ${text.length} chars" else "${text.length} chars"
}

private fun isLong(text: String): Boolean =
    text.length > InlineCharLimit || text.count { it == '\n' } + 1 > InlineLineLimit

/**
 * Copy affordance with visible confirmation. Without the confirmation a tap on a
 * clipboard icon is indistinguishable from a tap that did nothing, which is the
 * usual reason people copy the same thing three times.
 */
@Composable
fun CopyAction(text: String, modifier: Modifier = Modifier) {
    val clipboard = LocalClipboardManager.current
    var copied by remember(text) { mutableStateOf(false) }

    LaunchedEffect(copied) {
        if (copied) {
            delay(1500)
            copied = false
        }
    }

    Row(
        modifier
            .clip(MaterialTheme.shapes.small)
            .clickable {
                clipboard.setText(AnnotatedString(text))
                copied = true
            }
            // Copy sits at the end of a long body, often beside other controls,
            // and was a ~20dp target. The label stays exactly as it was.
            .tapTarget()
            .padding(horizontal = space.tight, vertical = space.hair),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Console says it in words; the other two use the icon plus the word,
        // because a bare clipboard glyph is guessable and "Copy" is not.
        if (LocalDesign.current != Design.Console) {
            Icon(
                if (copied) Icons.Filled.Check else Icons.Filled.ContentCopy,
                contentDescription = if (copied) "Copied" else "Copy",
                tint = if (copied) MaterialTheme.colorScheme.primary else LocalContentColor.current,
                modifier = Modifier.size(13.dp),
            )
            Spacer(Modifier.width(4.dp))
        }
        Text(
            if (LocalDesign.current == Design.Console) {
                if (copied) "[copied]" else "[copy]"
            } else {
                if (copied) "Copied" else "Copy"
            },
            style = MaterialTheme.typography.labelSmall,
            color = if (copied) MaterialTheme.colorScheme.primary else LocalContentColor.current,
        )
    }
}

/** The summary/expand chevron plus a size hint, as one tappable strip. */
@Composable
private fun SummaryRow(
    summary: String,
    sizeHint: String,
    expanded: Boolean,
    accent: Color,
    onToggle: () -> Unit,
    summaryStyle: TextStyle,
) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onToggle),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            summary,
            style = summaryStyle,
            color = accent,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(6.dp))
        Text(sizeHint, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Chevron(expanded, MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Scrollable, height-capped body. Monospace is opt-in and only used expanded. */
@Composable
private fun BoundedBody(
    text: String,
    monospace: Boolean,
    color: Color,
    maxHeight: Dp = ExpandedMaxHeight,
    markdown: Boolean = false,
) {
    val base = MaterialTheme.typography.bodySmall
    val bounds = Modifier
        .fillMaxWidth()
        .heightIn(max = maxHeight)
        .verticalScroll(rememberScrollState())

    if (markdown) {
        MarkdownText(text, modifier = bounds, color = color, style = base)
        return
    }
    Text(
        text,
        style = if (monospace) base.copy(fontFamily = FontFamily.Monospace) else base,
        color = color,
        modifier = bounds,
    )
}

/**
 * A fenced code block: monospace, horizontally scrollable so lines are not
 * reflowed into nonsense, height-capped, copyable.
 */
@Composable
fun CodeBlock(lang: String, code: String, modifier: Modifier = Modifier) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(space.snug),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                lang.ifBlank { "code" },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            CopyAction(code)
        }
        Spacer(Modifier.height(4.dp))
        Text(
            code,
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            color = MaterialTheme.colorScheme.onSurface,
            softWrap = false,
            modifier = Modifier
                .heightIn(max = ExpandedMaxHeight)
                .verticalScroll(rememberScrollState())
                .horizontalScroll(rememberScrollState()),
        )
    }
}

/**
 * The general case: a body that may be arbitrarily long. Short bodies render as
 * themselves; long ones collapse to their first meaningful line plus a size
 * hint and expand in place.
 */
@Composable
fun ExpandableBody(
    text: String,
    modifier: Modifier = Modifier,
    monospace: Boolean = false,
    color: Color = MaterialTheme.colorScheme.onSurface,
    initiallyExpanded: Boolean = false,
    summaryPrefix: String? = null,
    /**
     * Off by default. Tool output, stack traces and knowledge bodies are raw
     * text that happens to contain punctuation — running markdown over them
     * would eat an underscore out of a path or bold a glob pattern. Only a
     * message body, which was written as markdown, opts in.
     */
    markdown: Boolean = false,
) {
    if (text.isBlank()) {
        if (summaryPrefix != null) {
            Text(
                summaryPrefix,
                style = MaterialTheme.typography.bodyMedium,
                color = color,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = modifier,
            )
        }
        return
    }

    if (!isLong(text) && summaryPrefix == null) {
        if (markdown) {
            MarkdownText(
                text,
                modifier = modifier,
                color = color,
                style = MaterialTheme.typography.bodyMedium,
            )
        } else {
            Text(
                text,
                style = MaterialTheme.typography.bodyMedium,
                color = color,
                modifier = modifier,
            )
        }
        return
    }

    var expanded by remember(text) { mutableStateOf(initiallyExpanded) }
    Column(modifier.fillMaxWidth()) {
        SummaryRow(
            // A collapsed body is one line of plain text by definition, so the
            // markers have to come off it — otherwise the summary reads "## Plan"
            // and the formatting shows up only once you expand.
            summary = summaryPrefix
                ?: firstMeaningfulLine(text).let { if (markdown) stripMarkdown(it) else it },
            sizeHint = sizeLabel(text),
            expanded = expanded,
            accent = color,
            onToggle = { expanded = !expanded },
            summaryStyle = MaterialTheme.typography.bodyMedium,
        )
        if (expanded) {
            Spacer(Modifier.height(6.dp))
            BoundedBody(text, monospace = monospace, color = color, markdown = markdown)
            CopyAction(text, Modifier.align(Alignment.End))
        }
    }
}

/**
 * A whole message body: prose as markdown, fenced code as real code blocks.
 *
 * Prose here is deliberately NOT run through [ExpandableBody]. The collapse is
 * right for a tool's output — a 400-line stack trace is reference material you
 * open when you want it — and wrong for a reply, which is the thing you asked
 * for. Routing messages through it meant almost every answer over six lines
 * arrived as "first line · 335 chars" behind a chevron, so the formatting was
 * not the only thing missing from the chat: so was the message. The list this
 * sits in scrolls; a long answer is allowed to be long.
 */
@Composable
fun MessageBody(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.onSurface,
) {
    val segments = remember(text) { parseBody(text) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(space.tight)) {
        segments.forEach { seg ->
            when (seg) {
                is BodySegment.Prose -> MarkdownText(seg.text, color = color)
                is BodySegment.Code -> CodeBlock(seg.lang, seg.code)
            }
        }
        // A body with code in it is usually wanted whole, not fence by fence.
        // Long prose gets the affordance too: it used to arrive with the copy
        // that came free with the collapse, and dropping the collapse must not
        // quietly take copying with it.
        if (segments.size > 1 || isLong(text)) CopyAction(text, Modifier.align(Alignment.End))
    }
}

/**
 * Errors, calmly. One line of cause, always; the rest — usually a stack trace —
 * behind a tap, monospace, bounded and copyable. Deliberately not a red wall:
 * the tone comes from a thin accent and the label, not from flooding the screen.
 */
@Composable
fun ErrorBlock(
    text: String,
    modifier: Modifier = Modifier,
    label: String = "Error",
) {
    var expanded by remember(text) { mutableStateOf(false) }
    val tone = MaterialTheme.colorScheme.error
    val cause = firstMeaningfulLine(text).ifBlank { label }
    val hasMore = text.trim() != cause

    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(tone.copy(alpha = 0.10f))
            .padding(horizontal = space.snug, vertical = space.snug),
    ) {
        Row(
            Modifier.fillMaxWidth().let { if (hasMore) it.clickable { expanded = !expanded } else it },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                label,
                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                color = tone,
            )
            Spacer(Modifier.width(7.dp))
            Text(
                cause,
                style = MaterialTheme.typography.bodySmall,
                color = tone,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (hasMore) {
                Text(
                    sizeLabel(text),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Chevron(expanded, MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (expanded) {
            Spacer(Modifier.height(6.dp))
            BoundedBody(text, monospace = true, color = MaterialTheme.colorScheme.onSurface)
        }
        if (expanded || !hasMore) CopyAction(text, Modifier.align(Alignment.End))
    }
}
