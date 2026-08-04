package com.operator.simba

import android.Manifest
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.datastore.preferences.core.edit
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.flow.first

/**
 * Polls for new briefs and notifies.
 *
 * There is no push infrastructure here — the gateway is a home PC behind a
 * tunnel — so polling is the honest mechanism rather than a compromise. The
 * notification carries direction and what needs a decision, never raw agent
 * output: a phone buzzing with transcript fragments trains you to ignore it.
 */
class BriefWorker(
    private val ctx: Context,
    params: WorkerParameters,
) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val api = ctx.api()

        val briefs = runCatching { api.briefs() }.getOrElse { err ->
            // Previously every failure was swallowed identically, so an expired
            // or revoked credential looked exactly like "the PC is asleep" and
            // would have gone unnoticed for days. Unreachable is expected and
            // stays quiet; not-authorised is a real problem and says so.
            if (err is SimbaApi.ApiException && err.isAuthFailure) {
                notifyAuthFailure(err.status)
            }
            return Result.success()
        }

        notifyNewEvents(api)

        val latest = briefs.firstOrNull() ?: return Result.success()
        val lastSeen = ctx.dataStore.data.first()[Prefs.LAST_BRIEF]
        if (latest.id == lastSeen) return Result.success()

        notify(latest)
        ctx.dataStore.edit { it[Prefs.LAST_BRIEF] = latest.id }
        return Result.success()
    }

    /**
     * Progress, as it happens.
     *
     * A brief is a summary written on a cadence, which is the right shape for
     * "here is where things stand" and the wrong one for "the mission you
     * started is stuck". Those are the events worth interrupting for, and until
     * now the phone learned about them whenever the next brief happened to
     * mention them — or never.
     *
     * Bounded to three per poll on purpose: a night of activity should not
     * produce a stack of forty notifications you swipe away without reading,
     * which is how a person learns to ignore the ones that matter.
     */
    private suspend fun notifyNewEvents(api: SimbaApi) {
        val events = runCatching { api.events() }.getOrElse { return }
        val lastSeen = ctx.dataStore.data.first()[Prefs.LAST_EVENT]

        val fresh = events.filter { it.notable }
            .let { list ->
                // Everything since the last one seen. On a first run there is no
                // mark, and replaying the entire backlog as notifications would
                // be the worst possible introduction — so only the newest is
                // taken and the mark is set from there.
                if (lastSeen == null) list.take(1)
                else list.takeWhile { it.id.toString() != lastSeen }
            }
        if (fresh.isEmpty()) return

        ctx.dataStore.edit { it[Prefs.LAST_EVENT] = fresh.first().id.toString() }

        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) return

        val open = PendingIntent.getActivity(
            ctx, 2, Intent(ctx, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        fresh.take(3).forEach { e ->
            val urgent = e.severity == "error" || e.type == "mission.blocked"
            val n = NotificationCompat.Builder(ctx, ACTIVITY_CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(e.label)
                .setContentText(e.message.take(120))
                .setStyle(NotificationCompat.BigTextStyle().bigText(e.message))
                .setPriority(
                    if (urgent) NotificationCompat.PRIORITY_HIGH
                    else NotificationCompat.PRIORITY_LOW,
                )
                .setContentIntent(open)
                .setAutoCancel(true)
                .build()
            ctx.getSystemService(NotificationManager::class.java).notify(e.id.hashCode(), n)
        }
    }

    private fun notifyAuthFailure(status: Int) {
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) return

        val open = PendingIntent.getActivity(
            ctx, 1, Intent(ctx, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(ctx, BRIEF_CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Simba can't authenticate")
            .setContentText(
                if (status == 403) "Access rejected this device (403). The service token may be revoked."
                else "Access credentials were not accepted (401). Re-enter them in System.",
            )
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()

        ctx.getSystemService(NotificationManager::class.java).notify(9001, n)
    }

    private fun notify(brief: Brief) {
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) return

        val open = PendingIntent.getActivity(
            ctx,
            0,
            Intent(ctx, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        // A decision request is the one thing worth raising priority for.
        val needsDecision = !brief.needsDecision.isNullOrBlank()
        val body = buildString {
            append(brief.body)
            if (needsDecision) append("\n\nNeeds you: ${brief.needsDecision}")
            if (!brief.stuck.isNullOrBlank()) append("\nStuck: ${brief.stuck}")
        }

        val n = NotificationCompat.Builder(ctx, BRIEF_CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(brief.headline)
            .setContentText(brief.body.take(90))
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(
                if (needsDecision) NotificationCompat.PRIORITY_HIGH
                else NotificationCompat.PRIORITY_DEFAULT,
            )
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()

        ctx.getSystemService(NotificationManager::class.java).notify(brief.id.hashCode(), n)
    }
}
