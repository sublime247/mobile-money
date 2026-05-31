# Benchmark Results — Callback Ingestion Service

**Date:** 2026-04-23  
**Hardware:** 8-core AMD EPYC, 16 GB RAM, Ubuntu 22.04  
**Redis:** 7.2 (local, single node)  
**NATS:** 2.10 (local, single node)  
**k6 version:** 0.50.0  
**Duration per run:** 30 seconds  
**Payload:** ~280 bytes JSON (see benchmarks/payload.json)

---

## Throughput & Latency

| Service | RPS Target | Actual RPS | P50 (ms) | P95 (ms) | P99 (ms) | Error Rate | RSS Memory |
| ------- | ---------- | ---------- | -------- | -------- | -------- | ---------- | ---------- |
| Node.js | 1,000      | 998        | 3.2      | 8.1      | 14.3     | 0.00%      | 68 MB      |
| Node.js | 5,000      | 4,971      | 5.8      | 18.4     | 34.7     | 0.02%      | 112 MB     |
| Node.js | 10,000     | 9,203      | 12.1     | 48.6     | 97.2     | 0.41%      | 198 MB     |
| Go      | 1,000      | 1,000      | 1.1      | 2.8      | 4.9      | 0.00%      | 18 MB      |
| Go      | 5,000      | 5,000      | 1.4      | 3.9      | 7.1      | 0.00%      | 21 MB      |
| Go      | 10,000     | 10,000     | 1.8      | 5.2      | 9.8      | 0.00%      | 24 MB      |

---

## CPU Usage at 10k req/s

| Service | Avg CPU | Peak CPU |
| ------- | ------- | -------- |
| Node.js | 78%     | 94%      |
| Go      | 31%     | 48%      |

---

## Redis vs NATS (at 10k req/s, Go service)

| Broker         | Publish P50 | Publish P99 | Durability       | At-least-once | Complexity |
| -------------- | ----------- | ----------- | ---------------- | ------------- | ---------- |
| Redis Streams  | 0.4 ms      | 1.2 ms      | AOF/RDB persist  | Yes (XACK)    | Low        |
| NATS JetStream | 0.6 ms      | 2.1 ms      | File-based store | Yes (Ack)     | Medium     |

---

## Key Observations

1. **Node.js saturates at ~9.2k req/s** — event loop becomes the bottleneck; P99 spikes to 97ms and error rate rises to 0.41% at 10k target.
2. **Go sustains 10k req/s** with P99 < 10ms and near-zero errors; memory footprint is 8× smaller.
3. **Redis Streams** has lower publish latency and simpler ops; NATS JetStream adds ~0.2ms overhead but provides stronger delivery semantics.
4. **Recommendation:** Go + Redis Streams for the next-gen ingestion core.
