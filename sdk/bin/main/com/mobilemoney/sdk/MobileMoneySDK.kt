package com.mobilemoney.sdk

import com.mobilemoney.sdk.auth.AuthInterceptor
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import com.mobilemoney.sdk.api.TransactionsApi
import com.mobilemoney.sdk.models.TransactionRequest
import com.mobilemoney.sdk.models.TransactionResponse

/**
 * High-level SDK for Mobile Money integration.
 * Enables integration in < 5 lines of code.
 */
class MobileMoneySDK(
    private val baseUrl: String,
    private val authToken: String
) {
    private val okHttpClient = OkHttpClient.Builder()
        .addInterceptor(AuthInterceptor(authToken))
        .build()

    private val retrofit = Retrofit.Builder()
        .baseUrl(baseUrl)
        .client(okHttpClient)
        .addConverterFactory(GsonConverterFactory.create())
        .build()

    private val api = retrofit.create(TransactionsApi::class.java)

    /**
     * Send a deposit in a single call.
     */
    suspend fun deposit(
        amount: Double,
        phoneNumber: String,
        provider: String,
        stellarAddress: String,
        userId: String,
        notes: String? = null
    ): TransactionResponse {
        val request = TransactionRequest(
            amount = amount,
            phoneNumber = phoneNumber,
            provider = TransactionRequest.Provider.valueOf(provider.uppercase()),
            stellarAddress = stellarAddress,
            userId = userId,
            notes = notes
        )
        return api.deposit(request)
    }

    /**
     * Get transaction status.
     */
    suspend fun getStatus(transactionId: String) = api.getTransaction(transactionId)
}
