#![no_std]
#![allow(clippy::too_many_arguments)]

//! Fee pool — on-chain platform/provider fee split, plus tier-weighted
//! provider distribution.
//!
//! Previously, callers computed the platform's cut and the provider pool's
//! cut of a fee off-chain and invoked this contract with whatever amount
//! they claimed belonged to providers — accounting only liquidity
//! providers, merchants, and anchor operators could not independently
//! verify. [`FeePoolContract::accumulate_fees`] now takes the *total* fee
//! amount and computes the split itself, on-chain, from `fee_bps`: the
//! platform's cut is paid to `platform_treasury` immediately, and the
//! remainder is pooled for [`FeePoolContract::distribute`] to hand out to
//! providers, weighted by their liquidity/uptime/transaction-count tier.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env, Map,
};

/// Basis-point denominator (100%).
pub const BPS_DENOMINATOR: i128 = 10_000;

// ── Error types ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum FeePoolError {
    /// Contract is already initialised.
    AlreadyInitialised = 1,
    /// Contract has not been initialised yet.
    NotInitialised = 2,
    /// Provider is already registered.
    AlreadyRegistered = 3,
    /// Provider is not registered.
    NotRegistered = 4,
    /// Invalid fee basis points (must be in [0, 10_000]).
    InvalidFeeBps = 5,
    /// Invalid liquidity amount (must be positive).
    InvalidLiquidity = 6,
    /// Invalid uptime percentage (must be in [0, 100]).
    InvalidUptime = 7,
    /// No fees available to distribute.
    NoFeesAvailable = 8,
    /// Distribution period not yet elapsed.
    DistributionTooSoon = 9,
}

// ── State ────────────────────────────────────────────────────────────────────

/// Wallet metrics for a liquidity provider.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderMetrics {
    /// Total liquidity provided by the provider.
    pub liquidity: i128,
    /// Uptime percentage (0-100).
    pub uptime: u32,
    /// Number of successful transactions facilitated.
    pub transaction_count: u64,
    /// Timestamp of last metrics update.
    pub last_updated: u64,
}

/// Fee pool state.
#[contracttype]
#[derive(Clone)]
pub struct FeePoolState {
    /// Token address for the fee pool.
    pub token: Address,
    /// Admin address that can manage the pool.
    pub admin: Address,
    /// Address that receives the platform's cut of each accumulated fee.
    pub platform_treasury: Address,
    /// Platform's cut of each accumulated fee, in basis points (0-10_000).
    /// The remainder pools for tier-weighted provider distribution.
    pub fee_bps: u32,
    /// Minimum time between distributions in seconds.
    pub distribution_interval: u64,
    /// Last distribution timestamp.
    pub last_distribution: u64,
    /// Total accumulated fees in the pool.
    pub total_fees: i128,
}

// ── Events ───────────────────────────────────────────────────────────────────

/// Emitted every time `accumulate_fees` splits a fee, so the platform cut
/// and provider-pool cut are independently auditable on-chain.
#[contractevent(topics = ["fee_pool", "fees_accumulated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeesAccumulated {
    #[topic]
    pub from: Address,
    pub amount: i128,
    pub platform_cut: i128,
    pub provider_cut: i128,
}

// ── Storage keys ──────────────────────────────────────────────────────────────

const STATE: &str = "STATE";
const PROVIDERS: &str = "PROVIDERS";
const TOTAL_SHARES: &str = "TOTAL_SHARES";

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct FeePoolContract;

#[contractimpl]
impl FeePoolContract {
    // ── initialize ────────────────────────────────────────────────────────────

    /// Initialise the fee pool contract.
    ///
    /// # Arguments
    /// * `admin` - Admin address that can manage the pool
    /// * `token` - Token address for fee collection
    /// * `platform_treasury` - Receives the platform's cut of each accumulated fee
    /// * `fee_bps` - Platform's cut of each accumulated fee, in basis points (0-10_000)
    /// * `distribution_interval` - Minimum seconds between distributions
    pub fn initialize(
        env: Env,
        admin: Address,
        token: Address,
        platform_treasury: Address,
        fee_bps: u32,
        distribution_interval: u64,
    ) {
        admin.require_auth();

        assert!(
            !env.storage().instance().has(&STATE),
            "already initialised"
        );

        assert!(fee_bps <= 10_000, "fee basis points must be in [0, 10000]");

        assert!(
            distribution_interval > 0,
            "distribution interval must be positive"
        );

        env.storage().instance().set(
            &STATE,
            &FeePoolState {
                token: token.clone(),
                admin,
                platform_treasury,
                fee_bps,
                distribution_interval,
                last_distribution: 0,
                total_fees: 0,
            },
        );

        env.storage().instance().set(&TOTAL_SHARES, &0i128);

        env.storage().instance().extend_ttl(1000, 10000);
    }

