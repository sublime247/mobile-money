# Soroban Smart Contract Gas Consumption Report

**Date:** 2026-06-23  
**Cost Model:** Soroban Protocol 20  
**Tool:** soroban-gas-bench v1.0.0  

---

## escrow Contract

| Method | CPU Instructions | Memory (bytes) | Storage Reads | Storage Writes | Token Transfers | Auth Checks |
|--------|-----------------|----------------|---------------|----------------|-----------------|-------------|
| initialize | 82,800 | 2,832 | 0 | 1 | 1 | 1 |
| release | 131,200 | 4,624 | 1 | 1 | 2 | 1 |
| refund | 86,100 | 3,592 | 1 | 1 | 1 | 1 |
| emergency_refund | 79,900 | 3,168 | 1 | 1 | 1 | 1 |
| self_refund | 82,300 | 3,544 | 1 | 1 | 1 | 1 |
| get_state | 11,500 | 688 | 1 | 0 | 0 | 0 |
| **TOTAL** | **473,800** | **18,448** | | | | |

## htlc Contract

| Method | CPU Instructions | Memory (bytes) | Storage Reads | Storage Writes | Token Transfers | Auth Checks |
|--------|-----------------|----------------|---------------|----------------|-----------------|-------------|
| initialize | 81,750 | 2,784 | 0 | 1 | 1 | 1 |
| claim | 85,150 | 3,424 | 1 | 1 | 1 | 0 |
| refund | 75,650 | 2,984 | 1 | 1 | 1 | 0 |
| get_state | 11,500 | 688 | 1 | 0 | 0 | 0 |
| **TOTAL** | **254,050** | **9,880** | | | | |

---

> **Note:** Gas estimates are derived from static source analysis using Soroban's documented
> cost model constants. Actual on-chain gas may vary based on runtime state, data sizes,
> and network conditions. For precise figures, compile with `cargo` and run the Rust
> benchmark tool (`benchmarks/src/main.rs`) against testutils.
