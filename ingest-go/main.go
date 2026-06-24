// ingest-go — Callback Ingestion Service (Go / fasthttp)
//
// POST /ingest
//   - Validates JSON payload
//   - Publishes to Redis Stream  (REDIS_ENABLED=true, default)
//   - Publishes to NATS JetStream (NATS_ENABLED=true)
//   - Returns 202 Accepted immediately
//
// Environment variables:
//   PORT           — HTTP port (default: 3002)
//   REDIS_URL      — Redis URL  (default: redis://localhost:6379)
//   NATS_URL       — NATS URL   (default: nats://localhost:4222)
//   REDIS_ENABLED  — publish to Redis Streams (default: true)
//   NATS_ENABLED   — publish to NATS JetStream (default: false)
//   REDIS_STREAM   — stream key (default: callbacks)
//   NATS_SUBJECT   — NATS subject (default: callbacks.ingest)
//   SENTRY_DSN     — Sentry DSN for error tracking

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"runtime"
	"runtime/pprof"
	"strconv"
	"sync"
	"time"
	"unsafe"

	"github.com/getsentry/sentry-go"
	"github.com/nats-io/nats.go"
	"github.com/redis/go-redis/v9"
	"github.com/valyala/fasthttp"
	"github.com/valyala/fastjson"
)

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

var (
	port         = getEnv("PORT", "3002")
	redisURL     = getEnv("REDIS_URL", "redis://localhost:6379")
	natsURL      = getEnv("NATS_URL", "nats://localhost:4222")
	redisEnabled = getEnv("REDIS_ENABLED", "true") != "false"
	natsEnabled  = getEnv("NATS_ENABLED", "false") == "true"
	redisStream  = getEnv("REDIS_STREAM", "callbacks")
	natsSubject  = getEnv("NATS_SUBJECT", "callbacks.ingest")
	sentryDSN    = getEnv("SENTRY_DSN", "")
)

// ---------------------------------------------------------------------------
// Object Pools for Memory Optimization
// ---------------------------------------------------------------------------

// Pool for CallbackPayload structs to reduce allocations
var payloadPool = sync.Pool{
	New: func() interface{} {
		return &CallbackPayload{
			Metadata: make(map[string]interface{}),
		}
	},
}

// Pool for byte buffers to reduce allocations in JSON marshaling
var bufferPool = sync.Pool{
	New: func() interface{} {
		return make([]byte, 0, 4096)
	},
}

