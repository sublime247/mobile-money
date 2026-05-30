package com.mobilemoney.sdk.models

data class TransactionResponse(
    val transactionId: String,
    val referenceNumber: String? = null,
    val status: String,
    val jobId: String? = null
)
