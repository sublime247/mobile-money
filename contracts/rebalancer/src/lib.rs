#![no_std]
#![allow(clippy::too_many_arguments)]
//! Automated liquidity pool rebalancer (issue #2003).
//!
//! Keeps an anchor's holdings of two assets, a local fiat-pegged token and a
//! Stellar DEX stablecoin, near a configured target ratio. Anyone can call
//! `check_and_rebalance`; it is a no-op unless the current split has drifted
//! more than [`DEFAULT_IMBALANCE_THRESHOLD_BPS`] away from target, in which
//! case it swaps just enough of the overweight asset (via the existing
//! `contracts/router` DEX router) to bring the ratio back to target.
//!
//! Only admin-authorized rebalancer bots may trigger a swap. Each call
//! authenticates the bot with `require_auth`, checks the bot allowlist, and
//! emits a `rebalance_needed` alert as soon as the threshold is crossed, so
//! off-chain keepers can observe the imbalance even if the swap later fails
//! its price guards.
//!
//! ## What "the pool" is
//!
//! The issue's acceptance criteria talks about rebalancing "local fiat
//! pools" against "DEX stablecoins" without specifying a custody model. This
//! contract holds both assets directly in its own balance (a real Soroban
//! token balance, not an internal ledger entry) rather than tracking
//! reserves inside `contracts/router`'s own `LiquidityPool` bookkeeping:
//! `router::execute_swap` already transfers real tokens from `caller` to
//! itself and back, so the rebalancer just needs to BE that caller, holding
//! the funds it swaps between. An anchor deposits its float into this
//! contract once; the rebalancer then keeps that float's split near target
//! going forward.
//!
//! ## Reading the swap price
//!
//! `min_amount_out` for `router::execute_swap` is derived from
//! `contracts/oracle`'s `get_rate`, not left at `1` (which would accept any
//! price) or hardcoded: the oracle is queried for the expected output at the
//! rebalance amount, then a [`DEFAULT_MAX_SLIPPAGE_BPS`] tolerance is
//! applied under that, so a rebalance can never execute a swap the oracle
//! considers far off-market, even though the router itself only guards
//! against ITS OWN pool depth's slippage, not price sanity against an
//! independent reference.
//!
//! ## Direction of a single swap
//!
//! One `check_and_rebalance` call performs at most one swap, sized to bring
//! the ratio exactly to target (not past it) given the two balances *at the
//! start of the call*. It does not loop to convergence within one
//! invocation: a swap changes both balances, and immediately re-deriving a
//! second correction from the same stale oracle price without observing the
//! swap's actual on-chain effect first is not meaningfully more accurate,
//! only more gas. A caller (a keeper) that wants tighter convergence simply
//! calls again.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short, token,
    Address, Env, IntoVal, Symbol, Vec,
};

const CONFIG: Symbol = symbol_short!("CONFIG");
const BOTS: Symbol = symbol_short!("BOTS");

/// A pool drifts more than this many basis points away from
/// `target_ratio_bps` before `check_and_rebalance` does anything. 500 bps =
/// 5%, matching the issue's acceptance criteria exactly.
pub const DEFAULT_IMBALANCE_THRESHOLD_BPS: u32 = 500;

/// Maximum tolerated slippage between the oracle's quoted rate and the
/// router's actual executed output for a rebalancing swap. Independent of
/// (and tighter than) whatever slippage tolerance the router itself is
/// configured with, since a rebalance is a maintenance operation that
/// should be conservative about executing at all, not a user-initiated
/// trade that accepts the router's own configured tolerance.
pub const DEFAULT_MAX_SLIPPAGE_BPS: u32 = 100; // 1%

const BPS_DENOMINATOR: i128 = 10_000;

