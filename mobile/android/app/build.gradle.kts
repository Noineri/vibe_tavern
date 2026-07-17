plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseSigningVariables = listOf(
    "ANDROID_KEYSTORE_PATH",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD",
)
val releaseSigning = releaseSigningVariables.associateWith(System::getenv)

android {
    namespace = "com.vibetavern.launcher"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.vibetavern.launcher"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.0.0"

    }

    signingConfigs {
        create("release") {
            storeFile = releaseSigning["ANDROID_KEYSTORE_PATH"]?.takeIf(String::isNotBlank)?.let(::file)
            storePassword = releaseSigning["ANDROID_KEYSTORE_PASSWORD"]
            keyAlias = releaseSigning["ANDROID_KEY_ALIAS"]
            keyPassword = releaseSigning["ANDROID_KEY_PASSWORD"]
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }
}

tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    doFirst {
        val missing = releaseSigningVariables.filter { releaseSigning[it].isNullOrBlank() }
        check(missing.isEmpty()) {
            "Release signing requires environment variables: ${missing.joinToString(", ")}"
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.constraintlayout:constraintlayout:2.2.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