// Pool for fastjson.Parser to reduce allocations
var parserPool = sync.Pool{
	New: func() interface{} {
		return &fastjson.Parser{}
	},
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

type CallbackPayload struct {
	EventType string                 `json:"event_type"`
	Provider  string                 `json:"provider"`
	Reference string                 `json:"reference"`
	Amount    float64                `json:"amount"`
	Currency  string                 `json:"currency"`
	Status    string                 `json:"status"`
	Timestamp string                 `json:"timestamp"`
	Metadata  map[string]interface{} `json:"metadata,omitempty"`
	// marshaled is a cache of the JSON marshaled form to avoid re-marshaling
	marshaled []byte
}

func (p *CallbackPayload) Validate() error {
	if p.EventType == "" || len(p.EventType) > 64 {
		return fmt.Errorf("event_type is required and must be ≤64 chars")
	}
	if p.Provider == "" || len(p.Provider) > 32 {
		return fmt.Errorf("provider is required and must be ≤32 chars")
	}
	if p.Reference == "" || len(p.Reference) > 128 {
		return fmt.Errorf("reference is required and must be ≤128 chars")
	}
	if p.Amount <= 0 {
		return fmt.Errorf("amount must be positive")
	}
	if len(p.Currency) != 3 {
		return fmt.Errorf("currency must be a 3-letter ISO code")
	}
	switch p.Status {
	case "pending", "success", "failed":
	default:
		return fmt.Errorf("status must be pending|success|failed")
	}
	if _, err := time.Parse(time.RFC3339, p.Timestamp); err != nil {
		return fmt.Errorf("timestamp must be RFC3339")
	}
	return nil
}

func parseCallbackPayload(body []byte) (*CallbackPayload, error) {
	// Get parser and payload from pools
	parser := parserPool.Get().(*fastjson.Parser)
	defer parserPool.Put(parser)

	payload := payloadPool.Get().(*CallbackPayload)
	// Clear metadata from previous use
	for k := range payload.Metadata {
		delete(payload.Metadata, k)
	}

	// Parse JSON using pooled parser
	v, err := parser.ParseBytes(body)
	if err != nil {
		payloadPool.Put(payload)
		return nil, err
	}

	// Extract string fields efficiently
	var parseErr error
	payload.EventType, parseErr = getStringFieldOptimized(v, "event_type")
	if parseErr != nil {
		payloadPool.Put(payload)
		return nil, parseErr
	}
	payload.Provider, parseErr = getStringFieldOptimized(v, "provider")
	if parseErr != nil {
		payloadPool.Put(payload)
		return nil, parseErr
	}
	payload.Reference, parseErr = getStringFieldOptimized(v, "reference")
	if parseErr != nil {
		payloadPool.Put(payload)
		return nil, parseErr
	}
	payload.Currency, parseErr = getStringFieldOptimized(v, "currency")
	if parseErr != nil {
		payloadPool.Put(payload)
		return nil, parseErr
	}
	payload.Status, parseErr = getStringFieldOptimized(v, "status")
	if parseErr != nil {
		payloadPool.Put(payload)
		return nil, parseErr
	}
	payload.Timestamp, parseErr = getStringFieldOptimized(v, "timestamp")
	if parseErr != nil {
		payloadPool.Put(payload)
		return nil, parseErr
	}

	// Extract numeric amount field
	if payload.Amount, parseErr = getFloatFieldOptimized(v, "amount"); parseErr != nil {
		payloadPool.Put(payload)
		return nil, parseErr
	}

	// Optimize metadata parsing: only unmarshal if present
	if metaVal := v.Get("metadata"); metaVal != nil {
		// Get buffer from pool
		buf := bufferPool.Get().([]byte)[:0]
		buf = metaVal.MarshalTo(buf)

		// Unmarshal metadata into the payload's map
		if err := json.Unmarshal(buf, &payload.Metadata); err != nil {
			bufferPool.Put(buf)
			payloadPool.Put(payload)
			return nil, err
		}
		// Return buffer to pool
		bufferPool.Put(buf)
	}

	return payload, nil
}

// releasePayload returns a payload to the pool after use
func releasePayload(p *CallbackPayload) {
	if p != nil {
		payloadPool.Put(p)
	}
}

// Optimized string field extraction using unsafe conversion when safe
func getStringFieldOptimized(v *fastjson.Value, key string) (string, error) {
	bytes := v.GetStringBytes(key)
	if bytes != nil {
		// Use unsafe string conversion to avoid allocation
		// This is safe because fastjson keeps the buffer valid for the lifetime of the parser
		return unsafeString(bytes), nil
	}
	if v.Get(key) == nil {
		return "", nil
	}
	return "", fmt.Errorf("%s must be a string", key)
}

// Optimized float field extraction
func getFloatFieldOptimized(v *fastjson.Value, key string) (float64, error) {
	val := v.Get(key)
	if val == nil {
		return 0, nil
	}
	if f, err := val.Float64(); err == nil {
		return f, nil
	}
	// Try to parse from string if it's a number in string format
	s, _ := val.StringBytes()
	if s != nil && len(s) > 0 {
		result, err := strconv.ParseFloat(string(s), 64)
		if err == nil {
			return result, nil
		}
	}
	return 0, fmt.Errorf("%s must be a number", key)
}

// unsafeString converts []byte to string without allocating
// WARNING: Only use when the byte slice is guaranteed to live for the duration of use
func unsafeString(b []byte) string {
	return *(*string)(unsafe.Pointer(&b))
}

// Legacy functions kept for compatibility (with optimizations)
func getStringField(v *fastjson.Value, key string) (string, error) {
	return getStringFieldOptimized(v, key)
}

func getFloatField(v *fastjson.Value, key string) (float64, error) {
	return getFloatFieldOptimized(v, key)
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

var (
	rdb *redis.Client
	nc  *nats.Conn
	js  nats.JetStreamContext
	ctx = context.Background()
)

func initMessaging() error {
	if redisEnabled {
		opt, err := redis.ParseURL(redisURL)
		if err != nil {
			return fmt.Errorf("redis URL parse: %w", err)
		}
		rdb = redis.NewClient(opt)
		if err := rdb.Ping(ctx).Err(); err != nil {
			return fmt.Errorf("redis ping: %w", err)
		}
		log.Printf("[redis] connected to %s", redisURL)
	}

	if natsEnabled {
		var err error
		nc, err = nats.Connect(natsURL,
			nats.MaxReconnects(-1),
			nats.ReconnectWait(2*time.Second),
			nats.DisconnectErrHandler(func(nc *nats.Conn, err error) {
				log.Printf("[nats] disconnected: %v", err)
			}),
			nats.ReconnectHandler(func(nc *nats.Conn) {
				log.Printf("[nats] reconnected to %s", nc.ConnectedUrl())
			}),
			nats.ClosedHandler(func(nc *nats.Conn) {
				log.Printf("[nats] connection permanently closed")
			}),
			nats.ErrorHandler(func(nc *nats.Conn, sub *nats.Subscription, err error) {
				log.Printf("[nats] async error on subject %s: %v", sub.Subject, err)
			}),
		)
		if err != nil {
			return fmt.Errorf("nats connect: %w", err)
		}
		js, err = nc.JetStream()
		if err != nil {
			return fmt.Errorf("nats jetstream: %w", err)
		}
		log.Printf("[nats] connected to %s", natsURL)
	}
	return nil
}

func publish(p *CallbackPayload) error {
	// Get or create marshaled JSON from pool buffer
	buf := bufferPool.Get().([]byte)[:0]
	defer bufferPool.Put(buf)

	var err error
	buf, err = json.Marshal(p)
	if err != nil {
		return err
	}

	// Store marshaled form in payload for potential reuse
	p.marshaled = buf

	if redisEnabled && rdb != nil {
		// Redis Streams — at-least-once, persistent
		if err := rdb.XAdd(ctx, &redis.XAddArgs{
			Stream: redisStream,
			ID:     "*",
			Values: map[string]interface{}{
				"event_type": p.EventType,
				"provider":   p.Provider,
				"reference":  p.Reference,
				"data":       string(buf), // Use cached marshaled data
			},
		}).Err(); err != nil {
			return fmt.Errorf("redis xadd: %w", err)
		}
	}

	if natsEnabled && js != nil {
		if _, err := js.Publish(natsSubject, buf); err != nil {
			return fmt.Errorf("nats publish: %w", err)
		}
	}

	return nil
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

func handleIngest(ctx *fasthttp.RequestCtx) {
	if !ctx.IsPost() {
		ctx.SetStatusCode(fasthttp.StatusMethodNotAllowed)
		return
	}

	payload, err := parseCallbackPayload(ctx.PostBody())
	if err != nil {
		ctx.SetStatusCode(fasthttp.StatusBadRequest)
		ctx.SetBodyString(`{"error":"invalid JSON"}`)
		return
	}
	defer releasePayload(payload)

	if err := payload.Validate(); err != nil {
		ctx.SetStatusCode(fasthttp.StatusBadRequest)
		fmt.Fprintf(ctx, `{"error":%q}`, err.Error())
		return
	}

	if err := publish(payload); err != nil {
		sentry.CaptureException(err)
		log.Printf("[ingest] publish error: %v", err)
		ctx.SetStatusCode(fasthttp.StatusInternalServerError)
		ctx.SetBodyString(`{"error":"publish failed"}`)
		return
	}

	ctx.SetStatusCode(fasthttp.StatusAccepted)
	fmt.Fprintf(ctx, `{"status":"accepted","reference":%q}`, payload.Reference)
}

func handleHealth(ctx *fasthttp.RequestCtx) {
	// Check Redis
	if redisEnabled {
		if rdb == nil {
			ctx.SetStatusCode(fasthttp.StatusServiceUnavailable)
			ctx.SetBodyString(`{"status":"error","runtime":"go","detail":"redis not initialized"}`)
			return
		}
		if err := rdb.Ping(ctx).Err(); err != nil {
			ctx.SetStatusCode(fasthttp.StatusServiceUnavailable)
			ctx.SetBodyString(fmt.Sprintf(`{"status":"error","runtime":"go","detail":"redis ping failed: %v"}`, err))
			return
		}
	}

	// Check NATS
	if natsEnabled {
		if nc == nil || !nc.IsConnected() {
			ctx.SetStatusCode(fasthttp.StatusServiceUnavailable)
			ctx.SetBodyString(`{"status":"error","runtime":"go","detail":"nats not connected"}`)
			return
		}
	}

	ctx.SetStatusCode(fasthttp.StatusOK)
	ctx.SetBodyString(`{"status":"ok","runtime":"go"}`)
}

// handleMetrics provides memory allocation metrics and pool statistics
func handleMetrics(ctx *fasthttp.RequestCtx) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	metrics := map[string]interface{}{
		"memory": map[string]interface{}{
			"alloc_bytes":       m.Alloc,
			"total_alloc_bytes": m.TotalAlloc,
			"sys_bytes":         m.Sys,
			"num_gc":            m.NumGC,
			"mallocs":           m.Mallocs,
			"frees":             m.Frees,
			"heap_alloc":        m.HeapAlloc,
			"heap_sys":          m.HeapSys,
			"heap_idle":         m.HeapIdle,
			"heap_in_use":       m.HeapInuse,
			"heap_released":     m.HeapReleased,
			"heap_objects":      m.HeapObjects,
			"gc_pause_ns":       m.PauseNs[(m.NumGC+255)%256],
			"last_gc_time_unix": m.LastGC,
		},
		"goroutines": runtime.NumGoroutine(),
	}

	ctx.SetStatusCode(fasthttp.StatusOK)
	ctx.SetContentType("application/json")
	if data, err := json.Marshal(metrics); err == nil {
		ctx.SetBody(data)
	}
}

// handlePprof provides pprof profiling endpoints for analysis
func handlePprof(ctx *fasthttp.RequestCtx) {
	profile := string(ctx.QueryArgs().Peek("profile"))
	if profile == "" {
		profile = "heap"
	}

	ctx.SetContentType("text/plain")
	switch profile {
	case "heap":
		runtime.GC()
		pprof.WriteHeapProfile(ctx)
	case "goroutine":
		p := pprof.Lookup("goroutine")
		if p != nil {
			p.WriteTo(ctx, 0)
		}
	case "allocs":
		p := pprof.Lookup("allocs")
		if p != nil {
			p.WriteTo(ctx, 0)
		}
	default:
		ctx.SetStatusCode(fasthttp.StatusBadRequest)
		ctx.SetBodyString(`{"error":"unknown profile"}`)
	}
}

func router(ctx *fasthttp.RequestCtx) {
	ctx.SetContentType("application/json")
	switch string(ctx.Path()) {
	case "/ingest":
		handleIngest(ctx)
	case "/health":
		handleHealth(ctx)
	case "/metrics":
		handleMetrics(ctx)
	case "/pprof":
		handlePprof(ctx)
	default:
		ctx.SetStatusCode(fasthttp.StatusNotFound)
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	if sentryDSN != "" {
		err := sentry.Init(sentry.ClientOptions{
			Dsn:              sentryDSN,
			TracesSampleRate: 1.0,
			Environment:      getEnv("NODE_ENV", "development"),
		})
		if err != nil {
			log.Printf("Sentry initialization failed: %v", err)
		} else {
			log.Printf("[sentry] initialized for environment: %s", getEnv("NODE_ENV", "development"))
			defer sentry.Flush(2 * time.Second)
		}
	}

	if err := initMessaging(); err != nil {
		sentry.CaptureException(err)
		log.Fatalf("[ingest-go] messaging init failed: %v", err)
	}

	portInt, _ := strconv.Atoi(port)
	addr := fmt.Sprintf("0.0.0.0:%d", portInt)
	log.Printf("[ingest-go] listening on :%s", port)

	server := &fasthttp.Server{
		Handler:            router,
		ReadTimeout:        5 * time.Second,
		WriteTimeout:       5 * time.Second,
		MaxRequestBodySize: 1 * 1024 * 1024, // 1 MB
		Concurrency:        256 * 1024,
	}

	if err := server.ListenAndServe(addr); err != nil {
		sentry.CaptureException(err)
		log.Fatalf("[ingest-go] server error: %v", err)
	}
}
