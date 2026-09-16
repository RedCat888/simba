package app.simba

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Keystore-backed storage for the Access service token.
 *
 * The token authenticates to a gateway that can start agents holding a full
 * shell on the PC — it is closer to an SSH key than to an app setting, and it
 * was previously sitting in plaintext DataStore where anything with filesystem
 * access on a rooted or backed-up device could read it.
 *
 * EncryptedSharedPreferences wraps the values with a key held in the Android
 * Keystore, which is hardware-backed on the S24. Combined with
 * `allowBackup="false"` in the manifest, the token does not leave the device.
 */
object Secrets {

    private const val FILE = "simba_secrets"
    private const val K_CLIENT_ID = "cf_access_client_id"
    private const val K_CLIENT_SECRET = "cf_access_client_secret"
    private const val K_TOKEN = "gateway_token"

    @Volatile private var cached: SharedPreferences? = null

    private fun prefs(ctx: Context): SharedPreferences =
        cached ?: synchronized(this) {
            cached ?: run {
                val key = MasterKey.Builder(ctx)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build()
                EncryptedSharedPreferences.create(
                    ctx,
                    FILE,
                    key,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
                ).also { cached = it }
            }
        }

    fun accessClientId(ctx: Context): String = prefs(ctx).getString(K_CLIENT_ID, "") ?: ""

    fun accessClientSecret(ctx: Context): String = prefs(ctx).getString(K_CLIENT_SECRET, "") ?: ""

    fun gatewayToken(ctx: Context): String = prefs(ctx).getString(K_TOKEN, "") ?: ""

    fun save(ctx: Context, clientId: String, clientSecret: String, token: String) {
        prefs(ctx).edit()
            .putString(K_CLIENT_ID, clientId.trim())
            .putString(K_CLIENT_SECRET, clientSecret.trim())
            .putString(K_TOKEN, token.trim())
            .apply()
    }

    /**
     * Has this install ever been set up?
     *
     * A fresh install and a sleeping PC produce the same symptom — nothing
     * loads — and the app was telling both of them the same thing: "the PC may
     * be asleep, or the tunnel is down". That is useless advice to someone who
     * has simply never entered their credentials, and it is the very first
     * screen they see.
     *
     * The two are trivially distinguishable, which is why the guess was
     * inexcusable rather than merely unhelpful.
     */
    fun configured(ctx: Context): Boolean =
        accessClientId(ctx).isNotBlank() && accessClientSecret(ctx).isNotBlank()

    /** Used by the "lost phone" path and after a revocation. */
    fun clear(ctx: Context) {
        prefs(ctx).edit().clear().apply()
    }
}
