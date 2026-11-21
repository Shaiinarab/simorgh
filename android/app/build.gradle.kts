plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "ai.simorgh.app"
    compileSdk = 37
    // Pin to the installed build-tools; AGP's default may not be present and the SDK
    // download endpoint is unreachable from this machine.
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "ai.simorgh.app"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "0.1"
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.11.01"))
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
