package com.operator.simba

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
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
    data class Text(val sessionId: String, val role: String, val text: String) : StreamEvent
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

    fun connect(): Flow<StreamEvent> = callbackFlow {
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

    private fun parse(raw: String): StreamEvent? {
        val root = runCatching { json.parseToJsonElement(raw) as JsonObject }.getOrNull() ?: return null
        fun str(o: JsonObject?, k: String): String? =
            runCatching { o?.get(k)?.jsonPrimitive?.content }.getOrNull()

        return when (str(root, "type")) {
            "hello" -> StreamEvent.Connected(str(root, "at") ?: "")
            "brain_swapped" -> StreamEvent.BrainSwap(str(root, "mode") ?: "rehydrate")
            "session_event" -> {
                val sid = str(root, "sessionId") ?: return null
                val ev = runCatching { root["event"] as JsonObject }.getOrNull() ?: return null
                when (str(ev, "kind")) {
                    "text" -> {
                        // Partial deltas are display-only and would double up
                        // against the assembled message that follows.
                        if (str(ev, "partial") == "true") null
                        else StreamEvent.Text(sid, str(ev, "role") ?: "assistant", str(ev, "text").orEmpty())
                    }
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
