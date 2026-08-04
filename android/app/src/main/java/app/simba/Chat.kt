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
import androidx.compose.ui.text.font.FontFamily
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
    when (LocalDesign.current) {
        Design.Fluid -> FluidChatRow(item)
        Design.Material -> MaterialChatRow(item)
        Design.Console -> ConsoleChatRow(item)
    }
}

/**
 * Fluid: the assistant is not in a bubble.
 *
 * Every serious assistant product puts the user's words in a contained bubble
 * and lets the reply run as plain text across the column. A bubble reads as a
 * quoted utterance, which is right for a short thing you said and wrong for
 * four paragraphs you are meant to sit and read. Boxing both is what makes a
 * chat look like a toy.
 *
 * The per-message role caption is gone for the same reason: it labelled what
 * alignment and colour already say, and no shipping product does it.
 */
@Composable
private fun FluidChatRow(item: ChatItem) {
    when (item) {
        is ChatItem.Msg -> {
            val isUser = item.role == "user"
            if (isUser) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    Box(
                        Modifier
                            .widthIn(max = 300.dp)
                            .clip(
                                RoundedCornerShape(
                                    topStart = 20.dp,
                                    topEnd = 20.dp,
                                    bottomStart = 20.dp,
                                    bottomEnd = 6.dp,
                                ),
                            )
                            .background(Accent.copy(alpha = 0.16f))
                            .padding(horizontal = 15.dp, vertical = 11.dp),
                    ) { MessageBody(item.text, color = Fg) }
                }
            } else {
                Box(Modifier.fillMaxWidth().padding(end = 24.dp, top = 2.dp, bottom = 2.dp)) {
                    MessageBody(item.text, color = Fg)
                }
            }
        }

        is ChatItem.Tool -> if (item.isError) {
            ErrorBlock(item.detail, label = item.name)
        } else {
            // Quiet by default: tool activity is context for the reply, not the
            // reply. A soft surface rather than a panel competing with what the
            // assistant actually said.
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(Panel.copy(alpha = 0.6f))
                    .padding(horizontal = 13.dp, vertical = 9.dp),
            ) {
                ExpandableBody(item.detail, monospace = true, color = Dim, summaryPrefix = item.name)
            }
        }

        is ChatItem.Failure -> ErrorBlock(item.text, label = "Could not send")

        is ChatItem.Notice -> Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            val tone = noticeColor(item.tone)
            Text(
                item.text,
                color = tone,
                fontSize = 12.sp,
                modifier = Modifier
                    .clip(RoundedCornerShape(99.dp))
                    .background(tone.copy(alpha = 0.12f))
                    .padding(horizontal = 14.dp, vertical = 6.dp),
            )
        }
    }
}

/** Material: tonal surfaces and the shapes Material specifies for chat. */
@Composable
private fun MaterialChatRow(item: ChatItem) {
    when (item) {
        is ChatItem.Msg -> {
            val isUser = item.role == "user"
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
            ) {
                Surface(
                    color = if (isUser) {
                        MaterialTheme.colorScheme.primaryContainer
                    } else {
                        MaterialTheme.colorScheme.surfaceContainerHigh
                    },
                    contentColor = if (isUser) {
                        MaterialTheme.colorScheme.onPrimaryContainer
                    } else {
                        MaterialTheme.colorScheme.onSurface
                    },
                    shape = RoundedCornerShape(
                        topStart = 16.dp,
                        topEnd = 16.dp,
                        bottomStart = if (isUser) 16.dp else 4.dp,
                        bottomEnd = if (isUser) 4.dp else 16.dp,
                    ),
                    modifier = Modifier.widthIn(max = 320.dp),
                ) {
                    Box(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                        MessageBody(item.text, color = LocalContentColor.current)
                    }
                }
            }
        }

        is ChatItem.Tool -> if (item.isError) {
            ErrorBlock(item.detail, label = item.name)
        } else {
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainer,
                shape = MaterialTheme.shapes.medium,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Box(Modifier.padding(horizontal = 12.dp, vertical = 9.dp)) {
                    ExpandableBody(item.detail, monospace = true, color = Dim, summaryPrefix = item.name)
                }
            }
        }

        is ChatItem.Failure -> ErrorBlock(item.text, label = "Could not send")

        is ChatItem.Notice -> Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            AssistChip(
                onClick = {},
                label = { Text(item.text, fontSize = 12.sp) },
                colors = AssistChipDefaults.assistChipColors(labelColor = noticeColor(item.tone)),
            )
        }
    }
}

/**
 * Console: a transcript, not a conversation.
 *
 * Speaker prefixes rather than bubbles. Alignment and bubble margins cost
 * horizontal space a monospace transcript would rather spend on content, and a
 * prefix is how every terminal, log and IRC client has shown this for decades -
 * instantly legible to anyone who would pick this design in the first place.
 */
@Composable
private fun ConsoleChatRow(item: ChatItem) {
    when (item) {
        is ChatItem.Msg -> {
            val isUser = item.role == "user"
            Row(Modifier.fillMaxWidth().padding(vertical = 1.dp)) {
                Text(
                    if (isUser) "you>" else "simba>",
                    color = if (isUser) Accent else Ok,
                    fontSize = 11.5.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(end = 7.dp),
                )
                MessageBody(item.text, color = Fg)
            }
        }

        is ChatItem.Tool -> Row(Modifier.fillMaxWidth().padding(vertical = 1.dp)) {
            Text(
                if (item.isError) "!" else ">",
                color = if (item.isError) Err else Faint,
                fontSize = 11.5.sp,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(end = 7.dp),
            )
            ExpandableBody(
                item.detail,
                monospace = true,
                color = if (item.isError) Err else Dim,
                summaryPrefix = item.name,
            )
        }

        is ChatItem.Failure -> Row(Modifier.fillMaxWidth()) {
            Text(
                "!",
                color = Err,
                fontSize = 11.5.sp,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(end = 7.dp),
            )
            Text(item.text, color = Err, fontSize = 11.5.sp, fontFamily = FontFamily.Monospace)
        }

        is ChatItem.Notice -> Text(
            "* " + item.text,
            color = noticeColor(item.tone),
            fontSize = 11.sp,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.fillMaxWidth().padding(vertical = 1.dp),
        )
    }
}
