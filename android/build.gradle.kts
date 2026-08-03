// Versions pinned to a combination known to work together. AGP and Kotlin both
// gate on the Gradle version, and a mismatch surfaces as an opaque plugin
// resolution error rather than anything that names the real problem.
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.21" apply false
}
