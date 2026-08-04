package com.operator.simba

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/**
 * The chat surface.
 *
 * This is what turns the app from a dashboard into a control centre. Starting
 * an agent and then being unable to say anything to it is most of a system and
 * none of the usefulness — you could see that work was happening but not steer
 * it, which is exactly backwards for a phone client.
 *
 * Renders the same interleaved history the desktop shows (messages plus tool
 * calls in order), then keeps appending live events off the websocket.
 */

/** One row in the thread. Tool activity is first-class, not hidden. */
sealed interface ChatItem {
    val at: Long

    data class Msg(val role: String, val text: String, override val at: Long) : ChatItem
    data class Tool(val name: String, val detail: String, val isError: Boolean, override val at: Long) : ChatItem
    data class Notice(val text: String, val tone: Color, override val at: Long) : ChatItem
}

class ChatState {
    val items = mutableStateListOf<ChatItem>()
    var sending by mutableStateOf(false)
    var connected by mutableStateOf(false)
    var thinking by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
}

@Composable
fun ChatScreen(
    vm: SimbaVm,
    sessionId: String,
    title: String,
    onBack: () -> Unit,
) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    val state = remember(sessionId) { ChatState() }
    val listState = rememberLazyListState()
    var draft by remember { mutableStateOf("") }

    // History first, then live. Loading them the other way round would let an
    // event arriving mid-fetch be overwritten by the older snapshot.
    LaunchedEffect(sessionId) {
        runCatching {
            val msgs = vm.api?.messages(sessionId).orEmpty()
            val tools = vm.api?.tools(sessionId).orEmpty()
            state.items.clear()
            state.items.addAll(
                (msgs.filter { !it.content.isNullOrBlank() }
                    .map { ChatItem.Msg(it.role, it.content!!, it.at) } +
                    tools.map {
                        ChatItem.Tool(
                            it.name,
                            it.resultText?.take(300) ?: "",
                            it.isError,
                            it.seqHint,
                        )
                    })
                    .sortedBy { it.at },
            )
        }.onFailure { state.error = it.message }
    }

    LaunchedEffect(sessionId) {
        val stream = SimbaStream(
            ctx.gatewayUrl(), ctx.accessClientId(), ctx.accessClientSecret(), ctx.gatewayToken(),
        )
        stream.connect().collect { ev ->
            val now = System.currentTimeMillis()
            when (ev) {
                is StreamEvent.Connected -> { state.connected = true; state.error = null }
                is StreamEvent.Disconnected -> { state.connected = false; state.error = ev.reason }
                is StreamEvent.Text -> if (ev.sessionId == sessionId && ev.text.isNotBlank()) {
                    state.thinking = false
                    state.items.add(ChatItem.Msg(ev.role, ev.text, now))
                }
                is StreamEvent.ToolCall -> if (ev.sessionId == sessionId) {
                    state.thinking = true
                    state.items.add(ChatItem.Tool(ev.name, ev.args.take(200), false, now))
                }
                is StreamEvent.ToolResult -> if (ev.sessionId == sessionId) {
                    state.items.add(ChatItem.Tool("↳", ev.text.take(300), ev.isError, now))
                }
                is StreamEvent.TurnEnd -> if (ev.sessionId == sessionId) state.thinking = false
                is StreamEvent.RateLimit -> if (ev.sessionId == sessionId && ev.status != "allowed") {
                    state.items.add(
                        ChatItem.Notice("Usage limit reached — switching brains", Warn, now),
                    )
                }
                is StreamEvent.BrainSwap -> state.items.add(
                    ChatItem.Notice(
                        if (ev.mode == "resume") "Switched accounts — conversation carried over"
                        else "Switched models — continuing from checkpoint",
                        Accent,
                        now,
                    ),
                )
            }
        }
    }

    // Follow the tail as things arrive.
    LaunchedEffect(state.items.size) {
        if (state.items.isNotEmpty()) listState.animateScrollToItem(state.items.size - 1)
    }

    fun send() {
        val text = draft.trim()
        if (text.isEmpty() || state.sending) return
        draft = ""
        state.items.add(ChatItem.Msg("user", text, System.currentTimeMillis()))
        state.sending = true
        state.thinking = true
        scope.launch {
            runCatching { vm.api?.send(sessionId, text) }
                .onFailure {
                    state.items.add(
                        ChatItem.Notice("Could not send: ${it.message?.take(90)}", Err, System.currentTimeMillis()),
                    )
                    state.thinking = false
                }
            state.sending = false
        }
    }

    Column(Modifier.fillMaxSize()) {
        // Header
        Row(
            Modifier.fillMaxWidth().background(Panel).padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack, modifier = Modifier.size(34.dp)) {
                Icon(Icons.Filled.ArrowBack, "Back", tint = Dim, modifier = Modifier.size(19.dp))
            }
            Column(Modifier.weight(1f).padding(start = 4.dp)) {
                Text(title, color = Fg, fontWeight = FontWeight.SemiBold, fontSize = 14.5.sp, maxLines = 1)
                Text(
                    when {
                        state.error != null -> state.error!!.take(40)
                        state.thinking -> "working…"
                        state.connected -> "live"
                        else -> "connecting…"
                    },
                    fontSize = 10.5.sp,
                    color = if (state.error != null) Err else if (state.connected) Ok else Faint,
                )
            }
            Box(
                Modifier.size(7.dp).clip(RoundedCornerShape(99.dp))
                    .background(if (state.connected) Ok else Faint),
            )
        }

        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(11.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            items(state.items) { item -> ChatRow(item) }
            if (state.thinking) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 2.dp, color = Accent)
                        Text("  thinking", color = Faint, fontSize = 12.sp)
                    }
                }
            }
        }

        // Composer
        Row(
            Modifier.fillMaxWidth().background(Panel).padding(9.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                placeholder = { Text("Message…", fontSize = 13.sp, color = Faint) },
                modifier = Modifier.weight(1f),
                maxLines = 5,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Accent, unfocusedBorderColor = Line,
                    focusedTextColor = Fg, unfocusedTextColor = Fg,
                ),
            )
            Spacer(Modifier.width(7.dp))
            FilledIconButton(
                onClick = { send() },
                enabled = draft.isNotBlank() && !state.sending,
                colors = IconButtonDefaults.filledIconButtonColors(
                    containerColor = Accent, contentColor = Color(0xFF1A1206),
                ),
                modifier = Modifier.size(46.dp),
            ) { Icon(Icons.Filled.Send, "Send", modifier = Modifier.size(19.dp)) }
        }
    }
}