    // ── register_provider ─────────────────────────────────────────────────────

    /// Register a liquidity provider with initial metrics.
    ///
    /// # Arguments
    /// * `provider` - Provider wallet address
    /// * `liquidity` - Initial liquidity amount (must be positive)
    /// * `uptime` - Initial uptime percentage (0-100)
    pub fn register_provider(
        env: Env,
        provider: Address,
        liquidity: i128,
        uptime: u32,
    ) -> Result<(), FeePoolError> {
        provider.require_auth();

        let state: FeePoolState = env
            .storage()
            .instance()
            .get(&STATE)
            .ok_or(FeePoolError::NotInitialised)?;

        assert!(liquidity > 0, "liquidity must be positive");
        assert!(uptime <= 100, "uptime must be in [0, 100]");

        let providers: Map<Address, ProviderMetrics> = env
            .storage()
            .instance()
            .get(&PROVIDERS)
            .unwrap_or(Map::new(&env));

        assert!(!providers.contains_key(&provider), "provider already registered");

        let metrics = ProviderMetrics {
            liquidity,
            uptime,
            transaction_count: 0,
            last_updated: env.ledger().timestamp(),
        };

        let mut new_providers = providers;
        new_providers.set(provider.clone(), metrics);

        env.storage().instance().set(&PROVIDERS, &new_providers);

        // Update total shares based on liquidity contribution
        let total_shares: i128 = env.storage().instance().get(&TOTAL_SHARES).unwrap_or(0);
        env.storage()
            .instance()
            .set(&TOTAL_SHARES, &(total_shares + liquidity));

        env.storage().instance().extend_ttl(1000, 10000);

        Ok(())
    }

    // ── update_metrics ────────────────────────────────────────────────────────

    /// Update provider metrics.
    ///
    /// # Arguments
    /// * `provider` - Provider wallet address
    /// * `liquidity` - New liquidity amount
    /// * `uptime` - New uptime percentage (0-100)
    /// * `transaction_count` - Additional transaction count to add
    pub fn update_metrics(
        env: Env,
        provider: Address,
        liquidity: i128,
        uptime: u32,
        transaction_count: u64,
    ) -> Result<(), FeePoolError> {
        provider.require_auth();

        assert!(liquidity > 0, "liquidity must be positive");
        assert!(uptime <= 100, "uptime must be in [0, 100]");

        let mut providers: Map<Address, ProviderMetrics> = env
            .storage()
            .instance()
            .get(&PROVIDERS)
            .ok_or(FeePoolError::NotInitialised)?;

        let mut metrics = providers
            .get(provider.clone())
            .ok_or(FeePoolError::NotRegistered)?;

        // Calculate share adjustment
        let old_liquidity = metrics.liquidity;
        let liquidity_delta = liquidity - old_liquidity;

        metrics.liquidity = liquidity;
        metrics.uptime = uptime;
        metrics.transaction_count += transaction_count;
        metrics.last_updated = env.ledger().timestamp();

        providers.set(provider.clone(), metrics);
        env.storage().instance().set(&PROVIDERS, &providers);

        // Update total shares
        let total_shares: i128 = env.storage().instance().get(&TOTAL_SHARES).unwrap_or(0);
        env.storage()
            .instance()
            .set(&TOTAL_SHARES, &(total_shares + liquidity_delta));

        env.storage().instance().extend_ttl(1000, 10000);

        Ok(())
    }

    // ── accumulate_fees ───────────────────────────────────────────────────────

    /// Accumulate transaction fees into the pool, splitting the platform's
    /// cut from the provider pool's cut on-chain (per `fee_bps`) instead of
    /// trusting a caller-supplied, off-chain-computed split.
    ///
    /// # Arguments
    /// * `from` - Address providing the fees
    /// * `amount` - Total fee amount collected from the transaction
    pub fn accumulate_fees(env: Env, from: Address, amount: i128) -> Result<(), FeePoolError> {
        from.require_auth();

        assert!(amount > 0, "amount must be positive");

        let mut state: FeePoolState = env
            .storage()
            .instance()
            .get(&STATE)
            .ok_or(FeePoolError::NotInitialised)?;

        let platform_cut = amount * state.fee_bps as i128 / BPS_DENOMINATOR;
        let provider_cut = amount - platform_cut;

        let token_client = token::Client::new(&env, &state.token);
        if platform_cut > 0 {
            token_client.transfer(&from, &state.platform_treasury, &platform_cut);
        }
        if provider_cut > 0 {
            token_client.transfer(&from, &env.current_contract_address(), &provider_cut);
        }

        state.total_fees += provider_cut;
        env.storage().instance().set(&STATE, &state);

        env.storage().instance().extend_ttl(1000, 10000);

        FeesAccumulated {
            from,
            amount,
            platform_cut,
            provider_cut,
        }
        .publish(&env);

        Ok(())
    }

