import java.text.SimpleDateFormat
import java.util.Date

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.operator.simba"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.operator.simba"
        minSdk = 26
        targetSdk = 34
        // Minutes since 2024-01-01, so every build is a higher number than the
        // last one without anyone remembering to bump it.
        //
        // This was pinned at 1 for every APK ever published here, which is why
        // reinstalling appeared to do nothing: Android compares versionCode
        // against the installed app, sees no increase, and declines to treat it
        // as an upgrade. The download had been succeeding all along - the
        // install was the no-op, and from the outside those look identical.
        //
        // Minutes rather than seconds because versionCode is a signed 32-bit
        // int; seconds since 1970 would already be 1.7 billion and leave almost
        // no headroom, while this is around 1.1 million and lasts millennia.
        versionCode = (
            (System.currentTimeMillis() - 1704067200000L) / 60000L
        ).toInt()
        versionName = "0.1." + (
            (System.currentTimeMillis() - 1704067200000L) / 60000L
        ).toInt()

        // A visible build stamp, so "did the new APK actually install" is a
        // question the phone can answer. Without it an update that failed to
        // download is indistinguishable from one that installed and changed
        // nothing, which is exactly the confusion this is fixing.
        buildConfigField(
            "String",
            "BUILD_STAMP",
            // SimpleDateFormat rather than java.time: the Kotlin DSL script
            // classpath does not expose java.time here.
            "\"" + SimpleDateFormat("MMM d HH:mm").format(Date()) + "\"",
        )
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            // The gateway is reached over a Cloudflare tunnel in normal use, but
            // a debug build on the same LAN talks to it directly over http.
            // Overridable without editing code so a rebuild is not needed to
            // point the app somewhere else.
            buildConfigField(
                "String",
                "DEFAULT_GATEWAY",
                "\"${project.findProperty("simba.gateway") ?: "http://10.0.2.2:8787"}\"",
            )
        }
        release {
            isMinifyEnabled = false
            // Release points at the tunnel over HTTPS. The emulator alias is a
            // debug-only convenience and must not be the default on a build
            // that ships to the phone.
            buildConfigField(
                "String",
                "DEFAULT_GATEWAY",
                "\"${project.findProperty("simba.gateway") ?: "https://simba.plaximus.com"}\"",
            )
            // Signed with the debug key on purpose: this is a personal
            // sideloaded app, never a Play Store artifact, and a release build
            // that cannot be installed is useless.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions { jvmTarget = "17" }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }

    /**
     * Screenshots without a device.
     *
     * The emulator on this machine crashes on startup, and even when one works
     * it is a slow way to answer the only question that matters here — does
     * every screen look right in all three designs. Robolectric renders the real
     * Compose tree on the JVM, so the whole matrix is a `gradlew test` away and
     * stays checked rather than being looked at once.
     *
     * `isIncludeAndroidResources` is what makes it render at all: without it the
     * theme, the drawables and the launcher icon are absent and every screenshot
     * comes out unstyled.
     */
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all {
                it.systemProperty("robolectric.graphicsMode", "NATIVE")
                // Left alone, the test JVM takes a quarter of physical RAM as its
                // ceiling and then fails to reserve it on a machine also running
                // the gateway, an IDE and a browser — the suite died with a JVM
                // crash rather than a test result, which reads as a broken build.
                it.maxHeapSize = "2g"
            }
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.navigation:navigation-compose:2.8.4")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // Background polling for briefs so notifications arrive without the app
    // being open.
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // Keystore-backed storage for the Access service token. It authenticates to
    // a gateway that can start agents with a full shell, so it does not belong
    // in plaintext preferences.
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.compose.ui:ui-tooling-preview")

    // Rendering the UI on the JVM. See testOptions above for why.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
