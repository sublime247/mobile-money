package com.mobilemoney.sdk.auth

import okhttp3.Interceptor
import okhttp3.Response

class AuthInterceptor(private val authToken: String) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val originalRequest = chain.request()
        
        // Skip auth if already present or not needed (optional logic)
        if (originalRequest.header("Authorization") != null) {
            return chain.proceed(originalRequest)
        }

        val requestWithAuth = originalRequest.newBuilder()
            .header("Authorization", "Bearer $authToken")
            .build()
            
        return chain.proceed(requestWithAuth)
    }
}
