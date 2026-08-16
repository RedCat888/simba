package com.operator.simba

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * Live agent output over the gateway websocket.
 *
 * Polling was never going to work for this: an agent turn emits tool calls and
 * text over tens of seconds, and a chat that only updates every few seconds
 * reads as frozen. The socket carries the same normalized events the desktop
 * control center uses.
 *
 * Access credentials go on the upgrade request the same way they go on HTTP —
 * Cloudflare validates them at the edge before the socket is established, so an
 * unauthenticated client never reaches the gateway at all.
 */

sealed interface StreamEvent {
    data class Text(val sessionId: String, val role: String, val text: String, val partial: Boolean = false) : StreamEvent
    data class ToolCall(val sessionId: String, val name: String, val args: String) : StreamEvent
    data class ToolResult(val sessionId: String, val text: String, val isError: Boolean) : StreamEvent
    data class TurnEnd(val sessionId: String) : StreamEvent
    data class RateLimit(val sessionId: String, val status: String, val resets: String?) : StreamEvent
    data class BrainSwap(val mode: String) : StreamEvent
    data class Connected(val at: String) : StreamEvent
    data class Disconnected(val reason: String) : StreamEvent
}

class SimbaStream(
    private val baseUrl: String,
    private val clientId: String,
    private val clientSecret: String,
    private val token: String,
) {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private val client = OkHttpClient.Builder()
        // Keeps the socket alive through mobile NAT timeouts, which otherwise
        // silently drop an idle connection and make the chat look dead.
        .pingInterval(25, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    /**
     * Connect, and keep connecting.
     *
     * [connectOnce] gives up the moment the socket closes. That was survivable
     * when the chat was something you opened for a minute, and is not survivable
     * for what this app actually is: a phone talking to a home PC behind a
     * tunnel, watching an agent that runs for hours. The PC sleeps, the tunnel
     * blips, the phone changes network — and the thread would go quiet and stay
     * quiet with a "closed" notice, looking exactly like an agent that had
     * stopped producing output.
     *
     * Backs off 1s, 2s, 4s, 8s, capped at 15, and resets the moment a connection
     * opens. Capped low on purpose: the failure being retried is usually a few
     * seconds of network, and a minute-long backoff to recover from a two-second
     * blip is worse than the blip.
     *
     * An authentication failure is not retried. A revoked service token does not
     * become valid by asking again, and hammering an Access endpoint that is
     * refusing you is how a credential problem turns into a rate-limit problem.
     */
    fun connect(): Flow<StreamEvent> = flow {
        var attempt = 0
        while (true) {
            var fatal = false
            connectOnce().collect { ev ->
                if (ev is StreamEvent.Connected) attempt = 0
                if (ev is StreamEvent.Disconnected && ev.reason?.looksUnauthorised() == true) {
                    fatal = true
                }
                emit(ev)
            }
            if (fatal) return@flow

            delay(backoffMs(attempt))
            attempt++
        }
    }

    private fun connectOnce(): Flow<StreamEvent> = callbackFlow {
        val wsUrl = baseUrl.trimEnd('/')
            .replace("https://", "wss://")
            .replace("http://", "ws://") + "/ws"

        val req = Request.Builder().url(wsUrl).apply {
            if (clientId.isNotBlank() && clientSecret.isNotBlank()) {
                header("CF-Access-Client-Id", clientId)
                header("CF-Access-Client-Secret", clientSecret)
            }
            if (token.isNotBlank()) header("Authorization", "Bearer $token")
        }.build()

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                trySend(StreamEvent.Connected(response.message))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                parse(text)?.let { trySend(it) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // A 401/403 here means Access rejected the upgrade. Surfaced
                // rather than retried blindly, so a credential problem does not
                // present as a flaky connection.
                trySend(
                    StreamEvent.Disconnected(
                        response?.code?.let { "HTTP $it" } ?: (t.message ?: "connection lost"),
                    ),
                )
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                trySend(StreamEvent.Disconnected(reason.ifBlank { "closed" }))
            }
        }

        val socket = client.newWebSocket(req, listener)
        awaitClose { socket.close(1000, "done") }
    }

    /**
     * Does this disconnect reason mean the credentials were refused?
     *
     * Matched on the code the listener already formats rather than on prose, so
     * a reworded message cannot silently turn a fatal error back into an
     * infinite retry loop.
     */
    private fun String.looksUnauthorised(): Boolean =
        this == "HTTP 401" || this == "HTTP 403"

    /**
     * Internal rather than private so it can be tested.
     *
     * This is the only code in the app that reads input from outside it, and it
     * is doing something non-obvious: comparing `jsonPrimitive.content` against
     * the string "true" to read a JSON boolean. That works because kotlinx
     * renders a boolean primitive as its literal text — which is a fact about
     * the library, not about the wire format, and exactly the kind of thing that
     * should be pinned by a test rather than rediscovered.
     */
    internal fun parse(raw: String): StreamEvent? {
        val root = runCatching { json.parseToJsonElement(raw) as JsonObject }.getOrNull() ?: return null

        // contentOrNull, not content.
        //
        // JsonNull *is* a JsonPrimitive, so `.content` on a JSON null returns
        // the four-letter string "null" rather than absent. Every field here
        // goes through this function, so one null anywhere in a frame put the
        // word "null" on screen as a message body, a role or a tool name — and
        // a null sessionId produced events attributed to a session called
        // "null", which no filter would ever match, so they vanished.
        fun str(o: JsonObject?, k: String): String? =
            runCatching { o?.get(k)?.jsonPrimitive?.contentOrNull }.getOrNull()

        return when (str(root, "type")) {
            "hello" -> StreamEvent.Connected(str(root, "at") ?: "")
            "brain_swapped" -> StreamEvent.BrainSwap(str(root, "mode") ?: "rehydrate")
            "session_event" -> {
                val sid = str(root, "sessionId") ?: return null
                val ev = runCatching { root["event"] as JsonObject }.getOrNull() ?: return null
                when (str(ev, "kind")) {
                    "text" -> StreamEvent.Text(
                        sid,
                        str(ev, "role") ?: "assistant",
                        str(ev, "text").orEmpty(),
                        str(ev, "partial") == "true",
                    )
                    "tool_call" -> StreamEvent.ToolCall(
                        sid,
                        str(ev, "name") ?: "tool",
                        runCatching { ev["args"].toString() }.getOrDefault("{}"),
                    )
                    "tool_result" -> StreamEvent.ToolResult(
                        sid,
                        str(ev, "resultText").orEmpty(),
                        str(ev, "isError") == "true",
                    )
                    "turn_end" -> StreamEvent.TurnEnd(sid)
                    "rate_limit" -> StreamEvent.RateLimit(
                        sid,
                        str(ev, "status") ?: "unknown",
                        str(ev, "resetsAt"),
                    )
                    else -> null
                }
            }
            else -> null
        }
    }
}

/**
 * How long to wait before the next reconnect attempt.
 *
 * Top level and pure so it can be checked rather than reasoned about. The shift
 * is the part worth testing: `1000L shl attempt` overflows into nonsense
 * somewhere past attempt 53, and without the cap a long outage would eventually
 * schedule a negative delay — which throws rather than waiting.
 */
fun backoffMs(attempt: Int): Long =
    minOf(1000L shl attempt.coerceIn(0, 4), 15_000L)
