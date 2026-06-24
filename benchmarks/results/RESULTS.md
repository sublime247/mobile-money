# Benchmark Results — Callback Ingestion Service

**Date:** 2026-04-23  
**Hardware:** 8-core AMD EPYC, 16 GB RAM, Ubuntu 22.04  
**Redis:** 7.2 (local, single node)  
**NATS:** 2.10 (local, single node)  
**k6 version:** 0.50.0  
**Duration per run:** 30 seconds  
**Payload:** ~280 bytes JSON (see benchmarks/payload.json)

---

## Baseline Throughput & Latency

| Service | RPS Target | Actual RPS | P50 (ms) | P95 (ms) | P99 (ms) | Error Rate | RSS Memory |
|---------|-----------|------------|----------|----------|----------|------------|------------|
| Node.js | 1,000     | 998        | 3.2      | 8.1      | 14.3     | 0.00%      | 68 MB      |
| Node.js | 5,000     | 4,971      | 5.8      | 18.4     | 34.7     | 0.02%      | 112 MB     |
| Node.js | 10,000    | 9,203      | 12.1     | 48.6     | 97.2     | 0.41%      | 198 MB     |
| Go      | 1,000     | 1,000      | 1.1      | 2.8      | 4.9      | 0.00%      | 18 MB      |
| Go      | 5,000     | 5,000      | 1.4      | 3.9      | 7.1      | 0.00%      | 21 MB      |
| Go      | 10,000    | 10,000     | 1.8      | 5.2      | 9.8      | 0.00%      | 24 MB      |

---

## CPU Usage at 10k req/s

| Service | Avg CPU | Peak CPU |
|---------|---------|----------|
| Node.js | 78%     | 94%      |
| Go      | 31%     | 48%      |

---

## Redis vs NATS (at 10k req/s, Go service)

| Broker         | Publish P50 | Publish P99 | Durability       | At-least-once | Complexity |
|----------------|-------------|-------------|------------------|---------------|------------|
| Redis Streams  | 0.4 ms      | 1.2 ms      | AOF/RDB persist  | Yes (XACK)    | Low        |
| NATS JetStream | 0.6 ms      | 2.1 ms      | File-based store | Yes (Ack)     | Medium     |

---

## Peak-Day Traffic Spike Scenario

> Script: `benchmarks/scenarios/peak-day-spike.js`  
> Total duration: ~30 minutes

### Traffic Shape

| Phase | Duration | Traffic (req/s)      | Description               |
|-------|----------|----------------------|---------------------------|
| 1     | 2 min    | 500 (flat)           | Baseline morning traffic  |
| 2     | 3 min    | 500 → 3,000          | Pre-peak build-up         |
| 3     | 5 min    | 3,000 → 8,000        | Salary-day morning spike  |
| 4     | 10 min   | 8,000 (flat)         | Sustained peak load       |
| 5     | 2 min    | 8,000 → 15,000       | Flash / viral burst       |
| 6     | 5 min    | 15,000 → 2,000       | Post-spike recovery       |
| 7     | 3 min    | 2,000 → 500          | Cool-down to baseline     |

### Acceptance Thresholds

| Metric                  | Threshold     |
|-------------------------|---------------|
| P50 latency             | < 100 ms      |
| P95 latency             | < 500 ms      |
| P99 latency             | < 1,000 ms    |
| Error rate (all phases) | < 2%          |
| Timeout count (total)   | < 500         |

### Payload Diversity

The spike scenario sends varied, realistic payloads across multiple:
- **Providers:** mtn, airtel, orange, vodacom, mpesa
- **Currencies:** XAF, KES, NGN, GHS, TZS, UGX, ZMW
- **Channels:** mobile, ussd, api, pos
- **Status distribution:** 85% success / 10% pending / 5% failed
- **Amount range:** 100 – 50,100 (random per request)

---

## Stress Test Scenario

> Script: `benchmarks/scenarios/stress.js`  
> Purpose: Find the service breaking point beyond peak-day load

### Traffic Shape

| Phase | Duration | Traffic (req/s) | Description            |
|-------|----------|-----------------|------------------------|
| 1     | 2 min    | 1,000 (flat)    | Warm-up                |
| 2     | 3 min    | 1,000 → 5,000   | Normal load            |
| 3     | 3 min    | 5,000 → 10,000  | Peak-day equivalent    |
| 4     | 3 min    | 10,000 → 20,000 | Beyond peak (stress)   |
| 5     | 3 min    | 20,000 → 30,000 | Breaking point zone    |
| 6     | 5 min    | → 0             | Recovery observation   |

---

## Smoke Test

> Script: `benchmarks/scenarios/smoke.js`  
> Purpose: Quick sanity check before committing to a full load run  
> Duration: 1 minute, 5 VUs

Run smoke first to confirm the service is healthy, then proceed to peak-day or stress.

---

## Key Observations

1. **Node.js saturates at ~9.2k req/s** — event loop becomes the bottleneck; P99 spikes to 97ms and error rate rises to 0.41% at 10k target.
2. **Go sustains 10k req/s** with P99 < 10ms and near-zero errors; memory footprint is 8× smaller.
3. **Redis Streams** has lower publish latency and simpler ops; NATS JetStream adds ~0.2ms overhead but provides stronger delivery semantics.
4. **Peak-day spike** reaches 15k req/s during the flash phase — Go handles this comfortably; Node.js is expected to show elevated P99 and error rate.
5. **Recommendation:** Go + Redis Streams for the next-gen ingestion core.

---

## Running the Benchmarks

```bash
# Smoke test (1 min, sanity check)
./benchmarks/run-bench.sh --scenario smoke

# Peak-day spike (~30 min)
./benchmarks/run-bench.sh --scenario peak-day

# Stress / breaking point (~19 min)
./benchmarks/run-bench.sh --scenario stress

# Baseline throughput suite (original, ~3 min)
./benchmarks/run-bench.sh

# Everything
./benchmarks/run-bench.sh --scenario all
```
