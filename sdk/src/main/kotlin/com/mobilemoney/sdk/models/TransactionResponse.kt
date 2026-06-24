package com.mobilemoney.sdk.models

data class TransactionResponse(
    val success: Boolean,
    val transactionId: String,
    val referenceNumber: String? = null,
    val status: String,
    val amount: Double? = null,
    val provider: String? = null,
    val createdAt: String? = null
)