    // ── distribute ─────────────────────────────────────────────────────────────

    /// Distribute accumulated fees to providers based on their metrics.
    /// Distribution is weighted by liquidity * uptime * transaction_count_factor.
    pub fn distribute(env: Env) -> Result<(), FeePoolError> {
        let mut state: FeePoolState = env
            .storage()
            .instance()
            .get(&STATE)
            .ok_or(FeePoolError::NotInitialised)?;

        state.admin.require_auth();

        let current_time = env.ledger().timestamp();

        // Check distribution interval
        if state.last_distribution > 0
            && current_time < state.last_distribution + state.distribution_interval
        {
            return Err(FeePoolError::DistributionTooSoon);
        }

        if state.total_fees <= 0 {
            return Err(FeePoolError::NoFeesAvailable);
        }

        let providers: Map<Address, ProviderMetrics> = env
            .storage()
            .instance()
            .get(&PROVIDERS)
            .ok_or(FeePoolError::NotInitialised)?;

        if providers.is_empty() {
            return Err(FeePoolError::NoFeesAvailable);
        }

        // Calculate weighted shares for each provider
        let mut total_weighted_shares: i128 = 0;
        let mut weighted_shares: Map<Address, i128> = Map::new(&env);

        for (provider, metrics) in providers.iter() {
            // Weight = liquidity * (uptime / 100) * sqrt(transaction_count)
            let uptime_factor = metrics.uptime as i128;
            let tx_factor = if metrics.transaction_count > 0 {
                (metrics.transaction_count as f64).sqrt() as i128
            } else {
                1
            };
            let weight = metrics.liquidity * uptime_factor * tx_factor / 10_000;
            weighted_shares.set(provider.clone(), weight);
            total_weighted_shares += weight;
        }

        if total_weighted_shares <= 0 {
            return Err(FeePoolError::NoFeesAvailable);
        }

        // Distribute fees based on weighted shares
        let token_client = token::Client::new(&env, &state.token);
        let contract_addr = env.current_contract_address();

        for (provider, weight) in weighted_shares.iter() {
            let share = state.total_fees * weight / total_weighted_shares;
            if share > 0 {
                token_client.transfer(&contract_addr, &provider, &share);
            }
        }

        // Reset fee pool and update last distribution time
        state.total_fees = 0;
        state.last_distribution = current_time;
        env.storage().instance().set(&STATE, &state);

        env.storage().instance().extend_ttl(1000, 10000);

        Ok(())
    }

    // ── get_state ─────────────────────────────────────────────────────────────

    /// Return current fee pool state (read-only).
    pub fn get_state(env: Env) -> FeePoolState {
        let state = env
            .storage()
            .instance()
            .get(&STATE)
            .expect("not initialised");
        env.storage().instance().extend_ttl(1000, 10000);
        state
    }

    // ── get_provider_metrics ──────────────────────────────────────────────────

    /// Return metrics for a specific provider (read-only).
    pub fn get_provider_metrics(env: Env, provider: Address) -> Result<ProviderMetrics, FeePoolError> {
        let providers: Map<Address, ProviderMetrics> = env
            .storage()
            .instance()
            .get(&PROVIDERS)
            .ok_or(FeePoolError::NotInitialised)?;

        providers
            .get(provider)
            .ok_or(FeePoolError::NotRegistered)
    }

    // ── get_total_shares ───────────────────────────────────────────────────────

    /// Return total liquidity shares in the pool.
    pub fn get_total_shares(env: Env) -> i128 {
        let total = env.storage().instance().get(&TOTAL_SHARES).unwrap_or(0);
        env.storage().instance().extend_ttl(1000, 10000);
        total
    }

    // ── get_provider_count ────────────────────────────────────────────────────

    /// Return the number of registered providers.
    pub fn get_provider_count(env: Env) -> u32 {
        let providers: Map<Address, ProviderMetrics> =
            env.storage().instance().get(&PROVIDERS).unwrap_or(Map::new(&env));
        let count = providers.len();
        env.storage().instance().extend_ttl(1000, 10000);
        count
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env,
    };

    const MINT_AMOUNT: i128 = 10_000_000;

