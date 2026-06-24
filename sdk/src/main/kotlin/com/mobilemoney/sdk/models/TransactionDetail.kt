package com.mobilemoney.sdk.models

data class TransactionDetail(
    val id: String,
    val referenceNumber: String,
    val type: String,
    val status: String,
    val amount: Double,
    val provider: String,
    val phoneNumber: String,
    val stellarAddress: String,
    val notes: String? = null,
    val metadata: Map<String, Any?>? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
)
