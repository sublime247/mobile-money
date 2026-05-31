# ADR-001 — Callback Ingestion Service Tech Stack

| Field    | Value                |
| -------- | -------------------- |
| Status   | Accepted             |
| Date     | 2026-04-23           |
| Authors  | Platform Engineering |
| Replaces | —                    |

---

## Context

The mobile-money platform receives payment callbacks from mobile money providers (MTN, Airtel, Orange) at high volume. The current ingestion path is a Node.js Express handler that validates the payload and writes to a PostgreSQL queue table. Under load testing this path shows:

- Event loop saturation above ~9k req/s
- P99 latency spikes to 97ms at 10k req/s target
- 0.41% error rate at peak (dropped callbacks = lost revenue)
- High memory growth under sustained load (198 MB RSS)

The next-gen core must handle **10,000 req/s sustained** with P99 < 20ms and zero dropped callbacks. We need to choose:

1. The **runtime** for the ingestion microservice (Node.js vs Go vs Rust)
2. The **message bus** for fan-out to downstream consumers (Redis Streams vs NATS JetStream)

---

## Decision

**Runtime: Go (fasthttp)**  
**Message bus: Redis Streams**

---

## Alternatives Considered

### Runtime

#### Option A — Node.js (Fastify) — Current baseline

- **Pros:** Existing team expertise, shared codebase, fast iteration
- **Cons:** Single-threaded event loop; saturates at ~9.2k req/s; P99 97ms at 10k; 198 MB RSS; 0.41% error rate at target load
- **Verdict:** Does not meet the 10k req/s requirement reliably

#### Option B — Go (fasthttp) ✅ Selected

- **Pros:** Goroutine-per-request concurrency; sustains 10k req/s with P99 < 10ms; 24 MB RSS (8× less than Node); 0% errors at target; simple deployment (single static binary); strong stdlib for HTTP and JSON
- **Cons:** Separate codebase from main Node.js service; team needs Go familiarity
- **Verdict:** Meets all requirements with significant headroom

#### Option C — Rust (Axum / Actix-web)

- **Pros:** Lowest possible latency and memory; zero-cost abstractions; no GC pauses
- **Cons:** Steep learning curve; longer development cycle; async ecosystem complexity; marginal gains over Go for this use case (I/O-bound workload, not CPU-bound)
- **Verdict:** Overkill for an I/O-bound ingestion service; Go provides 95% of the benefit at 30% of the complexity cost

### Message Bus

#### Option A — Redis Streams ✅ Selected

- **Publish P50:** 0.4ms | **P99:** 1.2ms
- **Durability:** AOF + RDB persistence; survives restarts
- **Delivery:** At-least-once via consumer group XACK
- **Ops complexity:** Low — Redis already in the stack (sessions, locks, APQ cache)
- **Consumer groups:** Multiple downstream services can consume independently
- **Verdict:** Best fit — lowest latency, simplest ops, already operated

#### Option B — NATS JetStream

- **Publish P50:** 0.6ms | **P99:** 2.1ms
- **Durability:** File-based store; configurable retention
- **Delivery:** At-least-once (ack) and exactly-once (dedup window)
- **Ops complexity:** Medium — new infrastructure component to operate
- **Verdict:** Strong alternative; preferred if exactly-once semantics become a hard requirement. Revisit in ADR-002 if idempotency issues arise with Redis Streams.

---

## Benchmark Results

> Full methodology: `benchmarks/k6-bench.js` | Hardware: 8-core AMD EPYC, 16 GB RAM  
> Duration: 30s per run | Payload: ~280 bytes JSON

### Throughput & Latency

| Service | RPS Target | Actual RPS | P50 (ms) | P95 (ms) | P99 (ms) | Error Rate | RSS Memory |
| ------- | ---------- | ---------- | -------- | -------- | -------- | ---------- | ---------- |
| Node.js | 1,000      | 998        | 3.2      | 8.1      | 14.3     | 0.00%      | 68 MB      |
| Node.js | 5,000      | 4,971      | 5.8      | 18.4     | 34.7     | 0.02%      | 112 MB     |
| Node.js | 10,000     | 9,203      | 12.1     | 48.6     | 97.2     | **0.41%**  | 198 MB     |
| Go      | 1,000      | 1,000      | 1.1      | 2.8      | 4.9      | 0.00%      | 18 MB      |
| Go      | 5,000      | 5,000      | 1.4      | 3.9      | 7.1      | 0.00%      | 21 MB      |
| Go      | 10,000     | **10,000** | **1.8**  | **5.2**  | **9.8**  | **0.00%**  | **24 MB**  |

### CPU at 10k req/s

| Service | Avg CPU | Peak CPU |
| ------- | ------- | -------- |
| Node.js | 78%     | 94%      |
| Go      | 31%     | 48%      |

### Message Bus at 10k req/s (Go service)

| Broker         | Publish P50 | Publish P99 | At-least-once | Ops Complexity |
| -------------- | ----------- | ----------- | ------------- | -------------- |
| Redis Streams  | 0.4 ms      | 1.2 ms      | Yes (XACK)    | Low            |
| NATS JetStream | 0.6 ms      | 2.1 ms      | Yes (Ack)     | Medium         |

---

## Consequences

### Accepted tradeoffs

- **Polyglot codebase:** The ingestion service is Go; the rest of the platform is Node.js. Mitigated by keeping the Go service minimal (single responsibility: validate → publish).
- **Team ramp-up:** Engineers need basic Go familiarity. Mitigated by the simplicity of the service (~200 LOC) and Go's readable syntax.
- **Redis as critical path:** Redis Streams is now on the hot path for every callback. Mitigated by Redis Sentinel/Cluster for HA and the existing Redis operational runbook.

### Benefits gained

- **10k req/s sustained** with P99 < 10ms — 10× latency improvement over Node.js at peak
- **8× lower memory** — enables higher density deployment
- **Zero dropped callbacks** at target load — directly protects revenue
- **No new infrastructure** — Redis is already operated

### Future considerations

- If exactly-once delivery becomes a hard requirement, migrate the message bus to NATS JetStream (ADR-002).
- If throughput requirements exceed 50k req/s, evaluate Rust (Axum) at that point.
- The Node.js service (`ingest-node/`) is retained as a reference implementation and fallback.

---

## Implementation Notes

- Prototypes: `ingest-node/` (Node.js/Fastify) and `ingest-go/` (Go/fasthttp)
- Benchmark scripts: `benchmarks/k6-bench.js`, `benchmarks/run-bench.sh`
- Both prototypes implement identical validation logic and publish to the same Redis stream key (`callbacks`) for fair comparison
- Channel naming: `XADD callbacks * event_type <type> provider <p> reference <ref> data <json>`
- Consumer services read via `XREADGROUP` with `XACK` for at-least-once delivery
