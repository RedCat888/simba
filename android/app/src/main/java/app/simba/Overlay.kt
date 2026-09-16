package app.simba

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs

/**
 * Simba, floating over whatever else you are doing.
 *
 * The app is a place you have to decide to open, and the two things that matter
 * most here are both things you will not think to go and look for. An agent
 * waiting on an approval is stopped — it is not making progress and it will not
 * make progress until someone answers, and every minute of that is a minute the
 * machine sat idle. And a reel or a link worth keeping is worth keeping at the
 * moment you see it, inside the app you saw it in, not after a context switch
 * that you will usually decide against making.
 *
 * So this is deliberately not a smaller copy of the app. It shows what is
 * blocked, what is running, and a box to throw something into — and nothing
 * else. Everything that can wait belongs in the app, where there is room to
 * show it properly.
 *
 * The collapsed bubble is a status light. Its colour is the whole message: red
 * means something is waiting on you, and that is the only state that should
 * pull your eye. A bubble that is always shouting gets moved to the corner and
 * then turned off, which is the failure mode to design against.
 */
class OverlayService : Service(), LifecycleOwner, ViewModelStoreOwner, SavedStateRegistryOwner {

    private val lifecycleRegistry = LifecycleRegistry(this)
    private val savedStateController = SavedStateRegistryController.create(this)
    override val viewModelStore = ViewModelStore()
    override val lifecycle: Lifecycle get() = lifecycleRegistry
    override val savedStateRegistry: SavedStateRegistry get() = savedStateController.savedStateRegistry

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var windows: WindowManager
    private var root: ComposeView? = null
    private lateinit var params: WindowManager.LayoutParams

    private var state by mutableStateOf(OverlayState())
    private var expanded by mutableStateOf(false)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        savedStateController.performRestore(null)
        lifecycleRegistry.currentState = Lifecycle.State.CREATED
        windows = getSystemService(Context.WINDOW_SERVICE) as WindowManager