#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum RebalancerError {
    /// Contract has already been initialized.
    AlreadyInitialized = 1,
    /// Contract must be initialized before this call.
    NotInitialized = 2,
    /// `target_ratio_bps` was not in `(0, 10_000)`.
    InvalidTargetRatio = 3,
    /// Both balances are zero; there is nothing to rebalance.
    NothingToRebalance = 4,
    /// A monetary computation would have overflowed or underflowed `i128`.
    Overflow = 5,
    /// The router's executed swap output was worse than the oracle-derived
    /// minimum this contract requires.
    OracleSlippageExceeded = 6,
    /// Caller is not an authorized rebalancer bot.
    UnauthorizedRebalancer = 7,
    /// The oracle quote would not move the pool closer to target.
    SwapDoesNotImproveRatio = 8,
    /// Threshold values were outside their valid range.
    InvalidThresholds = 9,
}

#[contracttype]
#[derive(Clone)]
pub struct RebalancerConfig {
    pub admin: Address,
    /// The "local fiat pool" asset.
    pub asset_a: Address,
    /// The "Stellar DEX stablecoin" asset.
    pub asset_b: Address,
    /// Target share of `asset_a` in the combined (asset_a + asset_b) value,
    /// in basis points. E.g. `5_000` = 50/50.
    pub target_ratio_bps: u32,
    pub imbalance_threshold_bps: u32,
    pub max_slippage_bps: u32,
    pub router: Address,
    pub oracle: Address,
    /// The router's registered swap path (pool addresses) for `asset_a` ->
    /// `asset_b`, and the separate path for the reverse direction.
    /// `contracts/router` resolves a path by matching each hop's
    /// `(pool.asset_in, pool.asset_out)` in order, so a reverse swap is not
    /// generally just the same path walked backward (a pool registered only
    /// for `asset_a -> asset_b` cannot resolve `asset_b -> asset_a`); both
    /// directions are configured explicitly rather than assumed reversible.
    pub path_a_to_b: Vec<Address>,
    pub path_b_to_a: Vec<Address>,
}

/// Direction of the arbitrage trade that would restore the target ratio.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RebalanceDirection {
    None,
    SellAssetA,
    SellAssetB,
}

/// Read-only answer from `check_rebalance_needed`: whether the pool has
/// drifted beyond its threshold and, if so, the exact trade that would bring
/// it back to target.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RebalanceRecommendation {
    pub needed: bool,
    pub direction: RebalanceDirection,
    pub amount: i128,
    pub current_ratio_bps: u32,
    pub deviation_bps: u32,
    pub balance_a: i128,
    pub balance_b: i128,
    pub target_ratio_bps: u32,
}

// -- Events -------------------------------------------------------------

#[contractevent(topics = ["rebalancer", "rebalance_executed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RebalanceExecuted {
    pub balance_a_before: i128,
    pub balance_b_before: i128,
    pub balance_a_after: i128,
    pub balance_b_after: i128,
    pub amount_swapped: i128,
    /// `true` if `asset_a` was sold for `asset_b`; `false` for the reverse.
    pub sold_asset_a: bool,
}

#[contractevent(topics = ["rebalancer", "rebalance_skipped"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RebalanceSkipped {
    pub balance_a: i128,
    pub balance_b: i128,
    pub current_ratio_bps: u32,
    pub target_ratio_bps: u32,
}

/// Alert emitted when an imbalance beyond the configured threshold is
/// detected, before any swap is attempted. Keepers can subscribe to this
/// event even when they do not call `trigger_rebalance` themselves.
#[contractevent(topics = ["rebalancer", "rebalance_needed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RebalanceNeeded {
    pub current_ratio_bps: u32,
    pub target_ratio_bps: u32,
    pub deviation_bps: u32,
    pub direction: RebalanceDirection,
    pub recommended_amount: i128,
}

#[contract]
pub struct RebalancerContract;

