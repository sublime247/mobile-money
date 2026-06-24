#![no_std]

pub mod analytics;

use analytics::{
    AnalyticsCalculator, AnalyticsSnapshot, PerformanceMetrics, PlatformMetrics,
    ANALYTICS_SCHEMA_VERSION,
};
use soroban_sdk::{contract, contractimpl, Env};

#[contract]
pub struct QuickLendXContract;

#[contractimpl]
impl QuickLendXContract {
    pub fn calculate_platform_metrics(env: Env) -> PlatformMetrics {
        AnalyticsCalculator::calculate_platform_metrics(&env)
    }

    pub fn calculate_performance_metrics(env: Env) -> PerformanceMetrics {
        AnalyticsCalculator::calculate_performance_metrics(&env)
    }

    /// Export a stable, JSON-shaped analytics snapshot for off-chain indexers.
    ///
    /// The `schema_version` is pinned to `ANALYTICS_SCHEMA_VERSION`; indexers
    /// should reject or explicitly migrate when this value changes. The snapshot
    /// is read-only, requires no authorization, performs no storage writes, and
    /// composes platform plus performance metrics in one host call so all fields
    /// are observed at the same ledger close. Internal analytics iteration is
    /// capped by `ANALYTICS_SNAPSHOT_ITERATION_BOUND` documented in
    /// `analytics.rs`; the current aggregate-counter implementation scans zero
    /// records.
    pub fn export_analytics_snapshot(env: Env) -> AnalyticsSnapshot {
        let ledger_timestamp = env.ledger().timestamp();
        let platform_metrics = AnalyticsCalculator::calculate_platform_metrics(&env);
        let performance_metrics = AnalyticsCalculator::calculate_performance_metrics(&env);

        AnalyticsSnapshot {
            schema_version: ANALYTICS_SCHEMA_VERSION,
            ledger_timestamp,
            platform_metrics,
            performance_metrics,
        }
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use crate::analytics::{AnalyticsCalculator, ANALYTICS_SCHEMA_VERSION};
    use soroban_sdk::{testutils::Ledger, Env};

    #[test]
    fn test_analytics_consistency() {
        let env = Env::default();
        env.ledger().with_mut(|li| li.timestamp = 1_717_171_717);

        let snapshot = QuickLendXContract::export_analytics_snapshot(env.clone());

        assert_eq!(snapshot.schema_version, ANALYTICS_SCHEMA_VERSION);
        assert_eq!(snapshot.ledger_timestamp, 1_717_171_717);
        assert_eq!(
            snapshot.platform_metrics,
            AnalyticsCalculator::calculate_platform_metrics(&env)
        );
        assert_eq!(
            snapshot.performance_metrics,
            AnalyticsCalculator::calculate_performance_metrics(&env)
        );
    }

    #[test]
    fn test_empty_platform_snapshot_is_zeroed() {
        let env = Env::default();
        let snapshot = QuickLendXContract::export_analytics_snapshot(env);

        assert_eq!(snapshot.platform_metrics.total_invoices, 0);
        assert_eq!(snapshot.platform_metrics.total_funded, 0);
        assert_eq!(snapshot.platform_metrics.total_repaid, 0);
        assert_eq!(snapshot.platform_metrics.active_invoices, 0);
        assert_eq!(snapshot.performance_metrics.repayment_rate_bps, 0);
        assert_eq!(snapshot.performance_metrics.default_rate_bps, 0);
    }

    #[test]
    fn test_snapshot_version_stability() {
        assert_eq!(ANALYTICS_SCHEMA_VERSION, 1);
    }
}