        startForeground(NOTIFICATION_ID, notification())
        addBubble()
        lifecycleRegistry.currentState = Lifecycle.State.RESUMED
        poll()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        // Sticky: the point of this is to be there without being thought about,
        // so surviving a low-memory kill is the whole contract.
        return START_STICKY
    }

    override fun onDestroy() {
        lifecycleRegistry.currentState = Lifecycle.State.DESTROYED
        scope.cancel()
        root?.let { runCatching { windows.removeView(it) } }
        root = null
        viewModelStore.clear()
        super.onDestroy()
    }

    // ── the window ───────────────────────────────────────────────────────
    private fun addBubble() {
        params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else
                @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE,
            // NOT_FOCUSABLE while collapsed so every key press and every tap
            // outside the bubble still belongs to the app underneath. Taking
            // focus for a status light would break typing in whatever is behind
            // it, which is a far worse bug than anything this fixes.
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 0
            y = 320
        }

        val view = ComposeView(this).apply {
            setViewTreeLifecycleOwner(this@OverlayService)
            setViewTreeViewModelStoreOwner(this@OverlayService)
            setViewTreeSavedStateRegistryOwner(this@OverlayService)
            setContent {
                SimbaTheme(design = Design.Fluid, dark = true) {
                    Bubble(
                        state = state,
                        expanded = expanded,
                        onToggle = { showPanel(!expanded) },
                        onDecide = ::decide,
                        onCapture = ::capture,
                        onSay = ::sayToSimba,
                        onOpenApp = ::openApp,
                    )
                }
            }
        }
        view.setOnTouchListener(DragToMove())
        windows.addView(view, params)
        root = view
    }

    /**
     * Expanding has to take focus, or the text field cannot receive a keystroke.
     * Collapsing has to give it back immediately — an overlay that keeps focus
     * while showing a 44dp dot is an overlay that has stolen the keyboard.
     */
    private fun showPanel(open: Boolean) {
        expanded = open
        params.flags = if (open) {
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
        } else {
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
        }
        root?.let { runCatching { windows.updateViewLayout(it, params) } }
    }

    /** Drag to move, tap to open. Distinguished by distance, not by timing. */
    private inner class DragToMove : View.OnTouchListener {
        private var startX = 0
        private var startY = 0
        private var touchX = 0f
        private var touchY = 0f
        private var moved = false

        override fun onTouch(v: View, e: MotionEvent): Boolean {
            when (e.action) {
                MotionEvent.ACTION_DOWN -> {
                    startX = params.x; startY = params.y
                    touchX = e.rawX; touchY = e.rawY
                    moved = false
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - touchX
                    val dy = e.rawY - touchY
                    if (abs(dx) > TOUCH_SLOP || abs(dy) > TOUCH_SLOP) moved = true
                    if (moved) {
                        params.x = startX + dx.toInt()
                        params.y = startY + dy.toInt()
                        runCatching { windows.updateViewLayout(v, params) }
                    }
                }
                MotionEvent.ACTION_UP -> {
                    if (!moved) return false // let Compose handle it as a click
                    if (!expanded) snapToEdge(v)
                }
            }
            return false
        }

        /** Collapsed, it lives against a side — anywhere else it covers content. */
        private fun snapToEdge(v: View) {
            val width = resources.displayMetrics.widthPixels
            params.x = if (params.x + v.width / 2 < width / 2) 0 else width - v.width
            runCatching { windows.updateViewLayout(v, params) }
        }
    }

    // ── data ─────────────────────────────────────────────────────────────
    private fun poll() = scope.launch {
        while (true) {
            val api = runCatching { applicationContext.api() }.getOrNull()
            if (api == null) {
                state = state.copy(reachable = false)
            } else {
                val pending = runCatching { api.pendingActions() }
                val sessions = runCatching { api.sessions() }
                // Failure here is not failure of the poll: the inventory is the
                // least urgent thing on this surface, and losing it must not
                // cost the approvals it sits beside.
                val exposed = runCatching { api.projects() }.getOrNull()?.count { it.atRisk } ?: 0
                state = if (pending.isSuccess && sessions.isSuccess) {
                    OverlayState(
                        reachable = true,
                        pending = pending.getOrDefault(emptyList()),
                        working = sessions.getOrDefault(emptyList()).count { it.status == "running" },
                        exposed = exposed,
                    )
                } else {
                    // The gateway is a home PC behind a tunnel; unreachable is a
                    // normal condition, not an error worth a red dot. Red is
                    // reserved for "you are the blocker".
                    state.copy(reachable = false)
                }
            }
            // Slower when nothing is waiting. This runs all day on a phone, and
            // an overlay that costs battery to tell you nothing gets uninstalled.
            delay(if (state.pending.isEmpty()) 60_000 else 20_000)
        }
    }

    private fun decide(id: String, approve: Boolean) = scope.launch {
        val api = applicationContext.api()
        runCatching { api.decideAction(id, approve) }
            .onSuccess { state = state.copy(pending = state.pending.filterNot { it.id == id }, notice = null) }
            // Previously this dropped the failure entirely, so a declined
            // approval that never reached the PC left the row sitting there
            // with nothing to say why tapping it did nothing. The row staying
            // is right; saying nothing about it is not.
            .onFailure { state = state.copy(notice = shortReason(it)) }
    }

    private suspend fun sayToSimba(text: String): Boolean {
        val api = runCatching { applicationContext.api() }.getOrNull() ?: return false
        return runCatching { api.saySimba(text) }
            .onSuccess { state = state.copy(notice = null) }
            .onFailure { state = state.copy(notice = shortReason(it)) }
            .isSuccess
    }

    /** Returns whether it actually landed, because the caller clears the box on it. */
    private suspend fun capture(text: String): Boolean {
        val api = runCatching { applicationContext.api() }.getOrNull() ?: return false
        return runCatching { api.capture(text, "overlay") }
            .onSuccess { state = state.copy(captured = state.captured + 1, notice = null) }
            .onFailure { state = state.copy(notice = shortReason(it)) }
            .isSuccess
    }

    /** A phone-sized reason. Stack traces are not an answer on a 300dp panel. */
    private fun shortReason(e: Throwable): String = when {
        e is SimbaApi.ApiException && e.isAuthFailure -> "Not authorised — check Access credentials"
        e is SimbaApi.ApiException -> e.message?.take(80) ?: "Rejected by the PC"
        else -> "Couldn't reach the PC"
    }

    private fun openApp() {
        showPanel(false)
        startActivity(
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        )
    }

    // ── the notification the OS requires of a foreground service ─────────
    private fun notification(): Notification {
        val mgr = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            mgr.createNotificationChannel(
                NotificationChannel(CHANNEL, "Overlay", NotificationManager.IMPORTANCE_MIN).apply {
                    description = "Keeps the floating Simba bubble alive."
                },
            )
        }
        val stop = PendingIntent.getService(
            this, 0, Intent(this, OverlayService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompatBuilder()
            .setContentTitle("Simba bubble")
            .setContentText("Tap to stop")
            .setContentIntent(stop)
            .build()
    }

    private fun NotificationCompatBuilder() =
        androidx.core.app.NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .setPriority(androidx.core.app.NotificationCompat.PRIORITY_MIN)
            .setForegroundServiceBehavior(androidx.core.app.NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)

    companion object {
        const val CHANNEL = "simba-overlay"
        const val ACTION_STOP = "app.simba.OVERLAY_STOP"
        private const val NOTIFICATION_ID = 4242
        private const val TOUCH_SLOP = 12

        /** Can we draw over other apps? Granted only in Settings, never by dialog. */
        fun permitted(ctx: Context): Boolean = Settings.canDrawOverlays(ctx)

        fun permissionIntent(ctx: Context) = Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            android.net.Uri.parse("package:${ctx.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        fun start(ctx: Context) {
            val svc = Intent(ctx, OverlayService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(svc)
            else ctx.startService(svc)
        }

        fun stop(ctx: Context) = ctx.stopService(Intent(ctx, OverlayService::class.java))

        fun running(ctx: Context): Boolean {
            @Suppress("DEPRECATION")
            val mgr = ctx.getSystemService(android.app.ActivityManager::class.java)
            @Suppress("DEPRECATION")
            return mgr.getRunningServices(Int.MAX_VALUE)
                .any { it.service.className == OverlayService::class.java.name }
        }
    }
}

/** What the bubble knows. Deliberately small — it is a status light and an inbox. */
data class OverlayState(
    val reachable: Boolean = false,
    val pending: List<PendingAction> = emptyList(),
    val working: Int = 0,
    val captured: Int = 0,
    /**
     * Projects holding work that exists nowhere else.
     *
     * Reported but deliberately never colours the dot. It is a standing
     * condition, not an interruption — it has usually been true for days and
     * will still be true tomorrow — and a bubble that is red for something you
     * cannot act on in the next ten seconds is a bubble that gets turned off.
     */
    val exposed: Int = 0,
    /**
     * The last thing that went wrong, in words.
     *
     * Cleared by the next success. Without it this panel had exactly one way to
     * report a failure — doing nothing — which is indistinguishable from a tap
     * that missed, on a surface small enough that missing is likely.
     */
    val notice: String? = null,
)

// ---------------------------------------------------------------------------
// The bubble
// ---------------------------------------------------------------------------

@Composable
fun Bubble(
    state: OverlayState,
    expanded: Boolean,
    onToggle: () -> Unit,
    onDecide: (String, Boolean) -> Unit,
    onCapture: suspend (String) -> Boolean,
    onOpenApp: () -> Unit,
    onSay: (suspend (String) -> Boolean)? = null,
) {
    if (!expanded) {
        Collapsed(state, onToggle)
        return
    }
    Column(
        Modifier
            .width(300.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(Panel)
            .border(1.dp, Line, RoundedCornerShape(20.dp))
            .padding(vertical = space.base),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = space.gutter, vertical = space.tight),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(headline(state), color = Fg, style = type.heading)
            Text(
                "close",
                color = Dim,
                style = type.label,
                modifier = Modifier.clickable(onClick = onToggle).tapTarget().padding(start = space.snug),
            )
        }

        Column(Modifier.heightIn(max = 380.dp).verticalScroll(rememberScrollState())) {
            // Approvals first and always. This is the only thing here that is
            // costing time right now: an agent asking is an agent stopped.
            state.pending.take(4).forEach { action ->
                Approval(action, onDecide)
            }
            if (state.pending.isEmpty()) {
                Text(
                    // The headline already carries the count; repeating it here
                    // reads as two facts rather than one. This line's job is to
                    // say what that count means for you.
                    if (!state.reachable) "The PC is asleep or off the tunnel. Nothing is lost — " +
                        "anything shared queues up and lands when it's back."
                    else if (state.working > 0) "Nothing needs you — it's working."
                    else "Nothing needs you.",
                    color = Dim,
                    style = type.bodySmall,
                    modifier = Modifier.padding(horizontal = space.gutter, vertical = space.snug),
                )
            }

            // Last, quiet, and never in the dot's colour. This has usually been
            // true for days and will still be true tomorrow — it belongs here so
            // it is seen eventually, not so it interrupts.
            if (state.exposed > 0 && state.reachable) {
                Text(
                    if (state.exposed == 1) "1 project holds work that's only on the PC"
                    else "${state.exposed} projects hold work that's only on the PC",
                    color = Faint,
                    style = type.caption,
                    modifier = Modifier.padding(horizontal = space.gutter, vertical = space.tight),
                )
            }
        }

        // Above the capture box, because the most likely thing it explains is
        // why the capture box did not clear.
        state.notice?.let {
            Text(
                it,
                color = Err,
                style = type.caption,
                modifier = Modifier.padding(horizontal = space.gutter, vertical = space.tight),
            )
        }

        QuickCapture(onCapture)
        if (onSay != null) QuickTalk(onSay)

        Text(
            "Open Simba",
            color = Accent,
            style = type.label,
            modifier = Modifier
                .clickable(onClick = onOpenApp)
                .tapTarget()
                .padding(horizontal = space.gutter),
        )
    }
}

