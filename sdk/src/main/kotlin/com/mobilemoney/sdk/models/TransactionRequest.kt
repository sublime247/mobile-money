package com.mobilemoney.sdk.models

data class TransactionRequest(
    val amount: Double,
    val phoneNumber: String,
    val provider: Provider,
    val stellarAddress: String,
    val userId: String,
    val notes: String? = null
) {
    enum class Provider {
        MTN, AIRTEL, ORANGE
    }
}
