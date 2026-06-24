package main

import (
	"encoding/json"
	"testing"

	"github.com/valyala/fastjson"
)

var testPayload = []byte(`{
  "event_type": "payment_completed",
  "provider": "mtn",
  "reference": "TRX-12345-67890",
  "amount": 1000.50,
  "currency": "GHS",
  "status": "success",
  "timestamp": "2024-06-24T10:30:00Z",
  "metadata": {
    "merchant_id": "MERCH001",
    "customer_id": "CUST5678",
    "session_id": "sess_abc123def456",
    "tracking_id": "track_xyz789",
    "additional_field": "extra_data"
  }
}`)

// BenchmarkParsePayloadWithPooling benchmarks the optimized parser with object pooling
func BenchmarkParsePayloadWithPooling(b *testing.B) {
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		payload, err := parseCallbackPayload(testPayload)
		if err != nil {
			b.Fatalf("failed to parse: %v", err)
		}
		if payload == nil {
			b.Fatal("payload is nil")
		}
		releasePayload(payload)
	}
}

// BenchmarkValidation benchmarks the validation logic
func BenchmarkValidation(b *testing.B) {
	payload, err := parseCallbackPayload(testPayload)
	if err != nil {
		b.Fatalf("failed to parse: %v", err)
	}
	defer releasePayload(payload)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := payload.Validate(); err != nil {
			b.Fatalf("validation failed: %v", err)
		}
	}
}

// BenchmarkJSONMarshaling benchmarks the optimized JSON marshaling
func BenchmarkJSONMarshaling(b *testing.B) {
	payload, err := parseCallbackPayload(testPayload)
	if err != nil {
		b.Fatalf("failed to parse: %v", err)
	}
	defer releasePayload(payload)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		buf := bufferPool.Get().([]byte)[:0]
		if _, err := json.Marshal(payload); err != nil {
			b.Fatalf("marshal failed: %v", err)
		}
		bufferPool.Put(buf)
	}
}

// BenchmarkPooledVsNonPooled compares pooled vs non-pooled allocation
func BenchmarkPooledVsNonPooled(b *testing.B) {
	// Pooled version
	b.Run("pooled", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			payload, _ := parseCallbackPayload(testPayload)
			releasePayload(payload)
		}
	})

	// Non-pooled version for comparison
	b.Run("non-pooled", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			var payload CallbackPayload
			payload.Metadata = make(map[string]interface{})
			v, _ := fastjson.ParseBytes(testPayload)
			payload.EventType, _ = getStringFieldOptimized(v, "event_type")
			payload.Provider, _ = getStringFieldOptimized(v, "provider")
			payload.Reference, _ = getStringFieldOptimized(v, "reference")
			payload.Currency, _ = getStringFieldOptimized(v, "currency")
			payload.Status, _ = getStringFieldOptimized(v, "status")
			payload.Timestamp, _ = getStringFieldOptimized(v, "timestamp")
			payload.Amount, _ = getFloatFieldOptimized(v, "amount")
		}
	})
}

// TestParsePayload tests basic parsing functionality
func TestParsePayload(t *testing.T) {
	payload, err := parseCallbackPayload(testPayload)
	if err != nil {
		t.Fatalf("failed to parse: %v", err)
	}
	defer releasePayload(payload)

	if payload.EventType != "payment_completed" {
		t.Errorf("expected event_type 'payment_completed', got %q", payload.EventType)
	}
	if payload.Provider != "mtn" {
		t.Errorf("expected provider 'mtn', got %q", payload.Provider)
	}
	if payload.Amount != 1000.50 {
		t.Errorf("expected amount 1000.50, got %f", payload.Amount)
	}
	if payload.Currency != "GHS" {
		t.Errorf("expected currency 'GHS', got %q", payload.Currency)
	}
	if len(payload.Metadata) == 0 {
		t.Error("metadata is empty, expected populated metadata")
	}
	if payload.Metadata["merchant_id"] != "MERCH001" {
		t.Errorf("expected merchant_id 'MERCH001', got %v", payload.Metadata["merchant_id"])
	}
}

// TestValidation tests the payload validation
func TestValidation(t *testing.T) {
	payload, err := parseCallbackPayload(testPayload)
	if err != nil {
		t.Fatalf("failed to parse: %v", err)
	}
	defer releasePayload(payload)

	if err := payload.Validate(); err != nil {
		t.Fatalf("validation failed: %v", err)
	}
}

// TestPooling tests that objects are properly pooled
func TestPooling(t *testing.T) {
	// First parse
	payload1, _ := parseCallbackPayload(testPayload)
	ptr1 := payload1

	// Release and reparse to verify reuse
	releasePayload(payload1)
	payload2, _ := parseCallbackPayload(testPayload)
	ptr2 := payload2

	if ptr1 != ptr2 {
		t.Error("expected payload to be reused from pool")
	}

	releasePayload(payload2)
}

// TestInvalidPayload tests error handling
func TestInvalidPayload(t *testing.T) {
	tests := []struct {
		name  string
		data  []byte
		valid bool
	}{
		{
			name:  "invalid json",
			data:  []byte(`{invalid json}`),
			valid: false,
		},
		{
			name:  "missing event_type",
			data:  []byte(`{"provider":"mtn","reference":"ref","amount":100,"currency":"USD","status":"success","timestamp":"2024-06-24T10:30:00Z"}`),
			valid: false,
		},
		{
			name:  "invalid amount",
			data:  []byte(`{"event_type":"test","provider":"mtn","reference":"ref","amount":-100,"currency":"USD","status":"success","timestamp":"2024-06-24T10:30:00Z"}`),
			valid: false,
		},
		{
			name:  "valid payload",
			data:  testPayload,
			valid: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			payload, err := parseCallbackPayload(tt.data)
			if !tt.valid && err == nil {
				t.Error("expected error for invalid payload")
			}
			if tt.valid && err != nil {
				t.Errorf("unexpected error: %v", err)
			}
			if err == nil {
				releasePayload(payload)
			}
		})
	}
}
