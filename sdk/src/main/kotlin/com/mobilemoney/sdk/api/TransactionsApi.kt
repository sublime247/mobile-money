package com.mobilemoney.sdk.api

import com.mobilemoney.sdk.models.TransactionDetail
import com.mobilemoney.sdk.models.TransactionListResponse
import com.mobilemoney.sdk.models.TransactionRequest
import com.mobilemoney.sdk.models.TransactionResponse
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

interface TransactionsApi {
    @POST("api/v1/transactions/deposit")
    suspend fun deposit(@Body request: TransactionRequest): TransactionResponse

    @POST("api/v1/transactions/withdraw")
    suspend fun withdraw(@Body request: TransactionRequest): TransactionResponse

    @GET("api/v1/transactions")
    suspend fun listTransactions(
        @Query("limit") limit: Int? = null,
        @Query("offset") offset: Int? = null
    ): TransactionListResponse

    @GET("api/v1/transactions/{id}")
    suspend fun getTransaction(@Path("id") transactionId: String): TransactionDetail

    @POST("api/v1/transactions/{id}/cancel")
    suspend fun cancelTransaction(@Path("id") transactionId: String): TransactionResponse
}