@Composable
private fun ChatRow(item: ChatItem) {
    when (item) {
        is ChatItem.Msg -> {
            val isUser = item.role == "user"
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
            ) {
                Column(
                    Modifier
                        .widthIn(max = 320.dp)
                        .clip(
                            RoundedCornerShape(
                                topStart = 14.dp, topEnd = 14.dp,
                                bottomStart = if (isUser) 14.dp else 4.dp,
                                bottomEnd = if (isUser) 4.dp else 14.dp,
                            ),
                        )
                        .background(if (isUser) Color(0xFF1B2A3F) else Panel)
                        .padding(11.dp),
                ) {
                    Text(
                        item.role.uppercase(),
                        fontSize = 9.sp,
                        color = Faint,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Spacer(Modifier.height(3.dp))
                    Text(item.text, color = Fg, fontSize = 13.5.sp, lineHeight = 19.sp)
                }
            }
        }

        is ChatItem.Tool -> {
            var expanded by remember { mutableStateOf(false) }
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color(0xFF0E1116))
                    .clickable { expanded = !expanded }
                    .padding(horizontal = 9.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    if (item.isError) "✕" else "▸",
                    color = if (item.isError) Err else Info,
                    fontSize = 11.sp,
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    item.name,
                    color = if (item.isError) Err else Info,
                    fontSize = 11.5.sp,
                    fontFamily = FontFamily.Monospace,
                )
                Spacer(Modifier.width(7.dp))
                Text(
                    item.detail.replace('\n', ' '),
                    color = Dim,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    maxLines = if (expanded) 20 else 1,
                    modifier = Modifier.weight(1f),
                )
            }
        }

        is ChatItem.Notice -> {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Box(
                    Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(item.tone.copy(alpha = 0.13f))
                        .padding(horizontal = 11.dp, vertical = 6.dp),
                ) { Text(item.text, color = item.tone, fontSize = 11.5.sp) }
            }
        }
    }
}
