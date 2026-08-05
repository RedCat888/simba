package com.operator.simba

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.clickable
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
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

    /**
     * Messages typed while the agent was still working.
     *
     * An agent turn here can take minutes, and the composer used to refuse input
     * for all of it, so a thought you had while watching it work was either lost
     * or held in your head until it finished.
     *
     * Deliberately NOT keyed on sessionId, unlike everything else here. A brain
     * running out of quota moves the work to a new session, which re-keys the
     * state — and a queue inside that state went with it, silently. Two messages
     * typed during a long turn would vanish at exactly the moment the system is
     * built to handle transparently. A message you queued is one you still want
     * sent, so it follows the work.
     */
    val queued = remember { mutableStateListOf<String>() }
    val listState = rememberLazyListState()
    var draft by remember { mutableStateOf("") }
    var showDiff by remember { mutableStateOf(false) }
    var finding by remember { mutableStateOf(false) }
    var findQuery by remember { mutableStateOf("") }
    var menu by remember { mutableStateOf(false) }
    var confirmingStop by remember { mutableStateOf(false) }

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

    fun deliver(text: String) {
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

    /**
     * Drain, against whichever session is current.
     *
     * This was a recursive call at the end of deliver(), which was wrong twice
     * over: it closed over the sessionId deliver() had been created with, so
     * after a brain swap it posted to a session that would never answer, and it
     * kept the drain alive across a composition that no longer existed. An
     * effect re-reads sessionId every time it restarts, so the next queued
     * message always goes where the work actually is.
     *
     * deliver() sets sending before it suspends, so this cannot double-fire.
     */
    LaunchedEffect(sessionId, state.sending, queued.size) {
        if (!state.sending && queued.isNotEmpty()) {
            deliver(queued.removeAt(0))
        }
    }

    fun send() {
        val text = draft.trim()
        if (text.isEmpty()) return
        draft = ""
        if (state.sending) {
            queued.add(text)
        } else {
            deliver(text)
        }
    }

    if (confirmingStop) {
        ConfirmDialog(
            title = "Stop this session?",
            consequence = "The agent is killed where it is. Anything it had written " +
                "to disk stays, and its worktree is kept for review.",
            confirmLabel = "Stop it",
            onConfirm = {
                scope.launch {
                    runCatching { vm.api?.killSession(sessionId) }
                        .onFailure {
                            state.items.add(
                                ChatItem.Failure(
                                    "Could not stop this session: ${it.message}",
                                    System.currentTimeMillis(),
                                ),
                            )
                        }
                    vm.refresh()
                }
            },
            onDismiss = { confirmingStop = false },
        )
    }

    SimbaShell(
        header = {
            Row(
                Modifier.fillMaxWidth().background(Panel).padding(horizontal = space.snug, vertical = space.snug),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BackButton(onBack)
                Column(Modifier.weight(1f).padding(start = space.tight)) {
                    Text(title, color = Fg, fontWeight = FontWeight.SemiBold, style = type.body, maxLines = 1)
                    // Clipped by layout, not by take(N): the full reason is still
                    // in state.error and reaches the thread as a Failure row.
                    Text(
                        when {
                            state.error != null -> state.error!!
                            state.thinking -> "working…"
                            state.connected -> "live"
                            else -> "connecting…"
                        },
                        style = type.micro,
                        color = if (state.error != null) Err else if (state.connected) Ok else Faint,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                ActionIcon(
                    Icons.Filled.Search,
                    glyph = "/find",
                    label = "Find",
                    tint = if (finding) Accent else Dim,
                ) { finding = !finding }
                // Reviewing what a session changed is the point at which unattended
                // work becomes trustworthy, so it belongs one tap from the
                // conversation rather than buried somewhere else.
                ActionIcon(Icons.Filled.Difference, glyph = "diff", label = "Changes") { showDiff = true }
                Box {
                    ActionIcon(Icons.Filled.MoreVert, glyph = "...", label = "Session") { menu = true }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(
                            text = { Text("Switch brain") },
                            onClick = {
                                menu = false
                                scope.launch {
                                    val r = runCatching { vm.api?.failoverSession(sessionId) }
                                    state.items.add(
                                        ChatItem.Notice(
                                            if (r.isSuccess) "Moving to the next brain…"
                                            else "Not live — nothing to switch",
                                            if (r.isSuccess) NoticeTone.Neutral else NoticeTone.Warn,
                                            System.currentTimeMillis(),
                                        ),
                                    )
                                }
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("Stop this session", color = Err) },
                            onClick = { menu = false; confirmingStop = true },
                        )
                    }
                }
                Box(
                    Modifier.size(7.dp).clip(RoundedCornerShape(99.dp))
                        .background(if (state.connected) Ok else Faint),
                )
            }

            /**
             * Find in this conversation.
             *
             * A working session is thousands of lines of tool output, and the
             * thing you want — the path it wrote, the error it hit — is somewhere
             * in the middle. Scrolling for it is the single worst thing about
             * reading a long transcript on a phone.
             */
            AnimatedVisibility(finding) {
                Row(
                    Modifier.fillMaxWidth().background(Panel2).padding(horizontal = space.base, vertical = space.snug),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.weight(1f)) {
                        if (findQuery.isEmpty()) Text("Find in conversation", color = Faint, style = type.bodySmall)
                        BasicTextField(
                            value = findQuery,
                            onValueChange = { findQuery = it },
                            singleLine = true,
                            textStyle = type.bodySmall.copy(color = Fg),
                            cursorBrush = SolidColor(Accent),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Text(
                        "close",
                        color = Accent,
                        style = type.label,
                        modifier = Modifier.clickable { finding = false; findQuery = "" }.tapTarget().padding(start = space.snug),
                    )
                }
            }
        },
        bottomBar = {
            Composer(
                draft = draft,
                onDraft = { draft = it },
                enabled = draft.isNotBlank(),
                onSend = { send() },
            )
        },
    ) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            // Bottom-heavy on purpose: the composer sits outside this list, so the
            // padding is breathing room under the newest message rather than
            // clearance for the keyboard, which the shell already handles.
            contentPadding = PaddingValues(start = 11.dp, end = 11.dp, top = 11.dp, bottom = 18.dp),
            verticalArrangement = Arrangement.spacedBy(space.snug),
        ) {
            val q = findQuery.trim()
            val shown = if (q.isEmpty()) state.items else state.items.filter { it.matches(q) }

            if (q.isNotEmpty()) {
                item {
                    Text(
                        if (shown.isEmpty()) "No matches" else "${shown.size} matching",
                        color = Faint,
                        style = type.caption,
                    )
                }
            }
            items(shown) { item -> ChatRow(item) }

            // The one list in the app that never got an empty state, on the
            // screen where it matters most. A session started thirty seconds ago
            // has no messages yet, and a blank thread is indistinguishable from
            // history that failed to load — which on the surface you use to
            // steer an agent is the worst place to leave that ambiguity.
            //
            // Not shown while thinking: the working indicator below is already
            // saying the same thing, better.
            if (shown.isEmpty() && q.isEmpty() && !state.thinking && state.error == null) {
                item {
                    EmptyState(
                        if (state.connected) "Nothing said yet" else "Connecting…",
                        if (state.connected) {
                            "The agent is running and has not produced output. Send it something."
                        } else {
                            null
                        },
                    )
                }
            }

            // Queued messages, shown as themselves rather than as sent ones —
            // a message that has not left yet must not look like it has.
            if (q.isEmpty()) items(queued) { text -> QueuedRow(text) }
            if (state.thinking && q.isEmpty()) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 2.dp, color = Accent)
                        Text("  thinking", color = Faint, style = type.label)
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
                            .padding(horizontal = space.gutter, vertical = space.base),
                    ) { MessageBody(item.text, color = Fg) }
                }
            } else {
                Box(Modifier.fillMaxWidth().padding(end = space.roomy, top = space.hair, bottom = space.hair)) {
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
                    .padding(horizontal = space.base, vertical = space.snug),
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
                style = type.label,
                modifier = Modifier
                    .clip(RoundedCornerShape(99.dp))
                    .background(tone.copy(alpha = 0.12f))
                    .padding(horizontal = space.base, vertical = space.tight),
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
                    Box(Modifier.padding(horizontal = space.base, vertical = space.snug)) {
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
                Box(Modifier.padding(horizontal = space.base, vertical = space.snug)) {
                    ExpandableBody(item.detail, monospace = true, color = Dim, summaryPrefix = item.name)
                }
            }
        }

        is ChatItem.Failure -> ErrorBlock(item.text, label = "Could not send")

        is ChatItem.Notice -> Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            AssistChip(
                onClick = {},
                label = { Text(item.text, style = type.label) },
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
            Row(Modifier.fillMaxWidth().padding(vertical = space.hair)) {
                Text(
                    if (isUser) "you>" else "simba>",
                    color = if (isUser) Accent else Ok,
                    style = type.caption,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(end = space.snug),
                )
                MessageBody(item.text, color = Fg)
            }
        }

        is ChatItem.Tool -> Row(Modifier.fillMaxWidth().padding(vertical = space.hair)) {
            Text(
                if (item.isError) "!" else ">",
                color = if (item.isError) Err else Faint,
                style = type.caption,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(end = space.snug),
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
                style = type.caption,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(end = space.snug),
            )
            Text(item.text, color = Err, style = type.caption, fontFamily = FontFamily.Monospace)
        }

        is ChatItem.Notice -> Text(
            "* " + item.text,
            color = noticeColor(item.tone),
            style = type.caption,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.fillMaxWidth().padding(vertical = space.hair),
        )
    }
}


