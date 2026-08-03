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
        versionCode = 1
        versionName = "0.1.0"
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
}
