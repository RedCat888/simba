package com.operator.simba

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The only code in the app that reads input from outside it.
 *
 * Everything else consumes typed models the serializer already validated. This
 * takes a raw websocket frame from a process that has been restarted, upgraded
 * and swapped underneath it, and has to produce something sane or nothing —
 * never an exception, because an exception here kills the flow and the
 * conversation goes silent.
 *
 * The payload shapes below are the ones the gateway actually broadcasts:
 * `{type: 'session_event', sessionId, agentId, event: {...}}`, where the inner
 * event comes straight from the engine and carries real JSON booleans.
 */
class StreamParseTest {

    private val stream = SimbaStream("http://localhost:8787", "", "", "")

    private fun parse(raw: String) = stream.parse(raw)

    @Test
    fun `a hello becomes connected`() {
        val e = parse("""{"type":"hello","at":"2026-08-05T04:00:00Z"}""")
        assertTrue(e is StreamEvent.Connected)
    }

    @Test
    fun `assistant text carries its session and role`() {
        val e = parse(
            """{"type":"session_event","sessionId":"s1","event":{"kind":"text","role":"assistant","text":"hello"}}""",
        )
        val t = e as StreamEvent.Text
        assertEquals("s1", t.sessionId)
        assertEquals("assistant", t.role)
        assertEquals("hello", t.text)
        assertTrue(!t.partial)
    }

    @Test
    fun `partial deltas are still text events`() {
        val e = parse(
            """{"type":"session_event","sessionId":"s1","event":{"kind":"text","role":"assistant","text":"Hel","partial":true}}""",
        ) as StreamEvent.Text
        assertEquals("Hel", e.text)
        assertTrue(e.partial)
    }

    @Test
    fun `a real JSON boolean is read as a boolean`() {
        // The non-obvious bit: the parser compares jsonPrimitive.content to the
        // string "true". That relies on kotlinx rendering a boolean primitive as
        // its literal text, which is a fact about the library rather than about
        // the wire format — so it is pinned here.
        val failed = parse(
            """{"type":"session_event","sessionId":"s1","event":{"kind":"tool_result","resultText":"boom","isError":true}}""",
        ) as StreamEvent.ToolResult
        assertTrue("a real boolean true was not read as an error", failed.isError)

        val fine = parse(
            """{"type":"session_event","sessionId":"s1","event":{"kind":"tool_result","resultText":"ok","isError":false}}""",
        ) as StreamEvent.ToolResult
        assertTrue("a real boolean false was read as an error", !fine.isError)

        val absent = parse(
            """{"type":"session_event","sessionId":"s1","event":{"kind":"tool_result","resultText":"ok"}}""",
        ) as StreamEvent.ToolResult
        assertTrue("a missing flag was read as an error", !absent.isError)
    }

    @Test
    fun `tool call arguments survive as an object`() {
        val e = parse(
            """{"type":"session_event","sessionId":"s1","event":{"kind":"tool_call","name":"Bash","args":{"cmd":"ls -la"}}}""",
        ) as StreamEvent.ToolCall
        assertEquals("Bash", e.name)
        assertTrue("arguments were lost: ${e.args}", e.args.contains("ls -la"))
    }

    @Test
    fun `turn end and rate limit are recognised`() {
        assertTrue(
            parse("""{"type":"session_event","sessionId":"s1","event":{"kind":"turn_end"}}""")
                is StreamEvent.TurnEnd,
        )
        val rl = parse(
            """{"type":"session_event","sessionId":"s1","event":{"kind":"rate_limit","status":"limited","resetsAt":"05:00"}}""",
        ) as StreamEvent.RateLimit
        assertEquals("limited", rl.status)
    }

    @Test
    fun `a brain swap says which kind it was`() {
        val e = parse("""{"type":"brain_swapped","mode":"resume"}""") as StreamEvent.BrainSwap
        assertEquals("resume", e.mode)
        // Absent mode must not crash; the app words the notice from it.
        val d = parse("""{"type":"brain_swapped"}""") as StreamEvent.BrainSwap
        assertTrue(d.mode.isNotBlank())
    }

    @Test
    fun `nothing malformed ever throws`() {
        // Each of these has killed a websocket client somewhere. The contract is
        // that a frame the parser does not understand yields null and the stream
        // stays open — a thrown exception here ends the flow and the
        // conversation goes silent with no explanation.
        val junk = listOf(
            "",
            "not json at all",
            "[]",
            "null",
            "{}",
            """{"type":"unknown_future_event"}""",
            """{"type":"session_event"}""",
            """{"type":"session_event","sessionId":"s1"}""",
            """{"type":"session_event","sessionId":"s1","event":"a string not an object"}""",
            """{"type":"session_event","sessionId":"s1","event":{"kind":"invented_kind"}}""",
            """{"type":"session_event","event":{"kind":"text","text":"no session id"}}""",
            """{"type":123}""",
            """{"type":"session_event","sessionId":null,"event":{"kind":"turn_end"}}""",
        )
        for (raw in junk) {
            assertNull("should have been ignored: $raw", parse(raw))
        }
    }

    @Test
    fun `a JSON null never reaches the screen as the word null`() {
        // JsonNull is a JsonPrimitive, so `.content` on it returns the string
        // "null". Every field goes through one accessor, so a single null in a
        // frame put that word on screen as a message body, a role or a tool
        // name — and a null sessionId produced events attributed to a session
        // called "null", which no filter matches, so they silently vanished.
        val text = parse(
            """{"type":"session_event","sessionId":"s1","event":{"kind":"text","role":null,"text":null}}""",
        ) as StreamEvent.Text
        assertEquals("assistant", text.role)
        assertEquals("", text.text)

        val tool = parse(
            """{"type":"session_event","sessionId":"s1","event":{"kind":"tool_call","name":null}}""",
        ) as StreamEvent.ToolCall
        assertEquals("tool", tool.name)

        val result = parse(
            """{"type":"session_event","sessionId":"s1","event":{"kind":"tool_result","resultText":null}}""",
        ) as StreamEvent.ToolResult
        assertEquals("", result.text)
    }

    @Test
    fun `text with no body is still delivered rather than dropped`() {
        // An empty assistant message is a real thing — a turn that produced only
        // tool calls — and swallowing it would leave the thread with no marker
        // that the turn happened.
        val e = parse(
            """{"type":"session_event","sessionId":"s1","event":{"kind":"text","role":"assistant"}}""",
        ) as StreamEvent.Text
        assertEquals("", e.text)
    }
}
