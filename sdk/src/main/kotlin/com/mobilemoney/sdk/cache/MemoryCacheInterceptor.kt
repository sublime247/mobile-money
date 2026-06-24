package com.mobilemoney.sdk.cache

import okhttp3.Interceptor
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import java.util.concurrent.ConcurrentHashMap

class MemoryCacheInterceptor : Interceptor {
    private val cache = ConcurrentHashMap<String, CachedResponse>()

    data class CachedResponse(val body: String, val contentType: String?)

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.method != "GET") {
            return chain.proceed(request)
        }

        // Respect request Cache-Control: no-cache / no-store
        val requestCacheControl = request.cacheControl
        val bypassCache = requestCacheControl.noCache || requestCacheControl.noStore

        val url = request.url.toString()
        if (!bypassCache) {
            val cached = cache[url]
            if (cached != null) {
                return Response.Builder()
                    .request(request)
                    .protocol(okhttp3.Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body(cached.body.toResponseBody(cached.contentType?.toMediaTypeOrNull()))
                    .build()
            }
        }

        val response = try {
            chain.proceed(request)
        } catch (e: java.io.IOException) {
            val cached = cache[url]
            if (cached != null) {
                Response.Builder()
                    .request(request)
                    .protocol(okhttp3.Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body(cached.body.toResponseBody(cached.contentType?.toMediaTypeOrNull()))
                    .build()
            } else {
                throw e
            }
        }
        
        // Respect response Cache-Control: no-store
        val responseCacheControl = response.cacheControl
        if (response.isSuccessful && response.body != null && !responseCacheControl.noStore) {
            val responseBodyString = response.body!!.string()
            val contentType = response.body!!.contentType()?.toString()
            
            // Only store in cache if request doesn't forbid it
            if (!requestCacheControl.noStore) {
                cache[url] = CachedResponse(responseBodyString, contentType)
            }
            
            return response.newBuilder()
                .body(responseBodyString.toResponseBody(response.body!!.contentType()))
                .build()
        }
        return response
    }
}
