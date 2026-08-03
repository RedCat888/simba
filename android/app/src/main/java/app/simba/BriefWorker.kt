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
        val api = SimbaApi(ctx.gatewayUrl(), ctx.gatewayToken())

        val briefs = runCatching { api.briefs() }.getOrElse {
            // The PC being asleep is expected, not an error worth retrying
            // aggressively. Succeed quietly and try again next period.
            return Result.success()
        }

        val latest = briefs.firstOrNull() ?: return Result.success()
        val lastSeen = ctx.dataStore.data.first()[Prefs.LAST_BRIEF]
        if (latest.id == lastSeen) return Result.success()

        notify(latest)
        ctx.dataStore.edit { it[Prefs.LAST_BRIEF] = latest.id }
        return Result.success()
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
            .setSmallIcon(android.R.drawable.ic_dialog_info)
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
