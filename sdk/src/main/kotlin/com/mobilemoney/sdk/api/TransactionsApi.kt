package com.mobilemoney.sdk.api

import com.mobilemoney.sdk.models.TransactionRequest
import com.mobilemoney.sdk.models.TransactionResponse
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path

interface TransactionsApi {
    @POST("v1/transactions/deposit")
    suspend fun deposit(@Body request: TransactionRequest): TransactionResponse

    @POST("v1/transactions/withdraw")
    suspend fun withdraw(@Body request: TransactionRequest): TransactionResponse

    @GET("v1/transactions/{id}")
    suspend fun getTransaction(@Path("id") transactionId: String): TransactionResponse
}
