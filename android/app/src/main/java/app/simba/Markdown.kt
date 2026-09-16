package app.simba

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp

/**
 * Markdown, to the depth a chat reply actually uses it.
 *
 * The model writes `**bold**`, backticked identifiers, headings and bullet
 * lists because that is how it writes everywhere else. Rendering that as a raw
 * string put the punctuation on screen and left the emphasis off it, so the one
 * word in a paragraph that was meant to stand out read as `**word**` — worse
 * than no formatting at all, because the noise is still there.
 *
 * Fenced ``` blocks are deliberately NOT handled here. [parseBody] in Blocks.kt
 * splits those out first and gives them a real [CodeBlock] with its own copy
 * affordance and horizontal scroll; by the time text reaches this file every
 * fence is already gone. This handles what is left: block structure within a
 * prose run, and inline spans within a line.
 *
 * Hand-rolled rather than a library for the same reason [parseBody] is: the
 * subset is small, a dependency that pulls in its own theming would have to be
 * fought back into [MaterialTheme], and unknown input must never throw — an
 * unmatched `*` has to fall back to being an asterisk, not lose the message.
 *
 * Nothing here hardcodes a colour or a text size.
 */

/** A prose run is a sequence of these. Inline spans are resolved separately. */
sealed interface MdBlock {
    data class Heading(val level: Int, val text: String) : MdBlock

    /** [marker] is rendered as written, so "1." stays 1. and does not become a dot. */
    data class Bullet(val depth: Int, val marker: String, val text: String) : MdBlock
    data class Quote(val text: String) : MdBlock
    data class Para(val text: String) : MdBlock
    data object Rule : MdBlock
}

private val HeadingRe = Regex("""^(#{1,6})\s+(.*)$""")
private val BulletRe = Regex("""^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$""")
private val RuleRe = Regex("""^\s*([-*_])(\s*\1){2,}\s*$""")
private val QuoteRe = Regex("""^\s*>\s?(.*)$""")

/**
 * Splits a prose run into blocks. Consecutive plain lines join into one
 * paragraph — a hard-wrapped reply should reflow to the phone's width rather
 * than keep the model's line breaks, which were never chosen for this screen.
 */
fun parseMarkdown(text: String): List<MdBlock> {
    val out = mutableListOf<MdBlock>()
    val para = StringBuilder()

    fun flush() {
        val s = para.toString().trim()
        if (s.isNotEmpty()) out += MdBlock.Para(s)
        para.setLength(0)
    }

    for (line in text.lines()) {
        when {
            line.isBlank() -> flush()

            RuleRe.matches(line) -> {
                flush()
                out += MdBlock.Rule
            }

            else -> {
                val heading = HeadingRe.find(line)
                val bullet = BulletRe.find(line)
                val quote = QuoteRe.find(line)
                when {
                    heading != null -> {
                        flush()
                        out += MdBlock.Heading(
                            heading.groupValues[1].length,
                            heading.groupValues[2].trim(),
                        )
                    }

                    bullet != null -> {
                        flush()
                        out += MdBlock.Bullet(
                            depth = bullet.groupValues[1].length / 2,
                            marker = bullet.groupValues[2],
                            text = bullet.groupValues[3].trim(),
                        )
                    }

                    quote != null -> {
                        flush()
                        out += MdBlock.Quote(quote.groupValues[1].trim())
                    }

                    else -> {
                        if (para.isNotEmpty()) para.append(' ')
                        para.append(line.trim())
                    }
                }
            }
        }
    }
    flush()
    return out
}

// ---------------------------------------------------------------------------
// Inline spans
// ---------------------------------------------------------------------------

/** Characters a backslash may escape, so `\*` is an asterisk and not emphasis. */
private const val Escapable = "\\`*_~[]()#>-+.!"

/**
 * Finds [token] at or after [from], skipping escaped characters. Returns -1 when
 * the span never closes — which is the common case for a reply still streaming
 * in, and must render as literal text rather than swallow the rest of the line.
 */
private fun closingIndex(s: String, from: Int, token: String): Int {
    var j = from
    while (j <= s.length - token.length) {
        if (s[j] == '\\') {
            j += 2
            continue
        }
        if (s.startsWith(token, j)) return j
        j++
    }
    return -1
}

private fun isWordChar(c: Char) = c.isLetterOrDigit()

/**
 * Underscore emphasis only at a word boundary.
 *
 * Half the identifiers in this system are snake_case — `mission_steps`,
 * `acceptance_criteria`, `planning_session_id`. Treating `_` as emphasis
 * wherever it appears silently italicised the middle of every one of them and
 * ate the underscores, turning a column name on screen into a different string
 * than the one in the database. Asterisks have no such collision and are left
 * unrestricted.
 */
private fun underscoreOpensHere(s: String, i: Int, token: String): Boolean {
    val before = if (i == 0) ' ' else s[i - 1]
    val afterIdx = i + token.length
    val after = if (afterIdx < s.length) s[afterIdx] else ' '
    return !isWordChar(before) && !after.isWhitespace()
}

