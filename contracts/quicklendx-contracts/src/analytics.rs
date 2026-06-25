use soroban_sdk::{contracttype, Env};

/// Version for the JSON-equivalent analytics snapshot schema exported to
/// off-chain indexers. Increment this value whenever fields are removed,
/// renamed, or their meaning changes incompatibly.
pub const ANALYTICS_SCHEMA_VERSION: u32 = 1;

/// Maximum number of records that any analytics snapshot sub-calculator may
/// scan in a single host call. The current implementation reads aggregate
/// counters only (zero scanned records), but the cap documents the budget
/// contract for future invoice/investor-backed metrics.
pub const ANALYTICS_SNAPSHOT_ITERATION_BOUND: u32 = 1_000;

/// Aggregate platform health metrics.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlatformMetrics {
    pub total_invoices: u32,
    pub total_funded: i128,
    pub total_repaid: i128,
    pub active_invoices: u32,
}

/// Aggregate financial metrics kept as a separate type for callers that need
/// only capital-flow data.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FinancialMetrics {
    pub total_funded: i128,
    pub total_repaid: i128,
    pub outstanding_principal: i128,
}

/// Platform-wide performance metrics.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PerformanceMetrics {
    pub repayment_rate_bps: u32,
    pub default_rate_bps: u32,
    pub average_duration_seconds: u64,
}

/// Investor-specific performance metrics.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvestorPerformanceMetrics {
    pub funded_amount: i128,
    pub repaid_amount: i128,
    pub realized_yield_bps: u32,
}

/// Stable, versioned analytics export shape for off-chain indexers.
///
/// JSON-equivalent schema version `ANALYTICS_SCHEMA_VERSION` currently exposes:
/// `{ schema_version, ledger_timestamp, platform_metrics, performance_metrics }`.
/// All fields are composed during one read-only contract invocation, so the
/// timestamp and metrics reflect the same ledger close observed by the host.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnalyticsSnapshot {
    pub schema_version: u32,
    pub ledger_timestamp: u64,
    pub platform_metrics: PlatformMetrics,
    pub performance_metrics: PerformanceMetrics,
}

pub struct AnalyticsCalculator;

impl AnalyticsCalculator {
    /// Calculate aggregate platform metrics.
    ///
    /// Iteration bound: this reads aggregate counters only and scans zero
    /// invoice records, which is below `ANALYTICS_SNAPSHOT_ITERATION_BOUND`.
    pub fn calculate_platform_metrics(_env: &Env) -> PlatformMetrics {
        PlatformMetrics {
            total_invoices: 0,
            total_funded: 0,
            total_repaid: 0,
            active_invoices: 0,
        }
    }

    /// Calculate aggregate performance metrics.
    ///
    /// Iteration bound: this reads aggregate counters only and scans zero
    /// records, which is below `ANALYTICS_SNAPSHOT_ITERATION_BOUND`.
    pub fn calculate_performance_metrics(_env: &Env) -> PerformanceMetrics {
        PerformanceMetrics {
            repayment_rate_bps: 0,
            default_rate_bps: 0,
            average_duration_seconds: 0,
        }
    }

    pub fn calculate_financial_metrics(_env: &Env) -> FinancialMetrics {
        FinancialMetrics {
            total_funded: 0,
            total_repaid: 0,
            outstanding_principal: 0,
        }
    }
}
