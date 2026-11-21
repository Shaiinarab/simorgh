plugins {
    // AGP 9.x includes Kotlin itself, but the Compose compiler plugin is still required.
    id("com.android.application") version "9.4.0" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
}
