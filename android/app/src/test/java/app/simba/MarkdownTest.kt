package app.simba

import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The markdown a reply is actually written in.
 *
 * Every case here is one the chat got wrong by rendering the source: the
 * markers were on screen and the emphasis was not. The two that matter most are
 * the ones that fail quietly rather than loudly — snake_case identifiers being
 * eaten by underscore emphasis, and an unterminated span from a reply that is
 * still streaming swallowing the rest of the message.
 *
 * Plain JUnit: none of this needs an Android runtime.
 */
class MarkdownTest {

    private val code = SpanStyle(fontFamily = FontFamily.Monospace)
    private val links = TextLinkStyles(SpanStyle())

    private fun render(s: String) = inlineMarkdown(s, code, links)

    // -- inline spans -------------------------------------------------------

    @Test
    fun `bold loses its markers and gains its weight`() {
        val a = render("one **strong** word")
        assertEquals("one strong word", a.text)
        assertTrue(
            "no bold span: ${a.spanStyles}",
            a.spanStyles.any { it.item.fontWeight == FontWeight.Bold },
        )
    }

    @Test
    fun `italic loses its markers and gains its slant`() {
        val a = render("one *soft* word")
        assertEquals("one soft word", a.text)
        assertTrue(a.spanStyles.any { it.item.fontStyle == FontStyle.Italic })
    }

    @Test
    fun `backticks become monospace and stop being punctuation`() {
        val a = render("call `mission_plan` once")
        assertEquals("call mission_plan once", a.text)
        assertTrue(a.spanStyles.any { it.item.fontFamily == FontFamily.Monospace })
    }

    @Test
    fun `markdown inside backticks is left alone`() {
        // A glob in a shell snippet is not emphasis.
        val a = render("run `ls **/*.kt` here")
        assertEquals("run ls **/*.kt here", a.text)
        assertTrue(a.spanStyles.none { it.item.fontWeight == FontWeight.Bold })
    }

    @Test
    fun `a snake_case identifier survives intact`() {
        // The failure this guards: _steps and acceptance_ pairing up, italicising
        // the middle and deleting both underscores, so the column name on screen
        // is not the column name in the database.
        val src = "mission_steps and acceptance_criteria and planning_session_id"
        val a = render(src)
        assertEquals(src, a.text)
        assertTrue(a.spanStyles.none { it.item.fontStyle == FontStyle.Italic })
    }

    @Test
    fun `underscore emphasis still works at a word boundary`() {
        val a = render("a _soft_ word")
        assertEquals("a soft word", a.text)
        assertTrue(a.spanStyles.any { it.item.fontStyle == FontStyle.Italic })
    }

    @Test
    fun `an unterminated span stays literal instead of eating the message`() {
        // What a half-streamed reply looks like. Losing the tail would be worse
        // than showing two asterisks.
        assertEquals("a **broken reply", render("a **broken reply").text)
        assertEquals("half `open", render("half `open").text)
    }

    @Test
    fun `an escaped marker is a character`() {
        assertEquals("2 * 3 * 4", render("""2 \* 3 \* 4""").text)
    }

    @Test
    fun `a link keeps its label and drops its url`() {
        assertEquals("see the docs", render("see [the docs](https://x.test)").text)
    }

    @Test
    fun `nesting resolves both spans`() {
        val a = render("**bold with `code` inside**")
        assertEquals("bold with code inside", a.text)
        assertTrue(a.spanStyles.any { it.item.fontWeight == FontWeight.Bold })
        assertTrue(a.spanStyles.any { it.item.fontFamily == FontFamily.Monospace })
    }

    @Test
    fun `plain prose passes through untouched`() {
        val src = "Nothing here is markdown. 3 < 4, cost is $2.50 (roughly)."
        assertEquals(src, render(src).text)
    }

    // -- block structure ----------------------------------------------------

    @Test
    fun `headings bullets quotes and rules are recognised`() {
        val blocks = parseMarkdown(
            """
            # Findings

            - first
            - second
            1. numbered

            > a quote

            ---
            """.trimIndent(),
        )
        assertEquals(1, blocks.filterIsInstance<MdBlock.Heading>().size)
        assertEquals(3, blocks.filterIsInstance<MdBlock.Bullet>().size)
        assertEquals(1, blocks.filterIsInstance<MdBlock.Quote>().size)
        assertTrue(blocks.any { it is MdBlock.Rule })
    }

    @Test
    fun `an ordered marker is kept as written`() {
        val b = parseMarkdown("3. third").filterIsInstance<MdBlock.Bullet>().single()
        assertEquals("3.", b.marker)
        assertEquals("third", b.text)
    }

    @Test
    fun `hard-wrapped lines reflow into one paragraph`() {
        // The model's line breaks were chosen for its own width, not the phone's.
        val blocks = parseMarkdown("one line\nand its continuation\n\na second paragraph")
        val paras = blocks.filterIsInstance<MdBlock.Para>()
        assertEquals(2, paras.size)
        assertEquals("one line and its continuation", paras[0].text)
    }

    @Test
    fun `a heading needs its space so a hashtag is not a heading`() {
        assertTrue(parseMarkdown("#nothashtag").single() is MdBlock.Para)
    }

    // -- summaries ----------------------------------------------------------

    @Test
    fun `a collapsed summary shows words rather than markers`() {
        assertEquals("Findings", stripMarkdown("## Findings"))
        assertEquals("the important bit", stripMarkdown("**the important bit**"))
        assertEquals("run mission_plan", stripMarkdown("- run `mission_plan`"))
        assertEquals("mission_steps", stripMarkdown("mission_steps"))
    }
}
