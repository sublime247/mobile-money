#![no_std]
#![allow(clippy::too_many_arguments)]

pub mod analytics;

use analytics::{
    AnalyticsCalculator, AnalyticsSnapshot, PerformanceMetrics, PlatformMetrics,
    ANALYTICS_SCHEMA_VERSION,
};
use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, token,
    Address, Env, Map,
};

const BPS_DENOMINATOR: i128 = 10_000;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum QuickLendXError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidAmount = 3,
    InvalidParameter = 4,
    LoanNotFound = 5,
    LoanNotActive = 6,
    StaleOraclePrice = 7,
    InvalidOraclePrice = 8,
    LoanNotLiquidatable = 9,
    Overflow = 10,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum DataKey {
    Config,
    Loans,
    NextLoanId,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct LendingConfig {
    pub admin: Address,
    pub debt_token: Address,
    pub collateral_token: Address,
    pub oracle: Address,
    pub max_price_staleness_seconds: u64,
    pub max_ltv_bps: u32,
    pub liquidation_penalty_bps: u32,
    pub liquidator_reward_bps: u32,
    pub fee_recipient: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OraclePrice {
    pub price: i128,
    pub timestamp: u64,
}

#[contractclient(name = "PriceOracleClient")]
pub trait PriceOracleInterface {
    fn get_price(env: Env, asset: Address) -> OraclePrice;
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LoanStatus {
    Active,
    Closed,
    Liquidated,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Loan {
    pub id: u64,
    pub borrower: Address,
    pub debt_amount: i128,
    pub collateral_amount: i128,
    pub status: LoanStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidationResult {
    pub debt_repaid: i128,
    pub collateral_seized: i128,
    pub penalty: i128,
    pub liquidator_reward: i128,
}

#[contractevent(topics = ["quicklendx", "collateral_liquidated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollateralLiquidated {
    #[topic]
    pub loan_id: u64,
    #[topic]
    pub borrower: Address,
    #[topic]
    pub liquidator: Address,
    pub debt_repaid: i128,
    pub collateral_seized: i128,
    pub penalty: i128,
    pub liquidator_reward: i128,
}

#[contract]
pub struct QuickLendXContract;

#[contractimpl]
impl QuickLendXContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        debt_token: Address,
        collateral_token: Address,
        oracle: Address,
        max_price_staleness_seconds: u64,
        max_ltv_bps: u32,
        liquidation_penalty_bps: u32,
        liquidator_reward_bps: u32,
        fee_recipient: Address,
    ) -> Result<(), QuickLendXError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(QuickLendXError::AlreadyInitialized);
        }
        if max_price_staleness_seconds == 0
            || max_ltv_bps == 0
            || max_ltv_bps > BPS_DENOMINATOR as u32
            || liquidation_penalty_bps > BPS_DENOMINATOR as u32
            || liquidator_reward_bps > BPS_DENOMINATOR as u32
        {
            return Err(QuickLendXError::InvalidParameter);
        }

        admin.require_auth();

        env.storage().instance().set(
            &DataKey::Config,
            &LendingConfig {
                admin,
                debt_token,
                collateral_token,
                oracle,
                max_price_staleness_seconds,
                max_ltv_bps,
                liquidation_penalty_bps,
                liquidator_reward_bps,
                fee_recipient,
            },
        );
        env.storage()
            .instance()
            .set(&DataKey::Loans, &Map::<u64, Loan>::new(&env));
        env.storage().instance().set(&DataKey::NextLoanId, &0u64);
        env.storage().instance().extend_ttl(1000, 10000);

        Ok(())
    }

    pub fn fund_pool(env: Env, funder: Address, amount: i128) -> Result<(), QuickLendXError> {
        if amount <= 0 {
            return Err(QuickLendXError::InvalidAmount);
        }
        let config = Self::load_config(&env)?;

        funder.require_auth();
        token::Client::new(&env, &config.debt_token).transfer(
            &funder,
            env.current_contract_address(),
            &amount,
        );

        Ok(())
    }

    pub fn open_loan(
        env: Env,
        borrower: Address,
        debt_amount: i128,
        collateral_amount: i128,
    ) -> Result<u64, QuickLendXError> {
        if debt_amount <= 0 || collateral_amount <= 0 {
            return Err(QuickLendXError::InvalidAmount);
        }
        let config = Self::load_config(&env)?;

        borrower.require_auth();

        let loan_id = Self::next_loan_id(&env);
        let mut loans = Self::get_loans(&env);
        loans.set(
            loan_id,
            Loan {
                id: loan_id,
                borrower: borrower.clone(),
                debt_amount,
                collateral_amount,
                status: LoanStatus::Active,
            },
        );
        env.storage().instance().set(&DataKey::Loans, &loans);
        env.storage().instance().extend_ttl(1000, 10000);

        let contract_address = env.current_contract_address();
        token::Client::new(&env, &config.collateral_token).transfer(
            &borrower,
            &contract_address,
            &collateral_amount,
        );
        token::Client::new(&env, &config.debt_token).transfer(
            &contract_address,
            &borrower,
            &debt_amount,
        );

        Ok(loan_id)
    }

    pub fn liquidate(
        env: Env,
        loan_id: u64,
        liquidator: Address,
        debt_repayment: i128,
    ) -> Result<LiquidationResult, QuickLendXError> {
        if debt_repayment <= 0 {
            return Err(QuickLendXError::InvalidAmount);
        }
        liquidator.require_auth();

        let config = Self::load_config(&env)?;
        let mut loans = Self::get_loans(&env);
        let mut loan = loans.get(loan_id).ok_or(QuickLendXError::LoanNotFound)?;

        if loan.status != LoanStatus::Active {
            return Err(QuickLendXError::LoanNotActive);
        }

        let oracle_price = Self::fresh_price(&env, &config, &config.collateral_token)?;
        let ltv_bps = Self::ltv_bps(&loan, oracle_price.price)?;
        if ltv_bps < config.max_ltv_bps as i128 {
            return Err(QuickLendXError::LoanNotLiquidatable);
        }

        let debt_repaid = debt_repayment.min(loan.debt_amount);
        let base_collateral = Self::div_ceil(debt_repaid, oracle_price.price)?;
        let requested_penalty = base_collateral
            .checked_mul(config.liquidation_penalty_bps as i128)
            .ok_or(QuickLendXError::Overflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(QuickLendXError::Overflow)?;
        let requested_reward = requested_penalty
            .checked_mul(config.liquidator_reward_bps as i128)
            .ok_or(QuickLendXError::Overflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(QuickLendXError::Overflow)?;

        let requested_seized = base_collateral
            .checked_add(requested_penalty)
            .ok_or(QuickLendXError::Overflow)?;
        let liquidator_collateral = base_collateral
            .checked_add(requested_reward)
            .ok_or(QuickLendXError::Overflow)?
            .min(loan.collateral_amount);
        let collateral_seized = requested_seized.min(loan.collateral_amount);
        let protocol_penalty = collateral_seized.saturating_sub(liquidator_collateral);
        let liquidator_reward = liquidator_collateral.saturating_sub(base_collateral);

        loan.debt_amount = loan
            .debt_amount
            .checked_sub(debt_repaid)
            .ok_or(QuickLendXError::Overflow)?;
        loan.collateral_amount = loan
            .collateral_amount
            .checked_sub(collateral_seized)
            .ok_or(QuickLendXError::Overflow)?;
        if loan.debt_amount == 0 {
            loan.status = LoanStatus::Closed;
        } else if loan.collateral_amount == 0 {
            loan.status = LoanStatus::Liquidated;
        }

        loans.set(loan_id, loan.clone());
        env.storage().instance().set(&DataKey::Loans, &loans);
        env.storage().instance().extend_ttl(1000, 10000);

        let contract_address = env.current_contract_address();
        token::Client::new(&env, &config.debt_token).transfer(
            &liquidator,
            &contract_address,
            &debt_repaid,
        );
        token::Client::new(&env, &config.collateral_token).transfer(
            &contract_address,
            &liquidator,
            &liquidator_collateral,
        );
        if protocol_penalty > 0 {
            token::Client::new(&env, &config.collateral_token).transfer(
                &contract_address,
                &config.fee_recipient,
                &protocol_penalty,
            );
        }

        let result = LiquidationResult {
            debt_repaid,
            collateral_seized,
            penalty: protocol_penalty,
            liquidator_reward,
        };
        CollateralLiquidated {
            loan_id,
            borrower: loan.borrower,
            liquidator,
            debt_repaid,
            collateral_seized,
            penalty: protocol_penalty,
            liquidator_reward,
        }
        .publish(&env);

        Ok(result)
    }

    pub fn get_config(env: Env) -> Result<LendingConfig, QuickLendXError> {
        Self::load_config(&env)
    }

    pub fn get_loan(env: Env, loan_id: u64) -> Result<Loan, QuickLendXError> {
        Self::get_loans(&env)
            .get(loan_id)
            .ok_or(QuickLendXError::LoanNotFound)
    }

    pub fn loan_ltv_bps(env: Env, loan_id: u64) -> Result<i128, QuickLendXError> {
        let config = Self::load_config(&env)?;
        let loan = Self::get_loans(&env)
            .get(loan_id)
            .ok_or(QuickLendXError::LoanNotFound)?;
        let oracle_price = Self::fresh_price(&env, &config, &config.collateral_token)?;
        Self::ltv_bps(&loan, oracle_price.price)
    }

    pub fn is_liquidatable(env: Env, loan_id: u64) -> Result<bool, QuickLendXError> {
        let config = Self::load_config(&env)?;
        let loan = Self::get_loans(&env)
            .get(loan_id)
            .ok_or(QuickLendXError::LoanNotFound)?;
        if loan.status != LoanStatus::Active {
            return Ok(false);
        }
        let oracle_price = Self::fresh_price(&env, &config, &config.collateral_token)?;
        let ltv_bps = Self::ltv_bps(&loan, oracle_price.price)?;
        Ok(ltv_bps >= config.max_ltv_bps as i128)
    }

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

impl QuickLendXContract {
    fn load_config(env: &Env) -> Result<LendingConfig, QuickLendXError> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(QuickLendXError::NotInitialized)
    }

    fn get_loans(env: &Env) -> Map<u64, Loan> {
        env.storage()
            .instance()
            .get(&DataKey::Loans)
            .unwrap_or_else(|| Map::new(env))
    }

    fn next_loan_id(env: &Env) -> u64 {
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextLoanId)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::NextLoanId, &(id + 1));
        id
    }

    fn ltv_bps(loan: &Loan, price: i128) -> Result<i128, QuickLendXError> {
        let collateral_value = loan
            .collateral_amount
            .checked_mul(price)
            .ok_or(QuickLendXError::Overflow)?;
        if collateral_value <= 0 {
            return Ok(i128::MAX);
        }
        loan.debt_amount
            .checked_mul(BPS_DENOMINATOR)
            .ok_or(QuickLendXError::Overflow)?
            .checked_div(collateral_value)
            .ok_or(QuickLendXError::Overflow)
    }

    fn div_ceil(value: i128, divisor: i128) -> Result<i128, QuickLendXError> {
        value
            .checked_add(divisor - 1)
            .ok_or(QuickLendXError::Overflow)?
            .checked_div(divisor)
            .ok_or(QuickLendXError::Overflow)
    }

    fn fresh_price(
        env: &Env,
        config: &LendingConfig,
        asset: &Address,
    ) -> Result<OraclePrice, QuickLendXError> {
        let oracle_price = PriceOracleClient::new(env, &config.oracle).get_price(asset);
        if oracle_price.price <= 0 {
            return Err(QuickLendXError::InvalidOraclePrice);
        }

        let now = env.ledger().timestamp();
        if oracle_price.timestamp > now {
            return Err(QuickLendXError::InvalidOraclePrice);
        }
        if now.saturating_sub(oracle_price.timestamp) > config.max_price_staleness_seconds {
            return Err(QuickLendXError::StaleOraclePrice);
        }

        Ok(oracle_price)
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Events as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Event,
    };

    const START: u64 = 1_000;
    const MAX_STALENESS: u64 = 3_600;
    const MAX_LTV_BPS: u32 = 8_000;
    const LIQUIDATION_PENALTY_BPS: u32 = 1_000;
    const LIQUIDATOR_REWARD_BPS: u32 = 5_000;

    #[contract]
    pub struct MockOracle;

    #[contractimpl]
    impl MockOracle {
        pub fn set_price(env: Env, price: i128, timestamp: u64) {
            env.storage()
                .instance()
                .set(&symbol_short!("PRICE"), &price);
            env.storage()
                .instance()
                .set(&symbol_short!("TS"), &timestamp);
        }

        pub fn get_price(env: Env, _asset: Address) -> OraclePrice {
            OraclePrice {
                price: env
                    .storage()
                    .instance()
                    .get(&symbol_short!("PRICE"))
                    .unwrap_or(0),
                timestamp: env
                    .storage()
                    .instance()
                    .get(&symbol_short!("TS"))
                    .unwrap_or(0),
            }
        }
    }

    struct Setup {
        env: Env,
        borrower: Address,
        liquidator: Address,
        fee_recipient: Address,
        debt_token: Address,
        collateral_token: Address,
        oracle: Address,
        client: QuickLendXContractClient<'static>,
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = START);

        let admin = Address::generate(&env);
        let borrower = Address::generate(&env);
        let liquidator = Address::generate(&env);
        let fee_recipient = Address::generate(&env);

        let debt_token = env.register_stellar_asset_contract_v2(Address::generate(&env));
        let collateral_token = env.register_stellar_asset_contract_v2(Address::generate(&env));
        let oracle = env.register(MockOracle, ());

        let contract_id = env.register(QuickLendXContract, ());
        let client = QuickLendXContractClient::new(&env, &contract_id);

        client.initialize(
            &admin,
            &debt_token.address(),
            &collateral_token.address(),
            &oracle,
            &MAX_STALENESS,
            &MAX_LTV_BPS,
            &LIQUIDATION_PENALTY_BPS,
            &LIQUIDATOR_REWARD_BPS,
            &fee_recipient,
        );

        StellarAssetClient::new(&env, &debt_token.address()).mint(&admin, &10_000);
        client.fund_pool(&admin, &10_000);
        StellarAssetClient::new(&env, &collateral_token.address()).mint(&borrower, &1_000);
        StellarAssetClient::new(&env, &debt_token.address()).mint(&liquidator, &1_000);

        MockOracleClient::new(&env, &oracle).set_price(&2i128, &START);

        Setup {
            env,
            borrower,
            liquidator,
            fee_recipient,
            debt_token: debt_token.address(),
            collateral_token: collateral_token.address(),
            oracle,
            client,
        }
    }

    #[test]
    fn loan_is_healthy_at_origination() {
        let s = setup();
        let loan_id = s.client.open_loan(&s.borrower, &1_000i128, &1_000i128);

        assert_eq!(s.client.loan_ltv_bps(&loan_id), 5_000);
        assert!(!s.client.is_liquidatable(&loan_id));
        assert_eq!(s.client.get_loan(&loan_id).status, LoanStatus::Active);
    }

    #[test]
    fn price_drop_triggers_partial_liquidation_with_penalty_and_reward() {
        let s = setup();
        let loan_id = s.client.open_loan(&s.borrower, &1_000i128, &1_000i128);

        s.env.ledger().with_mut(|li| li.timestamp = START + 100);
        MockOracleClient::new(&s.env, &s.oracle).set_price(&1i128, &(START + 100));

        assert_eq!(s.client.loan_ltv_bps(&loan_id), 10_000);
        assert!(s.client.is_liquidatable(&loan_id));

        let result = s.client.liquidate(&loan_id, &s.liquidator, &500i128);

        let expected_event = CollateralLiquidated {
            loan_id,
            borrower: s.borrower.clone(),
            liquidator: s.liquidator.clone(),
            debt_repaid: 500,
            collateral_seized: 550,
            penalty: 25,
            liquidator_reward: 25,
        };
        assert_eq!(
            s.env.events().all().filter_by_contract(&s.client.address),
            [expected_event.to_xdr(&s.env, &s.client.address)]
        );

        assert_eq!(
            result,
            LiquidationResult {
                debt_repaid: 500,
                collateral_seized: 550,
                penalty: 25,
                liquidator_reward: 25,
            }
        );

        let debt = TokenClient::new(&s.env, &s.debt_token);
        let collateral = TokenClient::new(&s.env, &s.collateral_token);
        assert_eq!(debt.balance(&s.liquidator), 500);
        assert_eq!(collateral.balance(&s.liquidator), 525);
        assert_eq!(collateral.balance(&s.fee_recipient), 25);
        assert_eq!(collateral.balance(&s.client.address), 450);

        let loan = s.client.get_loan(&loan_id);
        assert_eq!(loan.debt_amount, 500);
        assert_eq!(loan.collateral_amount, 450);
        assert_eq!(loan.status, LoanStatus::Active);
    }

    #[test]
    fn full_liquidation_closes_the_loan() {
        let s = setup();
        let loan_id = s.client.open_loan(&s.borrower, &1_000i128, &1_000i128);

        s.env.ledger().with_mut(|li| li.timestamp = START + 100);
        MockOracleClient::new(&s.env, &s.oracle).set_price(&1i128, &(START + 100));

        s.client.liquidate(&loan_id, &s.liquidator, &1_000i128);

        let loan = s.client.get_loan(&loan_id);
        assert_eq!(loan.debt_amount, 0);
        assert_eq!(loan.status, LoanStatus::Closed);
        assert!(!s.client.is_liquidatable(&loan_id));
    }

    #[test]
    fn liquidation_is_rejected_while_the_loan_is_healthy() {
        let s = setup();
        let loan_id = s.client.open_loan(&s.borrower, &1_000i128, &1_000i128);

        assert_eq!(
            s.client.try_liquidate(&loan_id, &s.liquidator, &500i128),
            Err(Ok(QuickLendXError::LoanNotLiquidatable))
        );
    }

    #[test]
    fn stale_oracle_price_blocks_liquidation_and_ltv_reads() {
        let s = setup();
        let loan_id = s.client.open_loan(&s.borrower, &1_000i128, &1_000i128);

        s.env
            .ledger()
            .with_mut(|li| li.timestamp = START + MAX_STALENESS + 1);

        assert_eq!(
            s.client.try_loan_ltv_bps(&loan_id),
            Err(Ok(QuickLendXError::StaleOraclePrice))
        );
        assert_eq!(
            s.client.try_liquidate(&loan_id, &s.liquidator, &500i128),
            Err(Ok(QuickLendXError::StaleOraclePrice))
        );
    }

    #[test]
    fn invalid_oracle_price_is_rejected() {
        let s = setup();
        let loan_id = s.client.open_loan(&s.borrower, &1_000i128, &1_000i128);

        s.env.ledger().with_mut(|li| li.timestamp = START + 10);
        MockOracleClient::new(&s.env, &s.oracle).set_price(&0i128, &(START + 10));

        assert_eq!(
            s.client.try_liquidate(&loan_id, &s.liquidator, &500i128),
            Err(Ok(QuickLendXError::InvalidOraclePrice))
        );
    }

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