/**
 * Writing the message.
 *
 * The most-touched surface in the app, and until now the one place all three
 * designs were provably identical: one OutlinedTextField and one filled circle.
 * What a composer looks like is most of what a chat app feels like, so each
 * design gets the one its own argument implies.
 */
@Composable
private fun Composer(
    draft: String,
    onDraft: (String) -> Unit,
    enabled: Boolean,
    onSend: () -> Unit,
) {
    when (LocalDesign.current) {
        // Fluid: a single capsule containing the text and the send control, so
        // it reads as one object rather than a field with a button beside it.
        // The send target only appears once there is something to send — a
        // permanently-dimmed button is chrome that spends attention every time
        // you look at it and pays out rarely.
        Design.Fluid -> Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = space.base, vertical = space.snug)
                .clip(RoundedCornerShape(26.dp))
                .background(Panel)
                .padding(start = space.gutter, end = space.tight, top = space.tight, bottom = space.tight),
            verticalAlignment = Alignment.Bottom,
        ) {
            Box(Modifier.weight(1f).padding(bottom = space.base, top = space.snug)) {
                if (draft.isEmpty()) {
                    Text("Message Simba", color = Faint, style = type.body)
                }
                BasicTextField(
                    value = draft,
                    onValueChange = onDraft,
                    textStyle = type.body.copy(color = Fg),
                    cursorBrush = SolidColor(Accent),
                    maxLines = 6,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            AnimatedVisibility(
                visible = enabled,
                // Kept bouncy on purpose, and the only one in the app that is:
                // this marks a threshold being crossed — the message became
                // sendable — rather than a surface moving. A threshold is what a
                // spring is actually for.
                enter = fadeIn(spring()) + scaleIn(spring(dampingRatio = Spring.DampingRatioMediumBouncy)),
                exit = fadeOut() + scaleOut(),
            ) {
                Box(
                    Modifier
                        .size(42.dp)
                        .clip(RoundedCornerShape(99.dp))
                        .background(Accent)
                        .clickable { onSend() },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(SimbaIcons.Send, "Send", tint = OnAccent, modifier = Modifier.size(19.dp))
                }
            }
        }

        // Material: the specified components, unmodified.
        Design.Material -> Surface(tonalElevation = 3.dp) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = space.base, vertical = space.snug),
                verticalAlignment = Alignment.Bottom,
            ) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = onDraft,
                    placeholder = { Text("Message") },
                    modifier = Modifier.weight(1f),
                    maxLines = 5,
                    shape = MaterialTheme.shapes.extraLarge,
                )
                Spacer(Modifier.width(8.dp))
                FilledIconButton(
                    onClick = onSend,
                    enabled = enabled,
                    modifier = Modifier.size(48.dp),
                ) { Icon(Icons.AutoMirrored.Filled.Send, "Send") }
            }
        }

        // Console: a prompt line. No button — the IME's Go key sends, which is
        // what a terminal does with Return, and it keeps the whole width for
        // what you are typing.
        Design.Console -> Row(
            Modifier
                .fillMaxWidth()
                .background(Panel)
                .padding(horizontal = space.snug, vertical = space.snug),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "you>",
                color = Accent,
                style = type.label,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
            )
            BasicTextField(
                value = draft,
                onValueChange = onDraft,
                textStyle = type.label.copy(color = Fg, fontFamily = FontFamily.Monospace),
                cursorBrush = SolidColor(Accent),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { if (enabled) onSend() }),
                modifier = Modifier.weight(1f).padding(start = space.tight),
            )
        }
    }
}