#[contractimpl]
impl RebalancerContract {
    /// Initialize the contract. Callable exactly once.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        env: Env,
        admin: Address,
        asset_a: Address,
        asset_b: Address,
        target_ratio_bps: u32,
        router: Address,
        oracle: Address,
        path_a_to_b: Vec<Address>,
        path_b_to_a: Vec<Address>,
    ) -> Result<(), RebalancerError> {
        if env.storage().instance().has(&CONFIG) {
            return Err(RebalancerError::AlreadyInitialized);
        }
        if target_ratio_bps == 0 || target_ratio_bps >= BPS_DENOMINATOR as u32 {
            return Err(RebalancerError::InvalidTargetRatio);
        }

        admin.require_auth();

        env.storage().instance().set(
            &CONFIG,
            &RebalancerConfig {
                admin,
                asset_a,
                asset_b,
                target_ratio_bps,
                imbalance_threshold_bps: DEFAULT_IMBALANCE_THRESHOLD_BPS,
                max_slippage_bps: DEFAULT_MAX_SLIPPAGE_BPS,
                router,
                oracle,
                path_a_to_b,
                path_b_to_a,
            },
        );
        env.storage().instance().extend_ttl(1000, 10000);

        Ok(())
    }

    /// Admin-only: reconfigure the imbalance threshold and/or max slippage
    /// tolerance. Both default to the issue's own values at `initialize`
    /// time; this exists so an anchor can tune them without redeploying.
    pub fn configure_thresholds(
        env: Env,
        imbalance_threshold_bps: u32,
        max_slippage_bps: u32,
    ) -> Result<(), RebalancerError> {
        let mut config = Self::get_config_internal(&env)?;
        config.admin.require_auth();

        if imbalance_threshold_bps > BPS_DENOMINATOR as u32
            || max_slippage_bps > BPS_DENOMINATOR as u32
        {
            return Err(RebalancerError::InvalidThresholds);
        }

        config.imbalance_threshold_bps = imbalance_threshold_bps;
        config.max_slippage_bps = max_slippage_bps;
        env.storage().instance().set(&CONFIG, &config);
        env.storage().instance().extend_ttl(1000, 10000);
        Ok(())
    }

    /// Admin-only: authorize an address to trigger rebalances.
    pub fn authorize_rebalancer_bot(env: Env, bot: Address) -> Result<(), RebalancerError> {
        let config = Self::get_config_internal(&env)?;
        config.admin.require_auth();

        let mut bots: Vec<Address> = env
            .storage()
            .instance()
            .get(&BOTS)
            .unwrap_or_else(|| Vec::new(&env));
        if !bots.iter().any(|authorized| authorized == bot) {
            bots.push_back(bot);
            env.storage().instance().set(&BOTS, &bots);
            env.storage().instance().extend_ttl(1000, 10000);
        }
        Ok(())
    }

    /// Admin-only: remove an address from the bot allowlist.
    pub fn revoke_rebalancer_bot(env: Env, bot: Address) -> Result<(), RebalancerError> {
        let config = Self::get_config_internal(&env)?;
        config.admin.require_auth();

        let bots: Vec<Address> = env
            .storage()
            .instance()
            .get(&BOTS)
            .unwrap_or_else(|| Vec::new(&env));
        let mut remaining = Vec::new(&env);
        let mut found = false;
        for authorized in bots.iter() {
            if authorized == bot {
                found = true;
            } else {
                remaining.push_back(authorized);
            }
        }
        if found {
            env.storage().instance().set(&BOTS, &remaining);
            env.storage().instance().extend_ttl(1000, 10000);
        }
        Ok(())
    }

    /// Whether `bot` is currently allowed to trigger a rebalance.
    pub fn is_authorized_rebalancer_bot(env: Env, bot: Address) -> bool {
        let bots: Vec<Address> = env
            .storage()
            .instance()
            .get(&BOTS)
            .unwrap_or_else(|| Vec::new(&env));
        bots.iter().any(|authorized| authorized == bot)
    }

    /// Read-only deviation report: whether the pool has drifted beyond its
    /// threshold and, if so, which asset to sell and exactly how much.
    pub fn check_rebalance_needed(env: Env) -> Result<RebalanceRecommendation, RebalancerError> {
        let config = Self::get_config_internal(&env)?;
        Self::recommend(&env, &config)
    }

    /// Check the current `asset_a`/`asset_b` split against the target
    /// ratio; if it has drifted more than `imbalance_threshold_bps`, swap
    /// just enough through `router` to bring it back to target. A no-op
    /// (returns `Ok(0)`, emits `rebalance_skipped`) when already within
    /// tolerance.
    ///
    /// Only admin-authorized bots may trigger a rebalance. The threshold,
    /// oracle quote, expected improvement, and oracle-derived slippage bound
    /// are all enforced on-chain before any swap is routed.
    pub fn check_and_rebalance(env: Env, bot: Address) -> Result<i128, RebalancerError> {
        let config = Self::get_config_internal(&env)?;
        if !Self::is_authorized_rebalancer_bot(env.clone(), bot.clone()) {
            return Err(RebalancerError::UnauthorizedRebalancer);
        }
        bot.require_auth();

        let recommendation = Self::recommend(&env, &config)?;
        if recommendation.balance_a <= 0 && recommendation.balance_b <= 0 {
            return Err(RebalancerError::NothingToRebalance);
        }
        if !recommendation.needed {
            RebalanceSkipped {
                balance_a: recommendation.balance_a,
                balance_b: recommendation.balance_b,
                current_ratio_bps: recommendation.current_ratio_bps,
                target_ratio_bps: config.target_ratio_bps,
            }
            .publish(&env);
            return Ok(0);
        }

        RebalanceNeeded {
            current_ratio_bps: recommendation.current_ratio_bps,
            target_ratio_bps: config.target_ratio_bps,
            deviation_bps: recommendation.deviation_bps,
            direction: recommendation.direction,
            recommended_amount: recommendation.amount,
        }
        .publish(&env);

        let contract_address = env.current_contract_address();
        let balance_a = recommendation.balance_a;
        let balance_b = recommendation.balance_b;
        let amount_to_swap = recommendation.amount;

        let (asset_in, asset_out, path) = match recommendation.direction {
            RebalanceDirection::SellAssetA => (
                config.asset_a.clone(),
                config.asset_b.clone(),
                config.path_a_to_b.clone(),
            ),
            RebalanceDirection::SellAssetB => (
                config.asset_b.clone(),
                config.asset_a.clone(),
                config.path_b_to_a.clone(),
            ),
            RebalanceDirection::None => return Ok(0),
        };

        let oracle_quote: i128 = env.invoke_contract(
            &config.oracle,
            &Symbol::new(&env, "get_rate"),
            soroban_sdk::vec![
                &env,
                asset_in.clone().into_val(&env),
                asset_out.clone().into_val(&env),
                amount_to_swap.into_val(&env),
            ],
        );
        if oracle_quote <= 0 {
            return Err(RebalancerError::OracleSlippageExceeded);
        }

        // Before touching the router, verify that the oracle's expected
        // execution actually reduces the deviation. This blocks a "rebalance"
        // that would either leave the pool where it was or push it further
        // away from its target weight.
        let (expected_a, expected_b) = if recommendation.direction == RebalanceDirection::SellAssetA
        {
            (
                balance_a
                    .checked_sub(amount_to_swap)
                    .ok_or(RebalancerError::Overflow)?,
                balance_b
                    .checked_add(oracle_quote)
                    .ok_or(RebalancerError::Overflow)?,
            )
        } else {
            (
                balance_a
                    .checked_add(oracle_quote)
                    .ok_or(RebalancerError::Overflow)?,
                balance_b
                    .checked_sub(amount_to_swap)
                    .ok_or(RebalancerError::Overflow)?,
            )
        };
        let expected_total = expected_a
            .checked_add(expected_b)
            .ok_or(RebalancerError::Overflow)?;
        if expected_total > 0 {
            let expected_ratio_bps = Self::mul_div(expected_a, BPS_DENOMINATOR, expected_total)?
                .clamp(0, BPS_DENOMINATOR) as u32;
            if expected_ratio_bps.abs_diff(config.target_ratio_bps) >= recommendation.deviation_bps
            {
                return Err(RebalancerError::SwapDoesNotImproveRatio);
            }
        }

        let min_amount_out = Self::mul_div(
            oracle_quote,
            (BPS_DENOMINATOR as u32 - config.max_slippage_bps) as i128,
            BPS_DENOMINATOR,
        )?;
        if min_amount_out <= 0 {
            return Err(RebalancerError::OracleSlippageExceeded);
        }

        let deadline = env.ledger().sequence().saturating_add(100);

        // `execute_swap` itself is a direct call from this contract, so it
        // is always authorized with no extra step. But `execute_swap`
        // internally calls the input token's `transfer(from: this
        // contract, ...)`, which is a call ONE LEVEL DEEPER than this
        // contract's own direct call, and that deeper call needs this
        // contract's `require_auth` to succeed. Soroban does not grant
        // that automatically (a contract does not "self-authorize"
        // arbitrary sub-calls just by being the address in question) —
        // `authorize_as_current_contract` must explicitly pre-authorize
        // that specific sub-invocation, naming the exact call it covers.
        env.authorize_as_current_contract(soroban_sdk::vec![
            &env,
            soroban_sdk::auth::InvokerContractAuthEntry::Contract(
                soroban_sdk::auth::SubContractInvocation {
                    context: soroban_sdk::auth::ContractContext {
                        contract: asset_in.clone(),
                        fn_name: Symbol::new(&env, "transfer"),
                        args: soroban_sdk::vec![
                            &env,
                            contract_address.clone().into_val(&env),
                            config.router.clone().into_val(&env),
                            amount_to_swap.into_val(&env),
                        ],
                    },
                    sub_invocations: soroban_sdk::vec![&env],
                }
            ),
        ]);

        let amount_out: i128 = env.invoke_contract(
            &config.router,
            &Symbol::new(&env, "execute_swap"),
            soroban_sdk::vec![
                &env,
                contract_address.clone().into_val(&env),
                path.into_val(&env),
                asset_in.into_val(&env),
                asset_out.into_val(&env),
                amount_to_swap.into_val(&env),
                min_amount_out.into_val(&env),
                deadline.into_val(&env),
            ],
        );

        let balance_a_after = token::Client::new(&env, &config.asset_a).balance(&contract_address);
        let balance_b_after = token::Client::new(&env, &config.asset_b).balance(&contract_address);

        RebalanceExecuted {
            balance_a_before: balance_a,
            balance_b_before: balance_b,
            balance_a_after,
            balance_b_after,
            amount_swapped: amount_to_swap,
            sold_asset_a: recommendation.direction == RebalanceDirection::SellAssetA,
        }
        .publish(&env);

        Ok(amount_out)
    }

    pub fn get_config(env: Env) -> Result<RebalancerConfig, RebalancerError> {
        Self::get_config_internal(&env)
    }

    /// Read-only preview of the current split and whether a rebalance would
    /// fire right now, with no state change and no swap.
    pub fn preview(env: Env) -> Result<(i128, i128, u32, bool), RebalancerError> {
        let config = Self::get_config_internal(&env)?;
        let recommendation = Self::recommend(&env, &config)?;
        Ok((
            recommendation.balance_a,
            recommendation.balance_b,
            recommendation.current_ratio_bps,
            recommendation.needed,
        ))
    }
}

