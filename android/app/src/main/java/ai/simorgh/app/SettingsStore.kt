package ai.simorgh.app

import android.content.Context

data class ClientConfig(
    val baseUrl: String,
    val apiKey: String,
    val userId: String,
)

class SettingsStore(context: Context) {
    private val prefs = context.applicationContext
        .getSharedPreferences("simorgh", Context.MODE_PRIVATE)

    fun load(): ClientConfig = ClientConfig(
        baseUrl = prefs.getString(KEY_URL, "").orEmpty(),
        apiKey = prefs.getString(KEY_KEY, "").orEmpty(),
        userId = prefs.getString(KEY_USER, "").orEmpty(),
    )

    fun save(config: ClientConfig) {
        prefs.edit()
            .putString(KEY_URL, config.baseUrl.trim())
            .putString(KEY_KEY, config.apiKey.trim())
            .putString(KEY_USER, config.userId.trim())
            .apply()
    }

    private companion object {
        const val KEY_URL = "baseUrl"
        const val KEY_KEY = "apiKey"
        const val KEY_USER = "userId"
    }
}

// ponytail: app-private SharedPreferences, not the Android Keystore. Fine for a solo operator's
// own device; upgrade to EncryptedSharedPreferences/Keystore before distributing to other people.