@Composable
private fun Collapsed(state: OverlayState, onToggle: () -> Unit) {
    val waiting = state.pending.isNotEmpty()
    Box(
        Modifier
            .size(52.dp)
            .clip(CircleShape)
            .background(if (waiting) Err else Panel)
            .border(1.dp, if (waiting) Err else Line, CircleShape)
            .clickable(onClick = onToggle),
        contentAlignment = Alignment.Center,
    ) {
        if (waiting) {
            Text(
                if (state.pending.size > 9) "9+" else "${state.pending.size}",
                color = Color.White,
                style = type.label,
            )
        } else {
            Box(
                Modifier.size(10.dp).clip(CircleShape).background(dotColour(state)),
            )
        }
    }
}

/**
 * One colour, one meaning.
 *
 * Red is only ever "you are the blocker". Unreachable is grey rather than red
 * on purpose — the gateway is a home PC behind a tunnel and being asleep is its
 * normal night-time state, so colouring that as an alarm would mean the bubble
 * is red most nights and therefore means nothing by the third day.
 */
@Composable
private fun dotColour(state: OverlayState): Color = when {
    state.pending.isNotEmpty() -> Err
    !state.reachable -> Faint
    state.working > 0 -> Accent
    else -> Ok
}

private fun headline(state: OverlayState): String = when {
    state.pending.size == 1 -> "1 needs you"
    state.pending.size > 1 -> "${state.pending.size} need you"
    !state.reachable -> "Offline"
    state.working > 0 -> "${state.working} running"
    else -> "Idle"
}