impl RebalancerContract {
    /// Shared ratio math for `check_rebalance_needed`, `preview`, and
    /// `check_and_rebalance`. Keeping one implementation means the public
    /// recommendation and the trade actually executed can never disagree
    /// about direction or sizing.
    fn recommend(
        env: &Env,
        config: &RebalancerConfig,
    ) -> Result<RebalanceRecommendation, RebalancerError> {
        let contract_address = env.current_contract_address();
        let balance_a = token::Client::new(env, &config.asset_a).balance(&contract_address);
        let balance_b = token::Client::new(env, &config.asset_b).balance(&contract_address);
        let total = balance_a
            .checked_add(balance_b)
            .ok_or(RebalancerError::Overflow)?;

        if total <= 0 {
            return Ok(RebalanceRecommendation {
                needed: false,
                direction: RebalanceDirection::None,
                amount: 0,
                current_ratio_bps: 0,
                deviation_bps: 0,
                balance_a,
                balance_b,
                target_ratio_bps: config.target_ratio_bps,
            });
        }

        let current_ratio_bps =
            Self::mul_div(balance_a, BPS_DENOMINATOR, total)?.clamp(0, BPS_DENOMINATOR) as u32;
        let deviation_bps = current_ratio_bps.abs_diff(config.target_ratio_bps);
        let base = |direction, amount| RebalanceRecommendation {
            needed: false,
            direction,
            amount,
            current_ratio_bps,
            deviation_bps,
            balance_a,
            balance_b,
            target_ratio_bps: config.target_ratio_bps,
        };

        if deviation_bps <= config.imbalance_threshold_bps {
            return Ok(base(RebalanceDirection::None, 0));
        }

        // Size the trade from the current total so one call lands on target
        // without overshooting; the post-swap total changes with fees and
        // price impact, so a keeper can call again for tighter convergence.
        let target_a = Self::mul_div(total, config.target_ratio_bps as i128, BPS_DENOMINATOR)?;
        let (direction, amount) = if balance_a > target_a {
            (
                RebalanceDirection::SellAssetA,
                balance_a
                    .checked_sub(target_a)
                    .ok_or(RebalancerError::Overflow)?,
            )
        } else {
            let target_b = total
                .checked_sub(target_a)
                .ok_or(RebalancerError::Overflow)?;
            (
                RebalanceDirection::SellAssetB,
                balance_b
                    .checked_sub(target_b)
                    .ok_or(RebalancerError::Overflow)?,
            )
        };

        if amount <= 0 {
            return Ok(base(RebalanceDirection::None, 0));
        }

        Ok(RebalanceRecommendation {
            needed: true,
            direction,
            amount,
            current_ratio_bps,
            deviation_bps,
            balance_a,
            balance_b,
            target_ratio_bps: config.target_ratio_bps,
        })
    }

