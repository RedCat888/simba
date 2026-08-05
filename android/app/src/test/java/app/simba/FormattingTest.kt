package com.operator.simba

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * The small functions that turn data into words.
 *
 * Every one of these has been changed at least once after seeing it rendered,
 * and shortPath twice — both times because a truncation ate the end of a string,
 * which is the part that identifies it. They are pure, they are the last thing
 * between a database value and someone's eyes, and none of them was tested.
 *
 * Plain JUnit. Nothing here needs an Android runtime, and requiring one to check
 * string formatting is how a test suite stops being run.
 */
class FormattingTest {

    // -- shortPath ----------------------------------------------------------

    @Test
    fun `a path keeps its filename above all else`() {
        val p = "android/app/src/main/java/com/operator/simba/Session.kt"
        val short = shortPath(p, 42)
        assertTrue("lost the filename: $short", short.endsWith("Session.kt"))
        assertTrue("over budget: ${short.length}", short.length <= 42)
        assertTrue("no cut marker: $short", short.startsWith("…"))
    }

    @Test
    fun `a path that fits is left alone`() {
        val p = "migrations/040_schedule_note.sql"
        assertEquals(p, shortPath(p, 42))
    }

    @Test
    fun `cuts on separators, never mid-segment`() {
        // The original bug: takeLast produced "ndroid/app/src/..." — not a path,
        // and with the filename gone.
        val short = shortPath("android/app/src/main/java/com/operator/simba/Now.kt", 30)
        val body = short.removePrefix("…/")
        assertTrue(
            "cut inside a segment: $short",
            body.split('/').none { it.isEmpty() } && !short.startsWith("…n"),
        )
    }

    @Test
    fun `a filename longer than the whole budget still ends correctly`() {
        val short = shortPath("x/" + "a".repeat(60) + ".sql", 20)
        assertTrue("dropped the extension: $short", short.endsWith(".sql"))
        assertTrue(short.length <= 20)
    }

    @Test
    fun `windows separators are understood`() {
        val short = shortPath("""C:\Users\operator\simba\src\gateway\server.ts""", 24)
        assertTrue("lost the filename: $short", short.endsWith("server.ts"))
    }

    @Test
    fun `degenerate paths do not throw`() {
        assertEquals("", shortPath("", 20))
        assertEquals("/", shortPath("/", 20))
        assertEquals("a", shortPath("a", 20))
    }

    // -- time ---------------------------------------------------------------

    @Test
    fun `relative time is relative for two days and absolute after`() {
        fun agoOf(amount: Long, unit: ChronoUnit) =
            ago(Instant.now().minus(amount, unit).toString())

        assertEquals("just now", agoOf(10, ChronoUnit.SECONDS))
        assertEquals("5m ago", agoOf(5, ChronoUnit.MINUTES))
        assertEquals("3h ago", agoOf(3, ChronoUnit.HOURS))
        // Past 48 hours it becomes a date, because "3 days ago" makes you do
        // arithmetic to work out which day.
        assertTrue(agoOf(5, ChronoUnit.DAYS).matches(Regex("""\d{4}-\d{2}-\d{2}""")))
    }

    @Test
    fun `an unparseable timestamp degrades instead of throwing`() {
        // The consequence of a bad parse must be a missing hint, never a screen
        // that fails to draw because one row had an odd date.
        assertEquals(0L, minutesSince("not a date"))
        assertEquals(0L, minutesSince(""))
        assertEquals("garbage", ago("garbage"))
    }

    @Test
    fun `a future timestamp does not produce a negative age`() {
        // Clock skew between the phone and the PC is real and small; it must not
        // render as "quiet -3m".
        val future = Instant.now().plus(2, ChronoUnit.MINUTES).toString()
        assertEquals(0L, minutesSince(future))
    }

    @Test
    fun `quiet is said in hours once minutes stop being readable`() {
        assertEquals("quiet 31m", quietLabel(31))
        assertEquals("quiet 89m", quietLabel(89))
        // 506 minutes was rendering beside a line reading "8h ago".
        assertEquals("quiet 8h", quietLabel(506))
    }

    @Test
    fun `duration never shows three digits of seconds`() {
        assertEquals("<1s", duration(0.4))
        assertEquals("45s", duration(45.0))
        assertEquals("6m 39s", duration(399.0))
        assertEquals("2h 5m", duration(7500.0))
    }

    @Test
    fun `day labels name today and yesterday`() {
        assertEquals("Today", dayLabel(Instant.now().toString()))
        assertEquals("Yesterday", dayLabel(Instant.now().minus(1, ChronoUnit.DAYS).toString()))
        assertEquals("Earlier", dayLabel(null))
        assertEquals("Earlier", dayLabel("nonsense"))
    }

    // -- statuses -----------------------------------------------------------

    @Test
    fun `a status is never shown with a schema underscore`() {
        assertEquals("logged out", statusLabel("logged_out"))
        assertEquals("waiting limit", statusLabel("waiting_limit"))
        assertEquals("running", statusLabel("running"))
    }

    @Test
    fun `token counts stay short enough for a metadata column`() {
        assertTrue(tokens(818_418).length <= 7)
        assertTrue(tokens(1_240_000).length <= 7)
        assertEquals("0", tokens(0))
    }
}