@Composable
private fun Approval(action: PendingAction, onDecide: (String, Boolean) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = space.gutter, vertical = space.snug)) {
        Text(action.summary, color = Fg, style = type.bodySmall)
        Row(
            Modifier.fillMaxWidth().padding(top = space.tight),
            horizontalArrangement = Arrangement.spacedBy(space.gutter),
            // The actions carry a 44dp tap target and the agent label does not,
            // so without this the label hangs off the top of the row.
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Approve is not styled as the obvious one. These grant an agent a
            // real action on a real machine, and a default-looking button is a
            // button that gets pressed without reading the line above it.
            Text(
                "Approve",
                color = Ok,
                style = type.label,
                modifier = Modifier.clickable { onDecide(action.id, true) }.tapTarget(),
            )
            Text(
                "Decline",
                color = Err,
                style = type.label,
                modifier = Modifier.clickable { onDecide(action.id, false) }.tapTarget(),
            )
            // Pushed to the far end: it says who is asking, which is context for
            // the decision rather than part of making it.
            Box(Modifier.weight(1f))
            action.agent?.let { Text(it, color = Faint, style = type.caption) }
        }
    }
}

@Composable
private fun QuickCapture(onCapture: suspend (String) -> Boolean) {
    var text by remember { mutableStateOf("") }
    var sent by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(sent) {
        if (sent) { delay(1400); sent = false }
    }

    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = space.gutter, vertical = space.snug),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .weight(1f)
                .clip(RoundedCornerShape(radius.small))
                .background(Inset)
                .padding(horizontal = space.base, vertical = space.snug),
        ) {
            if (text.isEmpty() && !sent && !sending) {
                Text("Capture a link or a thought", color = Faint, style = type.bodySmall)
            }
            if (sending) Text("Sending…", color = Dim, style = type.bodySmall)
            if (sent) Text("Captured", color = Ok, style = type.bodySmall)
            BasicTextField(
                value = text,
                onValueChange = { text = it },
                textStyle = TextStyle(color = Fg, fontSize = type.bodySmall.fontSize),
                cursorBrush = SolidColor(Accent),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Text(
            if (sending) "…" else "Send",
            color = if (text.isBlank() || sending) Faint else Accent,
            style = type.label,
            modifier = Modifier
                .clickable(enabled = text.isNotBlank() && !sending) {
                    // The box clears only once the PC has actually taken it.
                    //
                    // It used to clear and say "Captured" the instant you tapped,
                    // before the request had even been made — so with the PC
                    // asleep the thought was erased and you were told it was
                    // saved. On a surface whose whole promise is "throw it here
                    // and stop thinking about it", that is the one bug that
                    // makes the surface worse than not having it.
                    val pending = text.trim()
                    sending = true
                    scope.launch {
                        val ok = onCapture(pending)
                        sending = false
                        if (ok) { text = ""; sent = true }
                    }
                }
                .tapTarget()
                .padding(start = space.base),
        )
    }
}

