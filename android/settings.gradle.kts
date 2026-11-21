pluginManagement {
    repositories {
        // Google's own endpoint is unreachable from this machine; the Aliyun mirror serves the same artifacts.
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven { url = uri("https://maven.aliyun.com/repository/google") }
        mavenCentral()
    }
}

rootProject.name = "simorgh-android"
include(":app")