/** Does this row contain the text being searched for? */
private fun ChatItem.matches(q: String): Boolean = when (this) {
    is ChatItem.Msg -> text.contains(q, ignoreCase = true)
    // Tool names count: "the step where it ran git" is a real thing to look for.
    is ChatItem.Tool -> name.contains(q, ignoreCase = true) || detail.contains(q, ignoreCase = true)
    is ChatItem.Failure -> text.contains(q, ignoreCase = true)
    is ChatItem.Notice -> text.contains(q, ignoreCase = true)
}


/**
 * A message waiting its turn.
 *
 * Deliberately not styled like a sent one. The single worst thing a chat client
 * can do is show something as sent that has not left, so this is dimmed, has no
 * accent, and carries the word — being unmistakable matters more here than
 * being pretty.
 */
@Composable
private fun QueuedRow(text: String) {
    when (LocalDesign.current) {
        Design.Console -> Row(Modifier.fillMaxWidth().padding(vertical = space.hair)) {
            Text(
                "...>",
                color = Faint,
                style = type.caption,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(end = space.snug),
            )
            Text(text, color = Faint, style = type.caption, fontFamily = FontFamily.Monospace)
        }

        else -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Column(
                Modifier
                    .widthIn(max = 300.dp)
                    .clip(RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomStart = 18.dp, bottomEnd = 6.dp))
                    .background(Panel)
                    .padding(horizontal = space.base, vertical = space.snug),
                horizontalAlignment = Alignment.End,
            ) {
                Text(text, color = Dim, style = type.bodySmall, lineHeight = 19.sp)
                Text("queued", color = Faint, style = type.micro, modifier = Modifier.padding(top = space.hair))
            }
        }
    }
}
