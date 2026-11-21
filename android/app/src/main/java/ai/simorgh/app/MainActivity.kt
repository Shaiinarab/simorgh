package ai.simorgh.app

import ai.simorgh.app.ui.SimorghApp
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val settings = SettingsStore(this)
        setContent {
            MaterialTheme {
                Surface(Modifier.fillMaxSize()) {
                    SimorghApp(SimorghClient(settings), settings)
                }
            }
        }
    }
}
