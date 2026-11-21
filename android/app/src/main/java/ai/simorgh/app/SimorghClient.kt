package ai.simorgh.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class ApiException(val code: String, message: String, val status: Int) : Exception(message)

data class ExecuteResult(
    val text: String,
    val provider: String?,
    val requestId: String?,
    val contextRefId: String?,
)

/**
 * One HTTP client for the canonical REST contract (docs/api/CONTRACT.md).
 *
 * Uses java.net.HttpURLConnection and org.json from the platform — no third-party networking
 * dependency. The credential is the only source of identity; `userId` is sent only when the
 * operator explicitly configured a matching claim.
 */
class SimorghClient(private val settings: SettingsStore) {

    suspend fun health(): String = request("GET", "/health", null)

    suspend fun flockStatus(): String = request("GET", "/api/v1/flock/status", null)

    suspend fun execute(prompt: String, claim: String?): ExecuteResult = withContext(Dispatchers.IO) {
        val body = JSONObject().apply {
            put("prompt", prompt)
            put("tier", "Free-Volunteer")
            if (!claim.isNullOrBlank()) put("userId", claim)
        }.toString()
        val json = JSONObject(request("POST", "/api/v1/agent/execute", body))
        val meta = json.optJSONObject("meta")
        ExecuteResult(
            text = json.optString("agentResponse"),
            // The live core names this field `answered_by`; accept `provider` too so a
            // future rename cannot silently blank the provenance line.
            provider = meta?.optString("answered_by")?.takeIf { it.isNotBlank() }
                ?: meta?.optString("provider")?.takeIf { it.isNotBlank() },
            requestId = meta?.optString("requestId")?.takeIf { it.isNotBlank() },
            contextRefId = meta?.optString("contextRefId")?.takeIf { it.isNotBlank() },
        )
    }

    private suspend fun request(method: String, path: String, body: String?): String =
        withContext(Dispatchers.IO) {
            val config = settings.load()
            require(config.baseUrl.isNotBlank()) { "Set a base URL in Config first." }
            val url = URL(config.baseUrl.trim().trimEnd('/') + path)
            val connection = url.openConnection() as HttpURLConnection
            connection.requestMethod = method
            connection.connectTimeout = 10_000
            connection.readTimeout = 30_000
            if (config.apiKey.isNotBlank()) {
                connection.setRequestProperty("Authorization", "Bearer ${config.apiKey.trim()}")
            }
            if (body != null) {
                connection.setRequestProperty("Content-Type", "application/json")
                connection.doOutput = true
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            try {
                val status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
                if (status !in 200..299) {
                    val error = runCatching { JSONObject(text).optJSONObject("error") }.getOrNull()
                    throw ApiException(
                        code = error?.optString("code")?.takeIf { it.isNotBlank() } ?: "HTTP_$status",
                        message = error?.optString("message")?.takeIf { it.isNotBlank() }
                            ?: "Request failed ($status)",
                        status = status,
                    )
                }
                text
            } finally {
                connection.disconnect()
            }
        }
}
