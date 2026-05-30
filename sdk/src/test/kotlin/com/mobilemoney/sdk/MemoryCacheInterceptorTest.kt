package com.mobilemoney.sdk

import com.mobilemoney.sdk.cache.MemoryCacheInterceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.Test
import kotlin.test.assertEquals

class MemoryCacheInterceptorTest {
    @Test
    fun `test caching`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("{\"status\":\"ok\"}").addHeader("Content-Type", "application/json"))
        server.enqueue(MockResponse().setBody("{\"status\":\"not_cached\"}").addHeader("Content-Type", "application/json"))
        server.start()

        val client = OkHttpClient.Builder()
            .addInterceptor(MemoryCacheInterceptor())
            .build()

        val request = Request.Builder().url(server.url("/test")).build()

        // First call - should go to server
        val response1 = client.newCall(request).execute()
        assertEquals("{\"status\":\"ok\"}", response1.body?.string())
        assertEquals(1, server.requestCount)

        // Second call - should be cached
        val response2 = client.newCall(request).execute()
        assertEquals("{\"status\":\"ok\"}", response2.body?.string())
        assertEquals(1, server.requestCount) // Still 1

        server.shutdown()
    }

    @Test
    fun `test cache bypass with request cache control`() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("{\"status\":\"ok\"}").addHeader("Content-Type", "application/json"))
        server.enqueue(MockResponse().setBody("{\"status\":\"fresh\"}").addHeader("Content-Type", "application/json"))
        server.start()

        val client = OkHttpClient.Builder()
            .addInterceptor(MemoryCacheInterceptor())
            .build()

        val request1 = Request.Builder().url(server.url("/test-bypass")).build()
        val response1 = client.newCall(request1).execute()
        assertEquals("{\"status\":\"ok\"}", response1.body?.string())

        // Request with Cache-Control: no-cache
        val request2 = Request.Builder()
            .url(server.url("/test-bypass"))
            .header("Cache-Control", "no-cache")
            .build()
        val response2 = client.newCall(request2).execute()
        assertEquals("{\"status\":\"fresh\"}", response2.body?.string())
        assertEquals(2, server.requestCount)

        server.shutdown()
    }

    @Test
    fun `test no cache store with response cache control`() {
        val server = MockWebServer()
        server.enqueue(
            MockResponse()
                .setBody("{\"status\":\"no-store\"}")
                .addHeader("Content-Type", "application/json")
                .addHeader("Cache-Control", "no-store")
        )
        server.enqueue(
            MockResponse()
                .setBody("{\"status\":\"fresh\"}")
                .addHeader("Content-Type", "application/json")
        )
        server.start()

        val client = OkHttpClient.Builder()
            .addInterceptor(MemoryCacheInterceptor())
            .build()

        val request = Request.Builder().url(server.url("/test-no-store")).build()
        val response1 = client.newCall(request).execute()
        assertEquals("{\"status\":\"no-store\"}", response1.body?.string())

        // Second call should NOT be cached because of no-store response header
        val response2 = client.newCall(request).execute()
        assertEquals("{\"status\":\"fresh\"}", response2.body?.string())
        assertEquals(2, server.requestCount)

        server.shutdown()
    }
}