    fn setup() -> (Env, Address, Address, Address, Address, FeePoolContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let fee_payer = Address::generate(&env);
        let platform_treasury = Address::generate(&env);

        // Deploy a test token
        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin);
        StellarAssetClient::new(&env, &token_id.address()).mint(&admin, &MINT_AMOUNT);
        StellarAssetClient::new(&env, &token_id.address()).mint(&fee_payer, &MINT_AMOUNT);

        let contract_id = env.register(FeePoolContract, ());
        let client = FeePoolContractClient::new(&env, &contract_id);

        (env, admin, fee_payer, platform_treasury, token_id.address(), client)
    }

    #[test]
    fn test_initialize() {
        let (env, admin, _fee_payer, platform_treasury, token, client) = setup();

        client.initialize(&admin, &token, &platform_treasury, &100, &3600);

        let state = client.get_state();
        assert_eq!(state.token, token);
        assert_eq!(state.admin, admin);
        assert_eq!(state.platform_treasury, platform_treasury);
        assert_eq!(state.fee_bps, 100);
        assert_eq!(state.distribution_interval, 3600);
        assert_eq!(state.total_fees, 0);
        assert_eq!(state.last_distribution, 0);
    }

    #[test]
    fn test_register_provider() {
        let (env, admin, _fee_payer, platform_treasury, token, client) = setup();

        client.initialize(&admin, &token, &platform_treasury, &100, &3600);

        let provider = Address::generate(&env);
        client.register_provider(&provider, &1_000_000, &95).unwrap();

        let metrics = client.get_provider_metrics(&provider).unwrap();
        assert_eq!(metrics.liquidity, 1_000_000);
        assert_eq!(metrics.uptime, 95);
        assert_eq!(metrics.transaction_count, 0);

        assert_eq!(client.get_total_shares(), 1_000_000);
        assert_eq!(client.get_provider_count(), 1);
    }

    #[test]
    fn test_register_multiple_providers() {
        let (env, admin, _fee_payer, platform_treasury, token, client) = setup();

        client.initialize(&admin, &token, &platform_treasury, &100, &3600);

        let provider1 = Address::generate(&env);
        let provider2 = Address::generate(&env);
        let provider3 = Address::generate(&env);

        client.register_provider(&provider1, &1_000_000, &95).unwrap();
        client.register_provider(&provider2, &2_000_000, &90).unwrap();
        client.register_provider(&provider3, &500_000, &98).unwrap();

        assert_eq!(client.get_provider_count(), 3);
        assert_eq!(client.get_total_shares(), 3_500_000);
    }

    #[test]
    fn test_update_metrics() {
        let (env, admin, _fee_payer, platform_treasury, token, client) = setup();

        client.initialize(&admin, &token, &platform_treasury, &100, &3600);

        let provider = Address::generate(&env);
        client.register_provider(&provider, &1_000_000, &95).unwrap();

        client
            .update_metrics(&provider, &1_500_000, &97, &100)
            .unwrap();

        let metrics = client.get_provider_metrics(&provider).unwrap();
        assert_eq!(metrics.liquidity, 1_500_000);
        assert_eq!(metrics.uptime, 97);
        assert_eq!(metrics.transaction_count, 100);

        assert_eq!(client.get_total_shares(), 1_500_000);
    }

    #[test]
    fn test_accumulate_fees() {
        let (env, admin, fee_payer, platform_treasury, token, client) = setup();

        client.initialize(&admin, &token, &platform_treasury, &100, &3600);

        client.accumulate_fees(&fee_payer, &500_000).unwrap();

        // 1% (fee_bps=100) of 500_000 goes to the platform treasury,
        // the remainder pools for provider distribution.
        let state = client.get_state();
        assert_eq!(state.total_fees, 495_000);

        let tc = TokenClient::new(&env, &token);
        assert_eq!(tc.balance(&fee_payer), MINT_AMOUNT - 500_000);
        assert_eq!(tc.balance(&platform_treasury), 5_000);
        assert_eq!(tc.balance(&client.address), 495_000);
    }

    #[test]
    fn test_distribute_single_provider() {
        let (env, admin, fee_payer, platform_treasury, token, client) = setup();

        client.initialize(&admin, &token, &platform_treasury, &100, &3600);

        let provider = Address::generate(&env);
        client.register_provider(&provider, &1_000_000, &100).unwrap();

        client.accumulate_fees(&fee_payer, &100_000).unwrap();

        env.ledger().set_timestamp(3600);
        client.distribute().unwrap();

        let state = client.get_state();
        assert_eq!(state.total_fees, 0);
        assert_eq!(state.last_distribution, 3600);

        // Platform kept its 1% cut (1_000); the provider gets the rest (99_000).
        let tc = TokenClient::new(&env, &token);
        assert_eq!(tc.balance(&platform_treasury), 1_000);
        assert_eq!(tc.balance(&provider), 99_000);
    }

    #[test]
    fn test_distribute_multiple_providers() {
        let (env, admin, fee_payer, platform_treasury, token, client) = setup();

        client.initialize(&admin, &token, &platform_treasury, &100, &3600);

        let provider1 = Address::generate(&env);
        let provider2 = Address::generate(&env);
        let provider3 = Address::generate(&env);

        // Register providers with different metrics
        client
            .register_provider(&provider1, &1_000_000, &100)
            .unwrap();
        client
            .register_provider(&provider2, &2_000_000, &90)
            .unwrap();
        client
            .register_provider(&provider3, &500_000, &95)
            .unwrap();

        // Add some transaction history
        client
            .update_metrics(&provider1, &1_000_000, &100, &100)
            .unwrap();
        client
            .update_metrics(&provider2, &2_000_000, &90, &50)
            .unwrap();
        client
            .update_metrics(&provider3, &500_000, &95, &25)
            .unwrap();

        client.accumulate_fees(&fee_payer, &1_000_000).unwrap();

        env.ledger().set_timestamp(3600);
        client.distribute().unwrap();

        let state = client.get_state();
        assert_eq!(state.total_fees, 0);

        let tc = TokenClient::new(&env, &token);
        let p1_balance = tc.balance(&provider1);
        let p2_balance = tc.balance(&provider2);
        let p3_balance = tc.balance(&provider3);

        // Verify all providers received something
        assert!(p1_balance > 0);
        assert!(p2_balance > 0);
        assert!(p3_balance > 0);

        // Platform kept its 1% cut (10_000); providers split the rest (990_000).
        assert_eq!(tc.balance(&platform_treasury), 10_000);
        assert_eq!(p1_balance + p2_balance + p3_balance, 990_000);
    }

    #[test]
    fn test_distribution_interval() {
        let (env, admin, fee_payer, platform_treasury, token, client) = setup();

        client.initialize(&admin, &token, &platform_treasury, &100, &3600);

        let provider = Address::generate(&env);
        client.register_provider(&provider, &1_000_000, &100).unwrap();

        client.accumulate_fees(&fee_payer, &100_000).unwrap();

        env.ledger().set_timestamp(3600);
        client.distribute().unwrap();

        client.accumulate_fees(&fee_payer, &50_000).unwrap();

        // Try to distribute before interval elapses
        env.ledger().set_timestamp(4000);
        let result = client.try_distribute();
        assert!(result.is_err());

        // Distribute after interval elapses
        env.ledger().set_timestamp(7200);
        client.distribute().unwrap();
    }

    #[test]
    fn test_no_fees_available() {
        let (env, admin, _fee_payer, platform_treasury, token, client) = setup();

        client.initialize(&admin, &token, &platform_treasury, &100, &3600);

        let provider = Address::generate(&env);
        client.register_provider(&provider, &1_000_000, &100).unwrap();

        env.ledger().set_timestamp(3600);
        let result = client.try_distribute();
        assert!(result.is_err());
    }

    #[test]
    fn test_error_already_registered() {
        let (env, admin, _fee_payer, platform_treasury, token, client) = setup();

        client.initialize(&admin, &token, &platform_treasury, &100, &3600);

        let provider = Address::generate(&env);
        client.register_provider(&provider, &1_000_000, &95).unwrap();

        let result = client.try_register_provider(&provider, &2_000_000, &90);
        assert!(result.is_err());
    }

    #[test]
    fn test_error_not_registered() {
        let (env, admin, _fee_payer, platform_treasury, token, client) = setup();

        client.initialize(&admin, &token, &platform_treasury, &100, &3600);

        let provider = Address::generate(&env);
        let result = client.try_get_provider_metrics(&provider);
        assert!(result.is_err());
    }

    #[test]
    fn test_error_invalid_liquidity() {
        let (env, admin, _fee_payer, platform_treasury, token, client) = setup();

        client.initialize(&admin, &token, &platform_treasury, &100, &3600);

        let provider = Address::generate(&env);
        let result = client.try_register_provider(&provider, &0, &95);
        assert!(result.is_err());
    }

    #[test]
    fn test_error_invalid_uptime() {
        let (env, admin, _fee_payer, platform_treasury, token, client) = setup();

        client.initialize(&admin, &token, &platform_treasury, &100, &3600);

        let provider = Address::generate(&env);
        let result = client.try_register_provider(&provider, &1_000_000, &101);
        assert!(result.is_err());
    }
}