@Composable
private fun QuickTalk(onSay: suspend (String) -> Boolean) {
    var text by remember { mutableStateOf("") }
    var sent by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(sent) {
        if (sent) { delay(1400); sent = false }
    }

    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = space.gutter, vertical = space.snug),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .weight(1f)
                .clip(RoundedCornerShape(radius.small))
                .background(Inset)
                .padding(horizontal = space.base, vertical = space.snug),
        ) {
            if (text.isEmpty() && !sent && !sending) {
                Text("Tell Simba…", color = Faint, style = type.bodySmall)
            }
            if (sending) Text("Sending…", color = Dim, style = type.bodySmall)
            if (sent) Text("Sent", color = Ok, style = type.bodySmall)
            BasicTextField(
                value = text,
                onValueChange = { text = it },
                textStyle = TextStyle(color = Fg, fontSize = type.bodySmall.fontSize),
                cursorBrush = SolidColor(Accent),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Text(
            if (sending) "…" else "Talk",
            color = if (text.isBlank() || sending) Faint else Accent,
            style = type.label,
            modifier = Modifier
                .clickable(enabled = text.isNotBlank() && !sending) {
                    val pending = text.trim()
                    sending = true
                    scope.launch {
                        val ok = onSay(pending)
                        sending = false
                        if (ok) { text = ""; sent = true }
                    }
                }
                .tapTarget()
                .padding(start = space.base),
        )
    }
}

/** Fades the whole panel in, so expanding does not feel like a popup ad. */
@Composable
fun BubbleTransition(visible: Boolean, content: @Composable () -> Unit) {
    val density = LocalDensity.current
    AnimatedVisibility(
        visible = visible,
        enter = fadeIn() + expandVertically { with(density) { -8.dp.roundToPx() } },
        exit = fadeOut() + shrinkVertically(),
    ) { content() }
}
