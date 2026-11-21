package ai.simorgh.app.ui

import ai.simorgh.app.ApiException
import ai.simorgh.app.SettingsStore
import ai.simorgh.app.SimorghClient
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

data class ChatEntry(val mine: Boolean, val text: String, val meta: String? = null)

@Composable
fun SimorghApp(client: SimorghClient, settings: SettingsStore) {
    var tab by remember { mutableIntStateOf(0) }
    Scaffold(
        topBar = {
            TabRow(selectedTabIndex = tab) {
                listOf("Agent", "Status", "Config").forEachIndexed { index, label ->
                    Tab(selected = tab == index, onClick = { tab = index }, text = { Text(label) })
                }
            }
        }
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            when (tab) {
                0 -> ChatScreen(client, settings, Modifier.weight(1f))
                1 -> StatusScreen(client, Modifier.weight(1f))
                2 -> ConfigScreen(settings, client, Modifier.weight(1f))
            }
        }
    }
}

@Composable
fun ChatScreen(client: SimorghClient, settings: SettingsStore, modifier: Modifier = Modifier) {
    var messages by remember { mutableStateOf(listOf<ChatEntry>()) }
    var input by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Column(modifier.fillMaxSize().padding(16.dp)) {
        LazyColumn(Modifier.weight(1f)) {
            items(messages) { entry ->
                Card(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Column(Modifier.padding(12.dp)) {
                        Text(
                            if (entry.mine) "You" else "Simorgh",
                            style = MaterialTheme.typography.labelSmall,
                        )
                        // The core already runs an output shield; render as text, never as HTML.
                        Text(entry.text)
                        if (!entry.meta.isNullOrBlank()) {
                            Text(entry.meta, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        OutlinedTextField(
            value = input,
            onValueChange = { input = it },
            label = { Text("Prompt") },
            modifier = Modifier.fillMaxWidth(),
            enabled = !busy,
        )
        Button(
            onClick = {
                val prompt = input.trim()
                if (prompt.isEmpty() || busy) return@Button
                input = ""
                busy = true
                error = null
                messages = messages + ChatEntry(true, prompt)
                scope.launch {
                    try {
                        val result = client.execute(prompt, settings.load().userId.ifBlank { null })
                        val meta = listOfNotNull(result.provider, result.requestId, result.contextRefId)
                            .joinToString(" · ")
                        messages = messages + ChatEntry(false, result.text, meta.ifBlank { null })
                    } catch (e: Exception) {
                        error = friendly(e)
                    } finally {
                        busy = false
                    }
                }
            },
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (busy) "Flying…" else "Send") }
    }
}

@Composable
fun StatusScreen(client: SimorghClient, modifier: Modifier = Modifier) {
    var output by remember { mutableStateOf("Not probed yet.") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(modifier.fillMaxSize().padding(16.dp)) {
        Button(
            onClick = {
                if (busy) return@Button
                busy = true
                scope.launch {
                    output = try {
                        "HEALTH\n${client.health()}\n\nFLOCK\n${client.flockStatus()}"
                    } catch (e: Exception) {
                        friendly(e)
                    } finally {
                        busy = false
                    }
                }
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (busy) "Probing…" else "Probe core") }
        Text(output, modifier = Modifier.padding(top = 12.dp))
    }
}

@Composable
fun ConfigScreen(settings: SettingsStore, client: SimorghClient, modifier: Modifier = Modifier) {
    var config by remember { mutableStateOf(settings.load()) }
    var note by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    Column(modifier.fillMaxSize().padding(16.dp)) {
        OutlinedTextField(
            value = config.baseUrl,
            onValueChange = { config = config.copy(baseUrl = it) },
            label = { Text("Base URL") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = config.apiKey,
            onValueChange = { config = config.copy(apiKey = it) },
            label = { Text("Bearer token") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
        )
        OutlinedTextField(
            value = config.userId,
            onValueChange = { config = config.copy(userId = it) },
            label = { Text("userId claim (optional)") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Button(
            onClick = { settings.save(config); note = "Saved locally." },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Save") }
        Button(
            onClick = {
                settings.save(config)
                note = "Testing…"
                scope.launch {
                    note = try {
                        "OK: ${client.health()}"
                    } catch (e: Exception) {
                        friendly(e)
                    }
                }
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Save & test connection") }
        Text(note, modifier = Modifier.padding(top = 12.dp))
    }
}

private fun friendly(error: Throwable): String = when (error) {
    is ApiException -> when (error.code) {
        "UNAUTHORIZED" -> "Check the API key in Config."
        "FORBIDDEN" -> "The userId claim does not match the token's principal."
        "RATE_LIMITED" -> "Rate limited. Wait and try again."
        "AUTH_NOT_CONFIGURED" -> "The core has no auth configured."
        "IDENTITY_UNRESOLVED" -> "A per-user read needs a mapped token."
        else -> "${error.code}: ${error.message}"
    }
    else -> error.message ?: "Request failed."
}
