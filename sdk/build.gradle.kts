import org.gradle.api.publish.maven.MavenPublication

plugins {
    kotlin("jvm") version "1.9.22"
    `maven-publish`
    signing
    `java-library`
}

group = "com.mobilemoney"
// Version is overridden at publish time via -Pversion=<tag> passed by CI.
// The fallback here is used for local builds only.
version = project.findProperty("version")?.toString()?.trimStart('v') ?: "1.0.0"

repositories {
    mavenCentral()
}

dependencies {
    implementation("com.squareup.retrofit2:retrofit:2.9.0")
    implementation("com.squareup.retrofit2:converter-gson:2.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")
    testImplementation(kotlin("test"))
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}

kotlin {
    jvmToolchain(17)
}

// ── Sources & Javadoc JARs (required by Maven Central) ──────────────────────

java {
    withSourcesJar()
    withJavadocJar()
}

// ── Maven Central publishing ─────────────────────────────────────────────────

publishing {
    publications {
        create<MavenPublication>("mavenKotlin") {
            from(components["java"])

            groupId    = "com.mobilemoney"
            artifactId = "mobile-money-sdk"
            version    = project.version.toString()

            pom {
                name.set("Mobile Money SDK")
                description.set("Kotlin/JVM client SDK for the Mobile Money ↔ Stellar Bridge API")
                url.set("https://github.com/sublime247/mobile-money")

                licenses {
                    license {
                        name.set("MIT License")
                        url.set("https://opensource.org/licenses/MIT")
                    }
                }

                developers {
                    developer {
                        id.set("sublime247")
                        name.set("Mobile Money Maintainers")
                        email.set("maintainers@mobilemoney.dev")
                    }
                }

                scm {
                    connection.set("scm:git:git://github.com/sublime247/mobile-money.git")
                    developerConnection.set("scm:git:ssh://github.com/sublime247/mobile-money.git")
                    url.set("https://github.com/sublime247/mobile-money")
                }
            }
        }
    }

    repositories {
        // Sonatype OSSRH — publishes to Maven Central via the Central Portal.
        // Credentials are injected by CI via ORG_GRADLE_PROJECT_* env vars.
        maven {
            name = "sonatype"
            val isSnapshot = version.toString().endsWith("SNAPSHOT")
            url = uri(
                if (isSnapshot)
                    "https://s01.oss.sonatype.org/content/repositories/snapshots/"
                else
                    "https://s01.oss.sonatype.org/service/local/staging/deploy/maven2/"
            )
            credentials {
                username = project.findProperty("sonatypeUsername") as String?
                    ?: System.getenv("SONATYPE_USERNAME")
                password = project.findProperty("sonatypePassword") as String?
                    ?: System.getenv("SONATYPE_PASSWORD")
            }
        }
    }
}

// ── GPG signing (required by Maven Central) ──────────────────────────────────
// The signing key and passphrase are injected by CI via environment variables:
//   ORG_GRADLE_PROJECT_signingKey        — ASCII-armored private key
//   ORG_GRADLE_PROJECT_signingPassword   — passphrase

signing {
    val signingKey     = project.findProperty("signingKey")     as String?
    val signingPassword = project.findProperty("signingPassword") as String?

    if (!signingKey.isNullOrBlank() && !signingPassword.isNullOrBlank()) {
        useInMemoryPgpKeys(signingKey, signingPassword)
        sign(publishing.publications["mavenKotlin"])
    } else {
        logger.warn("SDK: GPG signing credentials not found — artifacts will NOT be signed. Set signingKey and signingPassword for Maven Central publishing.")
    }
}