private fun AnnotatedString.Builder.appendInline(
    s: String,
    code: SpanStyle,
    link: TextLinkStyles,
) {
    val emphasis = listOf(
        "**" to SpanStyle(fontWeight = FontWeight.Bold),
        "__" to SpanStyle(fontWeight = FontWeight.Bold),
        "~~" to SpanStyle(textDecoration = TextDecoration.LineThrough),
        "*" to SpanStyle(fontStyle = FontStyle.Italic),
        "_" to SpanStyle(fontStyle = FontStyle.Italic),
    )

    val plain = StringBuilder()
    fun flush() {
        if (plain.isNotEmpty()) {
            append(plain.toString())
            plain.setLength(0)
        }
    }

    var i = 0
    outer@ while (i < s.length) {
        val c = s[i]

        if (c == '\\' && i + 1 < s.length && s[i + 1] in Escapable) {
            plain.append(s[i + 1])
            i += 2
            continue
        }

        // Code first and without recursion: inside backticks, markdown is off.
        // `**` in a shell snippet is a glob, not bold.
        if (c == '`') {
            var ticks = 0
            while (i + ticks < s.length && s[i + ticks] == '`') ticks++
            val fence = "`".repeat(ticks)
            val close = s.indexOf(fence, i + ticks)
            if (close > 0) {
                flush()
                withStyle(code) { append(s.substring(i + ticks, close).trim()) }
                i = close + ticks
                continue
            }
        }

        if (c == '[') {
            val end = closingIndex(s, i + 1, "]")
            if (end > 0 && end + 1 < s.length && s[end + 1] == '(') {
                val close = closingIndex(s, end + 2, ")")
                if (close > 0) {
                    val label = s.substring(i + 1, end)
                    val url = s.substring(end + 2, close).trim()
                    flush()
                    withLink(LinkAnnotation.Url(url, link)) {
                        appendInline(label, code, link)
                    }
                    i = close + 1
                    continue
                }
            }
        }

        for ((token, style) in emphasis) {
            if (!s.startsWith(token, i)) continue
            if (token[0] == '_' && !underscoreOpensHere(s, i, token)) continue
            val close = closingIndex(s, i + token.length, token)
            if (close <= i + token.length) continue
            flush()
            withStyle(style) {
                appendInline(s.substring(i + token.length, close), code, link)
            }
            i = close + token.length
            continue@outer
        }

        plain.append(c)
        i++
    }
    flush()
}

/** One line of markdown as styled text. Never throws on malformed input. */
fun inlineMarkdown(text: String, code: SpanStyle, link: TextLinkStyles): AnnotatedString =
    buildAnnotatedString { appendInline(text, code, link) }

/**
 * Markdown flattened to the words. For places that can only show plain text —
 * a collapsed summary line, a notification — where leaving the markers in means
 * showing punctuation instead of the emphasis it stood for.
 *
 * Single `_` is left alone on purpose, for the snake_case reason above.
 */
fun stripMarkdown(line: String): String =
    line
        .replace(Regex("""^\s*#{1,6}\s+"""), "")
        .replace(Regex("""^\s*>\s?"""), "")
        .replace(Regex("""^\s*([-*+]|\d{1,9}[.)])\s+"""), "")
        .replace(Regex("""\[([^\]]*)\]\([^)]*\)"""), "$1")
        .replace(Regex("""\*\*([^*]+)\*\*"""), "$1")
        .replace(Regex("""__([^_]+)__"""), "$1")
        .replace(Regex("""~~([^~]+)~~"""), "$1")
        .replace(Regex("""\*([^*]+)\*"""), "$1")
        .replace(Regex("""`+([^`]*)`+"""), "$1")
        .trim()

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * A prose run, rendered. [style] is the paragraph style; headings scale off the
 * theme's own type ramp rather than multiplying a number, so the per-design
 * scales in Tokens.kt keep control of it.
 */
@Composable
fun MarkdownText(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.onSurface,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
) {
    val codeSpan = SpanStyle(
        fontFamily = FontFamily.Monospace,
        background = MaterialTheme.colorScheme.surfaceVariant,
        color = MaterialTheme.colorScheme.onSurface,
    )
    val linkStyles = TextLinkStyles(
        SpanStyle(
            color = MaterialTheme.colorScheme.primary,
            textDecoration = TextDecoration.Underline,
        ),
    )
    val blocks = remember(text) { parseMarkdown(text) }
    val quoteRule = MaterialTheme.colorScheme.outlineVariant

    fun spans(s: String) = inlineMarkdown(s, codeSpan, linkStyles)

    Column(modifier, verticalArrangement = Arrangement.spacedBy(space.tight)) {
        blocks.forEach { block ->
            when (block) {
                is MdBlock.Para -> Text(spans(block.text), style = style, color = color)

                is MdBlock.Heading -> Text(
                    spans(block.text),
                    style = when (block.level) {
                        1 -> MaterialTheme.typography.titleMedium
                        2 -> MaterialTheme.typography.titleSmall
                        else -> style.copy(fontWeight = FontWeight.SemiBold)
                    },
                    color = color,
                    modifier = Modifier.padding(top = space.tight),
                )

                is MdBlock.Bullet -> Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(start = (block.depth.coerceAtMost(4) * 14).dp),
                ) {
                    Text(
                        if (block.marker.length == 1) "•" else block.marker,
                        style = style,
                        color = color,
                    )
                    Spacer(Modifier.width(space.snug))
                    Text(spans(block.text), style = style, color = color)
                }

                is MdBlock.Quote -> Row(Modifier.fillMaxWidth()) {
                    Spacer(
                        Modifier
                            .width(2.dp)
                            .height(20.dp)
                            .background(quoteRule),
                    )
                    Spacer(Modifier.width(space.snug))
                    Text(
                        spans(block.text),
                        style = style,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                MdBlock.Rule -> Spacer(
                    Modifier
                        .fillMaxWidth()
                        .height(1.dp)
                        .background(quoteRule),
                )
            }
        }
    }
}
