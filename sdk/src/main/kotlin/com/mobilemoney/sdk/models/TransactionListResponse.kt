package com.mobilemoney.sdk.models

data class Pagination(
    val total: Int,
    val limit: Int,
    val offset: Int,
)

data class TransactionListResponse(
    val success: Boolean,
    val data: List<TransactionDetail>,
    val pagination: Pagination,
)
