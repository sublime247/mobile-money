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
	"strconv"
	"time"

	"github.com/getsentry/sentry-go"
	"github.com/nats-io/nats.go"
	"github.com/redis/go-redis/v9"
	"github.com/valyala/fastjson"
	"github.com/valyala/fasthttp"
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
	var payload CallbackPayload
	v, err := fastjson.ParseBytes(body)
	if err != nil {
		return nil, err
	}

	payload.EventType, err = getStringField(v, "event_type")
	if err != nil {
		return nil, err
	}
	payload.Provider, err = getStringField(v, "provider")
	if err != nil {
		return nil, err
	}
	payload.Reference, err = getStringField(v, "reference")
	if err != nil {
		return nil, err
	}
	payload.Currency, err = getStringField(v, "currency")
	if err != nil {
		return nil, err
	}
	payload.Status, err = getStringField(v, "status")
	if err != nil {
		return nil, err
	}
	payload.Timestamp, err = getStringField(v, "timestamp")
	if err != nil {
		return nil, err
	}

	if payload.Amount, err = getFloatField(v, "amount"); err != nil {
		return nil, err
	}

	if metaVal := v.Get("metadata"); metaVal != nil {
		buf, err := metaVal.MarshalTo(nil)
		if err != nil {
			return nil, err
		}
		var metadata map[string]interface{}
		if err := json.Unmarshal(buf, &metadata); err != nil {
			return nil, err
		}
		payload.Metadata = metadata
	}

	return &payload, nil
}

func getStringField(v *fastjson.Value, key string) (string, error) {
	if bytes, err := v.GetStringBytes(key); err == nil {
		return string(bytes), nil
	} else if v.Get(key) == nil {
		return "", nil
	} else {
		return "", fmt.Errorf("%s must be a string", key)
	}
}

func getFloatField(v *fastjson.Value, key string) (float64, error) {
	val := v.Get(key)
	if val == nil {
		return 0, nil
	}
	if f, err := val.Float64(); err == nil {
		return f, nil
	}
	if s, err := val.StringBytes(); err == nil {
		return strconv.ParseFloat(string(s), 64)
	}
	return 0, fmt.Errorf("%s must be a number", key)
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
	data, err := json.Marshal(p)
	if err != nil {
		return err
	}

	if redisEnabled && rdb != nil {
		// Redis Streams — at-least-once, persistent
		if err := rdb.XAdd(ctx, &redis.XAddArgs{
			Stream: redisStream,
			ID:     "*",
			Values: map[string]interface{}{
				"event_type": p.EventType,
				"provider":   p.Provider,
				"reference":  p.Reference,
				"data":       string(data),
			},
		}).Err(); err != nil {
			return fmt.Errorf("redis xadd: %w", err)
		}
	}

	if natsEnabled && js != nil {
		if _, err := js.Publish(natsSubject, data); err != nil {
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

	if err := payload.Validate(); err != nil {
		ctx.SetStatusCode(fasthttp.StatusBadRequest)
		fmt.Fprintf(ctx, `{"error":%q}`, err.Error())
		return
	}

	if err := publish(&payload); err != nil {
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

func router(ctx *fasthttp.RequestCtx) {
	ctx.SetContentType("application/json")
	switch string(ctx.Path()) {
	case "/ingest":
		handleIngest(ctx)
	case "/health":
		handleHealth(ctx)
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
