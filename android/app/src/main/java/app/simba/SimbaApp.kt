package app.simba

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.flow.first
import java.util.concurrent.TimeUnit

val Context.dataStore by preferencesDataStore("simba")

object Prefs {
    val GATEWAY = stringPreferencesKey("gateway")
    val TOKEN = stringPreferencesKey("token")
    val LAST_BRIEF = stringPreferencesKey("last_brief")
    /** Newest event already notified, so a poll never repeats one. */
    val LAST_EVENT = stringPreferencesKey("last_event")
    val DESIGN = stringPreferencesKey("design")
}

const val BRIEF_CHANNEL = "simba_briefs"
const val ACTIVITY_CHANNEL = "simba_activity"

class SimbaApp : Application() {

    override fun onCreate() {
        super.onCreate()
        createChannels()
        scheduleBriefPolling()
    }

    private fun createChannels() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                BRIEF_CHANNEL,
                "Agent briefs",
                // Default rather than high: a brief is a status update, not an
                // alarm. Anything that genuinely needs a decision is called out
                // inside the notification text instead of by escalating every
                // routine update to a buzz.
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "Periodic summaries of what your agents are doing"
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(
                ACTIVITY_CHANNEL,
                "Progress",
                // Low by default: most of these are things finishing, which is
                // good news you can read later. The ones that are not — a
                // mission blocked, a brain gone — raise their own priority.
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Missions finishing or blocking, skills learned, brains running out"
            },
        )
    }

    /**
     * WorkManager rather than a foreground service or FCM.
     *
     * The gateway is on a home PC behind a tunnel, so there is no push
     * infrastructure to deliver from — polling is the honest mechanism. Fifteen
     * minutes is WorkManager's floor for periodic work, and it matches the
     * cadence briefs are generated at closely enough.
     */
    private fun scheduleBriefPolling() {
        val work = PeriodicWorkRequestBuilder<BriefWorker>(15, TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
            )
            .build()

        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "simba-briefs",
            ExistingPeriodicWorkPolicy.KEEP,
            work,
        )
    }
}

suspend fun Context.gatewayUrl(): String =
    dataStore.data.first()[Prefs.GATEWAY] ?: BuildConfig.DEFAULT_GATEWAY

// Credentials live in Keystore-backed storage, not DataStore. Only the URL —
// which is not a secret — stays in plain preferences.
fun Context.gatewayToken(): String = Secrets.gatewayToken(this)

fun Context.accessClientId(): String = Secrets.accessClientId(this)

fun Context.accessClientSecret(): String = Secrets.accessClientSecret(this)

/** Builds a client with everything it needs, so the three call sites cannot drift. */
suspend fun Context.api(): SimbaApi =
    SimbaApi(gatewayUrl(), gatewayToken(), accessClientId(), accessClientSecret())

suspend fun Context.saveGateway(
    url: String,
    token: String,
    clientId: String,
    clientSecret: String,
) {
    dataStore.edit { it[Prefs.GATEWAY] = url.trim() }
    Secrets.save(this, clientId, clientSecret, token)
}