    fn get_config_internal(env: &Env) -> Result<RebalancerConfig, RebalancerError> {
        env.storage()
            .instance()
            .get(&CONFIG)
            .ok_or(RebalancerError::NotInitialized)
    }

    /// `(a * b) / divisor`, guarding overflow via a checked multiply and a
    /// divide-then-multiply-remainder fallback (matching this workspace's
    /// existing `router::check_slippage`'s checked-arithmetic style) rather
    /// than assuming the direct product fits `i128`.
    fn mul_div(a: i128, b: i128, divisor: i128) -> Result<i128, RebalancerError> {
        if divisor <= 0 {
            return Err(RebalancerError::Overflow);
        }
        if let Some(product) = a.checked_mul(b) {
            return product
                .checked_div(divisor)
                .ok_or(RebalancerError::Overflow);
        }
        let q = a / divisor;
        let r = a % divisor;
        let part1 = q.checked_mul(b).ok_or(RebalancerError::Overflow)?;
        let part2 = r
            .checked_mul(b)
            .ok_or(RebalancerError::Overflow)?
            .checked_div(divisor)
            .ok_or(RebalancerError::Overflow)?;
        part1.checked_add(part2).ok_or(RebalancerError::Overflow)
    }
}

#[cfg(test)]
mod test;
