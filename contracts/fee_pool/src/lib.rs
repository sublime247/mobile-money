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
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short, token,
    Address, Env, Map, Symbol,
};

/// Basis-point denominator (100%).
pub const BPS_DENOMINATOR: i128 = 10_000;

/// Advance-notice period for a protocol fee change: 48 hours in seconds.
/// Liquidity providers and merchants must get this long between proposal and
/// activation (issue #2422).
pub const FEE_UPDATE_TIMELOCK_SECONDS: u64 = 48 * 60 * 60;

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
    /// No fee update has been proposed.
    NoPendingFeeUpdate = 10,
    /// The proposed fee update is still inside its 48-hour notice period.
    FeeUpdateTimelockActive = 11,
}

// ── State ────────────────────────────────────────────────────────────────────

/// A fee-bps change waiting out its 48-hour advance-notice period.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingFeeUpdate {
    pub new_fee_bps: u32,
    pub executable_at: u64,
}

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

/// Emitted when an admin proposes a protocol fee change, with both the
/// currently effective bps and the proposed value, plus activation time.
#[contractevent(topics = ["fee_pool", "fee_update_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeUpdateProposed {
    #[topic]
    pub admin: Address,
    pub old_fee_bps: u32,
    pub new_fee_bps: u32,
    pub executable_at: u64,
}

/// Emitted when the notice period has elapsed and the new bps takes effect.
#[contractevent(topics = ["fee_pool", "fee_update_applied"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeUpdateApplied {
    #[topic]
    pub admin: Address,
    pub old_fee_bps: u32,
    pub new_fee_bps: u32,
}

/// Emitted when an admin cancels a pending fee change before it activates.
#[contractevent(topics = ["fee_pool", "fee_update_cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeUpdateCancelled {
    #[topic]
    pub admin: Address,
    pub cancelled_fee_bps: u32,
}

// ── Storage keys ──────────────────────────────────────────────────────────────

const STATE: &str = "STATE";
const PROVIDERS: &str = "PROVIDERS";
const TOTAL_SHARES: &str = "TOTAL_SHARES";
const PENDING_FEE: Symbol = symbol_short!("PEND_FEE");

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

        assert!(!env.storage().instance().has(&STATE), "already initialised");

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

    // ── fee update timelock ───────────────────────────────────────────────────

    /// Return the pending fee update, if any.
    pub fn get_pending_fee_update(env: Env) -> Option<PendingFeeUpdate> {
        env.storage().instance().get(&PENDING_FEE)
    }

    /// Admin-only: propose a new protocol fee in basis points. The change
    /// cannot take effect until `FEE_UPDATE_TIMELOCK_SECONDS` have elapsed;
    /// LPs and merchants therefore get 48 hours of advance notice.
    pub fn propose_fee_update(env: Env, new_fee_bps: u32) -> Result<(), FeePoolError> {
        let state: FeePoolState = env
            .storage()
            .instance()
            .get(&STATE)
            .ok_or(FeePoolError::NotInitialised)?;
        state.admin.require_auth();

        if new_fee_bps > BPS_DENOMINATOR as u32 {
            return Err(FeePoolError::InvalidFeeBps);
        }

        let old_fee_bps = state.fee_bps;
        let executable_at = env
            .ledger()
            .timestamp()
            .saturating_add(FEE_UPDATE_TIMELOCK_SECONDS);
        env.storage().instance().set(
            &PENDING_FEE,
            &PendingFeeUpdate {
                new_fee_bps,
                executable_at,
            },
        );
        env.storage().instance().extend_ttl(1000, 10000);

        FeeUpdateProposed {
            admin: state.admin,
            old_fee_bps,
            new_fee_bps,
            executable_at,
        }
        .publish(&env);

        Ok(())
    }

    /// Admin-only: apply a proposed fee update once its notice period has
    /// elapsed. Premature calls are rejected with `FeeUpdateTimelockActive`.
    pub fn apply_fee_update(env: Env) -> Result<(), FeePoolError> {
        let mut state: FeePoolState = env
            .storage()
            .instance()
            .get(&STATE)
            .ok_or(FeePoolError::NotInitialised)?;
        state.admin.require_auth();

        let pending: PendingFeeUpdate = env
            .storage()
            .instance()
            .get(&PENDING_FEE)
            .ok_or(FeePoolError::NoPendingFeeUpdate)?;

        if env.ledger().timestamp() < pending.executable_at {
            return Err(FeePoolError::FeeUpdateTimelockActive);
        }

        let old_fee_bps = state.fee_bps;
        state.fee_bps = pending.new_fee_bps;
        env.storage().instance().set(&STATE, &state);
        env.storage().instance().remove(&PENDING_FEE);
        env.storage().instance().extend_ttl(1000, 10000);

        FeeUpdateApplied {
            admin: state.admin,
            old_fee_bps,
            new_fee_bps: pending.new_fee_bps,
        }
        .publish(&env);

        Ok(())
    }

    /// Admin-only: cancel a pending fee update before it activates.
    pub fn cancel_fee_update(env: Env) -> Result<(), FeePoolError> {
        let state: FeePoolState = env
            .storage()
            .instance()
            .get(&STATE)
            .ok_or(FeePoolError::NotInitialised)?;
        state.admin.require_auth();

        let pending: PendingFeeUpdate = env
            .storage()
            .instance()
            .get(&PENDING_FEE)
            .ok_or(FeePoolError::NoPendingFeeUpdate)?;
        env.storage().instance().remove(&PENDING_FEE);
        env.storage().instance().extend_ttl(1000, 10000);

        FeeUpdateCancelled {
            admin: state.admin,
            cancelled_fee_bps: pending.new_fee_bps,
        }
        .publish(&env);

        Ok(())
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

        assert!(
            !providers.contains_key(provider.clone()),
            "provider already registered"
        );

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
    pub fn get_provider_metrics(
        env: Env,
        provider: Address,
    ) -> Result<ProviderMetrics, FeePoolError> {
        let providers: Map<Address, ProviderMetrics> = env
            .storage()
            .instance()
            .get(&PROVIDERS)
            .ok_or(FeePoolError::NotInitialised)?;

        providers.get(provider).ok_or(FeePoolError::NotRegistered)
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
        let providers: Map<Address, ProviderMetrics> = env
            .storage()
            .instance()
            .get(&PROVIDERS)
            .unwrap_or(Map::new(&env));
        let count = providers.len();
        env.storage().instance().extend_ttl(1000, 10000);
        count
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod test;
