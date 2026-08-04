package com.operator.simba

import androidx.compose.foundation.background
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
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
    data class Notice(val text: String, val tone: NoticeTone, override val at: Long) : ChatItem

    /** Something went wrong locally. Kept whole — the cause line is derived, not cut. */
    data class Failure(val text: String, override val at: Long) : ChatItem
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
    /** The conversation moved to a new session id — follow it. */
    onMoved: (String) -> Unit = {},
) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    val state = remember(sessionId) { ChatState() }
    val listState = rememberLazyListState()
    var draft by remember { mutableStateOf("") }
    var showDiff by remember { mutableStateOf(false) }

    if (showDiff) {
        DiffScreen(vm, sessionId) { showDiff = false }
        return
    }

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
                            it.resultText.orEmpty(),
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
                is StreamEvent.Disconnected -> {
                    state.connected = false
                    state.error = ev.reason
                    // The header can only show one clipped line, so the whole
                    // reason lands in the thread too — deduped, because a flaky
                    // link would otherwise repeat itself forever.
                    val reason = ev.reason.orEmpty()
                    val last = state.items.lastOrNull()
                    if (reason.isNotBlank() && !(last is ChatItem.Failure && last.text == reason)) {
                        state.items.add(ChatItem.Failure(reason, now))
                    }
                }
                is StreamEvent.Text -> if (ev.sessionId == sessionId && ev.text.isNotBlank()) {
                    state.thinking = false
                    state.items.add(ChatItem.Msg(ev.role, ev.text, now))
                }
                is StreamEvent.ToolCall -> if (ev.sessionId == sessionId) {
                    state.thinking = true
                    state.items.add(ChatItem.Tool(ev.name, ev.args, false, now))
                }
                is StreamEvent.ToolResult -> if (ev.sessionId == sessionId) {
                    state.items.add(ChatItem.Tool("↳", ev.text, ev.isError, now))
                }
                is StreamEvent.TurnEnd -> if (ev.sessionId == sessionId) state.thinking = false
                is StreamEvent.RateLimit -> if (ev.sessionId == sessionId && ev.status != "allowed") {
                    state.items.add(
                        ChatItem.Notice("Usage limit reached — switching brains", NoticeTone.Warn, now),
                    )
                }
                is StreamEvent.BrainSwap -> state.items.add(
                    ChatItem.Notice(
                        if (ev.mode == "resume") "Switched accounts — conversation carried over"
                        else "Switched models — continuing from checkpoint",
                        NoticeTone.Neutral,
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

    // Follow the tail as the keyboard moves, too. The shell shrinks this list to
    // make room for the raised composer, and without re-anchoring, the newest
    // message — the one being replied to — is the first thing to slide out of
    // view. Driven off the animated inset rather than a visible/hidden flag so
    // the tail stays pinned for every frame of the keyboard animation, not just
    // its start.
    val density = LocalDensity.current
    val ime = WindowInsets.ime
    LaunchedEffect(listState, density) {
        snapshotFlow { ime.getBottom(density) }.collect {
            if (state.items.isNotEmpty()) listState.scrollToItem(state.items.size - 1)
        }
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
                .onSuccess { r ->
                    // The work may have moved: reviving a dead session or a
                    // brain swap starts a new one. Without following it the
                    // stream filter watches an id that will never speak again,
                    // and the reply simply never appears.
                    r?.movedTo?.takeIf { it.isNotBlank() && it != sessionId }?.let { moved ->
                        state.items.add(
                            ChatItem.Notice(
                                "Continued in a new session after a restart or brain swap.",
                                NoticeTone.Neutral,
                                System.currentTimeMillis(),
                            ),
                        )
                        onMoved(moved)
                    }
                }
                .onFailure {
                    state.items.add(
                        ChatItem.Failure(
                            it.message.orEmpty().ifBlank { it.toString() },
                            System.currentTimeMillis(),
                        ),
                    )
                    state.thinking = false
                }
            state.sending = false
        }
    }

    SimbaShell(
        header = {
            Row(
                Modifier.fillMaxWidth().background(Panel).padding(horizontal = 10.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onBack, modifier = Modifier.size(34.dp)) {
                    Icon(Icons.Filled.ArrowBack, "Back", tint = Dim, modifier = Modifier.size(19.dp))
                }
                Column(Modifier.weight(1f).padding(start = 4.dp)) {
                    Text(title, color = Fg, fontWeight = FontWeight.SemiBold, fontSize = 14.5.sp, maxLines = 1)
                    // Clipped by layout, not by take(N): the full reason is still
                    // in state.error and reaches the thread as a Failure row.
                    Text(
                        when {
                            state.error != null -> state.error!!
                            state.thinking -> "working…"
                            state.connected -> "live"
                            else -> "connecting…"
                        },
                        fontSize = 10.5.sp,
                        color = if (state.error != null) Err else if (state.connected) Ok else Faint,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                // Reviewing what a session changed is the point at which unattended
                // work becomes trustworthy, so it belongs one tap from the
                // conversation rather than buried somewhere else.
                IconButton(onClick = { showDiff = true }, modifier = Modifier.size(34.dp)) {
                    Icon(Icons.Filled.Difference, "Changes", tint = Dim, modifier = Modifier.size(18.dp))
                }
                Box(
                    Modifier.size(7.dp).clip(RoundedCornerShape(99.dp))
                        .background(if (state.connected) Ok else Faint),
                )
            }
        },
        bottomBar = {
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
                        containerColor = Accent, contentColor = OnAccent,
                    ),
                    modifier = Modifier.size(46.dp),
                ) { Icon(Icons.Filled.Send, "Send", modifier = Modifier.size(19.dp)) }
            }
        },
    ) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            // Bottom-heavy on purpose: the composer sits outside this list, so the
            // padding is breathing room under the newest message rather than
            // clearance for the keyboard, which the shell already handles.
            contentPadding = PaddingValues(start = 11.dp, end = 11.dp, top = 11.dp, bottom = 18.dp),
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
                    MessageBody(item.text, color = Fg)
                }
            }
        }

        // Pairing a call with its result is the next step's job; this branch only
        // stops the detail being an unbounded or arbitrarily clipped line.
        is ChatItem.Tool -> if (item.isError) {
            ErrorBlock(item.detail, label = item.name)
        } else {
            Box(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(Panel2)
                    .padding(horizontal = 9.dp, vertical = 6.dp),
            ) {
                ExpandableBody(
                    item.detail,
                    monospace = true,
                    color = Info,
                    summaryPrefix = item.name,
                )
            }
        }

        is ChatItem.Failure -> ErrorBlock(item.text, label = "Could not send")

        is ChatItem.Notice -> {
            val tone = noticeColor(item.tone)
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Box(
                    Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(tone.copy(alpha = 0.13f))
                        .padding(horizontal = 11.dp, vertical = 6.dp),
                ) { Text(item.text, color = tone, fontSize = 11.5.sp) }
            }
        }
    }
}
