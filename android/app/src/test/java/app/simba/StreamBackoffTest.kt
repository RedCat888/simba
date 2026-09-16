package app.simba

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The reconnect backoff, checked rather than reasoned about.
 *
 * A plain JUnit test — no Robolectric, because this is arithmetic and pulling in
 * an Android runtime to check arithmetic is how a fast test suite stops being
 * one.
 *
 * The shift is the part worth testing. `1000L shl attempt` is fine for the four
 * values anyone thinks about and becomes nonsense past 53, where the shift wraps
 * and the delay goes negative — and a negative delay throws rather than waiting,
 * so a long outage would crash the stream instead of retrying it. That is
 * exactly the failure nobody would find by trying it, because it needs an hour
 * of downtime to reach.
 */
class StreamBackoffTest {

    @Test
    fun `climbs then holds at the ceiling`() {
        assertEquals(1_000L, backoffMs(0))
        assertEquals(2_000L, backoffMs(1))
        assertEquals(4_000L, backoffMs(2))
        assertEquals(8_000L, backoffMs(3))
        assertEquals(15_000L, backoffMs(4))
        assertEquals(15_000L, backoffMs(5))
    }

    @Test
    fun `never negative, never zero, however long the outage`() {
        // 0..200 covers a full night of failures at the 15s ceiling, and takes
        // the shift well past the point where it would have wrapped.
        for (attempt in 0..200) {
            val wait = backoffMs(attempt)
            assertTrue("attempt $attempt gave $wait", wait in 1_000L..15_000L)
        }
    }

    @Test
    fun `a nonsense attempt count still yields a sane wait`() {
        // Defensive rather than hypothetical: the counter is incremented in a
        // loop that runs for as long as the app is open.
        assertEquals(1_000L, backoffMs(-1))
        assertEquals(1_000L, backoffMs(Int.MIN_VALUE))
        assertEquals(15_000L, backoffMs(Int.MAX_VALUE))
    }
}
