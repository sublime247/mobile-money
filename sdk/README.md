# Mobile Money Kotlin SDK

This SDK allows mobile developers to integrate mobile money payments with ease.

## Installation (Gradle)

```kotlin
dependencies {
    implementation("com.mobilemoney:mobile-money-sdk:1.0.0")
}
```

## Quick Start

```kotlin
// 1. Initialize
val sdk = MobileMoneySDK("https://api.yourdomain.com", "YOUR_JWT_TOKEN")

// 2. Send Deposit (Under 5 lines!)
val response = sdk.deposit(5000.0, "+237670000000", "mtn", "GABC...", "user123")

// 3. Check Status
val status = sdk.getStatus(response.transactionId)
```

## Features

- Automatic Auth Injection (JWT Bearer)
- Retrofit2 + Coroutines support
- Native Android compatibility
- Production-grade error handling
