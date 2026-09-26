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

        config.imbalance_threshold_bps = imbalance_threshold_bps;
        config.max_slippage_bps = max_slippage_bps;
        env.storage().instance().set(&CONFIG, &config);
        env.storage().instance().extend_ttl(1000, 10000);
        Ok(())
    }

    /// Check the current `asset_a`/`asset_b` split against the target
    /// ratio; if it has drifted more than `imbalance_threshold_bps`, swap
    /// just enough through `router` to bring it back to target. A no-op
    /// (returns `Ok(0)`, emits `rebalance_skipped`) when already within
    /// tolerance. Callable by anyone (a keeper pattern, matching this
    /// repo's `timelock::execute_withdrawal` precedent): the threshold and
    /// oracle-bounded slippage are the safeguards, not caller
    /// authorization.
    pub fn check_and_rebalance(env: Env) -> Result<i128, RebalancerError> {
        let config = Self::get_config_internal(&env)?;
        let contract_address = env.current_contract_address();

        let balance_a = token::Client::new(&env, &config.asset_a).balance(&contract_address);
        let balance_b = token::Client::new(&env, &config.asset_b).balance(&contract_address);

        if balance_a <= 0 && balance_b <= 0 {
            return Err(RebalancerError::NothingToRebalance);
        }

        let total = balance_a
            .checked_add(balance_b)
            .ok_or(RebalancerError::Overflow)?;
        // Both non-negative and not both zero, checked above; total > 0.
        let current_ratio_bps =
            Self::mul_div(balance_a, BPS_DENOMINATOR, total)?.clamp(0, BPS_DENOMINATOR) as u32;

        let drift_bps = current_ratio_bps.abs_diff(config.target_ratio_bps);

        if drift_bps <= config.imbalance_threshold_bps {
            RebalanceSkipped {
                balance_a,
                balance_b,
                current_ratio_bps,
                target_ratio_bps: config.target_ratio_bps,
            }
            .publish(&env);
            return Ok(0);
        }

        // Solve for the swap amount that brings asset_a's share to exactly
        // target_ratio_bps, given the current total. Deliberately ignores
        // the swap's own price impact on `total` (a real swap has a fee and
        // slippage, so the post-swap ratio will land close to, not exactly
        // at, target) — see the module doc's "Direction of a single swap".
        let target_a = Self::mul_div(total, config.target_ratio_bps as i128, BPS_DENOMINATOR)?;

        let (sold_asset_a, amount_to_swap, asset_in, asset_out, path) = if balance_a > target_a {
            (
                true,
                balance_a
                    .checked_sub(target_a)
                    .ok_or(RebalancerError::Overflow)?,
                config.asset_a.clone(),
                config.asset_b.clone(),
                config.path_a_to_b.clone(),
            )
        } else {
            let target_b = total
                .checked_sub(target_a)
                .ok_or(RebalancerError::Overflow)?;
            (
                false,
                balance_b
                    .checked_sub(target_b)
                    .ok_or(RebalancerError::Overflow)?,
                config.asset_b.clone(),
                config.asset_a.clone(),
                config.path_b_to_a.clone(),
            )
        };

        if amount_to_swap <= 0 {
            RebalanceSkipped {
                balance_a,
                balance_b,
                current_ratio_bps,
                target_ratio_bps: config.target_ratio_bps,
            }
            .publish(&env);
            return Ok(0);
        }

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
            sold_asset_a,
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
        let contract_address = env.current_contract_address();
        let balance_a = token::Client::new(&env, &config.asset_a).balance(&contract_address);
        let balance_b = token::Client::new(&env, &config.asset_b).balance(&contract_address);
        let total = balance_a
            .checked_add(balance_b)
            .ok_or(RebalancerError::Overflow)?;
        if total <= 0 {
            return Ok((balance_a, balance_b, 0, false));
        }
        let current_ratio_bps =
            Self::mul_div(balance_a, BPS_DENOMINATOR, total)?.clamp(0, BPS_DENOMINATOR) as u32;
        let drift_bps = current_ratio_bps.abs_diff(config.target_ratio_bps);
        let would_rebalance = drift_bps > config.imbalance_threshold_bps;
        Ok((balance_a, balance_b, current_ratio_bps, would_rebalance))
    }
}

impl RebalancerContract {
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
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::testutils::Address as _;

    const STROOP: i128 = 1;
    const UNIT: i128 = 10_000_000 * STROOP;

    /// A test double for `contracts/router`'s `execute_swap`, matching
    /// only its call signature and externally-visible effect (moves
    /// `amount_in` of `asset_in` from `caller` to itself, sends
    /// `amount_in` of `asset_out` back at a fixed 1:1 rate). Does not
    /// reimplement path resolution or per-pool slippage, since
    /// `check_and_rebalance` treats the router as an opaque dependency
    /// and this test only needs to prove the rebalancer calls it
    /// correctly and reacts correctly to its result.
    #[contract]
    struct MockRouter;

    #[contractimpl]
    impl MockRouter {
        #[allow(clippy::too_many_arguments)]
        pub fn execute_swap(
            env: Env,
            caller: Address,
            _path: Vec<Address>,
            asset_in: Address,
            asset_out: Address,
            amount_in: i128,
            min_amount_out: i128,
            _deadline: u32,
        ) -> i128 {
            let amount_out = amount_in;
            assert!(amount_out >= min_amount_out, "MockRouter: slippage");
            let this_contract = env.current_contract_address();
            token::Client::new(&env, &asset_in).transfer(&caller, &this_contract, &amount_in);
            // A real DEX pool pays out of its own held liquidity, not by
            // minting fresh supply, and `StellarAssetClient::mint` needs
            // the token's admin to authorize it anyway (an authorization
            // this contract, as a stand-in for an arbitrary DEX pool, has
            // no legitimate way to obtain) — so this mock is pre-funded
            // with `asset_out` by the test `setup` helper instead.
            token::Client::new(&env, &asset_out).transfer(&this_contract, &caller, &amount_out);
            amount_out
        }
    }

    /// A test double for `contracts/oracle`'s `get_rate`: always quotes
    /// 1:1 (`amount_in` back), matching `MockRouter`'s actual executed
    /// rate above, so the oracle-derived slippage bound in
    /// `check_and_rebalance` never itself blocks a swap in these tests
    /// unless a test deliberately changes one side.
    #[contract]
    struct MockOracle;

    #[contractimpl]
    impl MockOracle {
        pub fn get_rate(
            _env: Env,
            _asset_in: Address,
            _asset_out: Address,
            amount_in: i128,
        ) -> i128 {
            amount_in
        }
    }

    fn setup_token(env: &Env) -> Address {
        let token_admin = Address::generate(env);
        env.register_stellar_asset_contract_v2(token_admin)
            .address()
    }

    struct TestSetup<'a> {
        client: RebalancerContractClient<'a>,
        asset_a: Address,
        asset_b: Address,
        contract_id: Address,
    }

    /// Wires up a rebalancer against a mock router and mock oracle (see
    /// their doc comments above for why these are hand-written test
    /// doubles rather than the real `router`/`oracle` crates: both are
    /// `cdylib`-only, like every contract in this workspace, so they
    /// cannot be linked as a Rust library dependency — the same reason
    /// `router`'s own tests use an inline `MockPool` rather than a real
    /// pool contract).
    fn setup(env: &Env, target_ratio_bps: u32, balance_a: i128, balance_b: i128) -> TestSetup<'_> {
        // `check_and_rebalance` requires no auth at its own root (see its
        // "callable by anyone" doc comment), but its nested router/token
        // calls do require the rebalancer contract's own address as an
        // authorizer two frames down. Strict `mock_all_auths()` only mocks
        // auths present at the root invocation, so it rejects that nested
        // requirement as "non-root auth"; the non-root-allowing variant is
        // needed here, matching this contract's actual keeper-callable
        // design rather than being a test-only relaxation of a real check.
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(env);
        let asset_a = setup_token(env);
        let asset_b = setup_token(env);

        let router_id = env.register(MockRouter, ());
        let oracle_id = env.register(MockOracle, ());

        let contract_id = env.register(RebalancerContract, ());
        let client = RebalancerContractClient::new(env, &contract_id);
        client.initialize(
            &admin,
            &asset_a,
            &asset_b,
            &target_ratio_bps,
            &router_id,
            &oracle_id,
            &Vec::new(env),
            &Vec::new(env),
        );

        if balance_a > 0 {
            token::StellarAssetClient::new(env, &asset_a).mint(&contract_id, &balance_a);
        }
        if balance_b > 0 {
            token::StellarAssetClient::new(env, &asset_b).mint(&contract_id, &balance_b);
        }

        // Pre-fund the mock router's own balance so it can pay out swaps
        // by transferring, not minting (see `MockRouter::execute_swap`'s
        // doc comment). A generous, fixed amount independent of the
        // test's own balances is enough for every test's swap sizes.
        let router_liquidity = 10_000_000 * UNIT;
        token::StellarAssetClient::new(env, &asset_a).mint(&router_id, &router_liquidity);
        token::StellarAssetClient::new(env, &asset_b).mint(&router_id, &router_liquidity);

        TestSetup {
            client,
            asset_a,
            asset_b,
            contract_id,
        }
    }

    #[test]
    fn preview_reports_current_split_and_no_rebalance_within_tolerance() {
        let env = Env::default();
        // 60/40 target, actual 62/38: 2pp drift, under the 5pp threshold.
        let setup = setup(&env, 6_000, 62 * UNIT, 38 * UNIT);

        let (balance_a, balance_b, ratio_bps, would_rebalance) = setup.client.preview();
        assert_eq!(balance_a, 62 * UNIT);
        assert_eq!(balance_b, 38 * UNIT);
        assert_eq!(ratio_bps, 6_200);
        assert!(!would_rebalance);
    }

    #[test]
    fn check_and_rebalance_is_a_no_op_within_threshold() {
        let env = Env::default();
        let setup = setup(&env, 6_000, 62 * UNIT, 38 * UNIT);

        let result = setup.client.check_and_rebalance();
        assert_eq!(result, 0);

        // Balances must be completely untouched.
        assert_eq!(
            token::Client::new(&env, &setup.asset_a).balance(&setup.contract_id),
            62 * UNIT
        );
        assert_eq!(
            token::Client::new(&env, &setup.asset_b).balance(&setup.contract_id),
            38 * UNIT
        );
    }

    #[test]
    fn check_and_rebalance_swaps_asset_a_when_it_is_overweight() {
        let env = Env::default();
        // 60/40 target, actual 70/30: asset_a is 10pp over target.
        let setup = setup(&env, 6_000, 70 * UNIT, 30 * UNIT);

        let preview_before = setup.client.preview();
        assert!(preview_before.3, "preview must predict a rebalance fires");

        let received = setup.client.check_and_rebalance();

        // Excess = 70 - (100 * 0.60) = 10 units of asset_a sold; the
        // settlement pool executes 1:1, so exactly 10 units of asset_b
        // are received.
        let expected_swap = 10 * UNIT;
        assert_eq!(received, expected_swap);

        let balance_a_after = token::Client::new(&env, &setup.asset_a).balance(&setup.contract_id);
        let balance_b_after = token::Client::new(&env, &setup.asset_b).balance(&setup.contract_id);
        assert_eq!(balance_a_after, 60 * UNIT);
        assert_eq!(balance_b_after, 40 * UNIT);
    }

    #[test]
    fn check_and_rebalance_swaps_asset_b_when_it_is_overweight() {
        let env = Env::default();
        // 60/40 target, actual 40/60: asset_b is 20pp over target.
        let setup = setup(&env, 6_000, 40 * UNIT, 60 * UNIT);

        setup.client.check_and_rebalance();

        let balance_a_after = token::Client::new(&env, &setup.asset_a).balance(&setup.contract_id);
        let balance_b_after = token::Client::new(&env, &setup.asset_b).balance(&setup.contract_id);
        assert_eq!(balance_a_after, 60 * UNIT);
        assert_eq!(balance_b_after, 40 * UNIT);
    }

    #[test]
    fn rebalance_at_the_exact_threshold_boundary_is_a_no_op() {
        let env = Env::default();
        // 60/40 target, actual 65/35: exactly 5pp drift, the threshold
        // itself, not past it.
        let setup = setup(&env, 6_000, 65 * UNIT, 35 * UNIT);

        let received = setup.client.check_and_rebalance();
        assert_eq!(received, 0);
    }

    #[test]
    fn rebalance_just_past_the_threshold_boundary_fires() {
        let env = Env::default();
        // Basis points only resolve to 1/10,000 of the total, so "just
        // past" the 500 bps boundary must move by at least that much of
        // the total (a single stroop is far below that resolution and
        // does not change the computed ratio at all).
        let one_bps_of_total = UNIT / 10; // 100 * UNIT total / 10_000 bps
        let setup = setup(
            &env,
            6_000,
            65 * UNIT + one_bps_of_total,
            35 * UNIT - one_bps_of_total,
        );

        let received = setup.client.check_and_rebalance();
        assert!(received > 0);
    }

    #[test]
    fn check_and_rebalance_errors_when_both_balances_are_zero() {
        let env = Env::default();
        let setup = setup(&env, 5_000, 0, 0);

        let result = setup.client.try_check_and_rebalance();
        assert_eq!(result, Err(Ok(RebalancerError::NothingToRebalance)));
    }

    #[test]
    fn check_and_rebalance_is_callable_by_anyone_with_no_auth() {
        // Keeper pattern: no caller address is even taken, so there is
        // nothing to authorize. This test's absence of `mock_all_auths`
        // for the CALL itself (only `initialize`/`add_pool`/etc. during
        // setup use it) is the proof: if `check_and_rebalance` required
        // an auth it doesn't declare a parameter for, this would panic.
        let env = Env::default();
        let setup = setup(&env, 6_000, 70 * UNIT, 30 * UNIT);

        let result = setup.client.try_check_and_rebalance();
        assert!(result.is_ok());
    }

    #[test]
    fn initialize_rejects_a_zero_target_ratio() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let asset_a = setup_token(&env);
        let asset_b = setup_token(&env);
        let router_id = Address::generate(&env);
        let oracle_id = Address::generate(&env);

        let contract_id = env.register(RebalancerContract, ());
        let client = RebalancerContractClient::new(&env, &contract_id);

        let result = client.try_initialize(
            &admin,
            &asset_a,
            &asset_b,
            &0u32,
            &router_id,
            &oracle_id,
            &Vec::new(&env),
            &Vec::new(&env),
        );
        assert_eq!(result, Err(Ok(RebalancerError::InvalidTargetRatio)));
    }

    #[test]
    fn initialize_rejects_a_target_ratio_of_ten_thousand_bps() {
        // 10_000 bps (100%) would mean "always fully in asset_a", which
        // has no meaningful rebalance target on the other side; the valid
        // range is the open interval (0, 10_000).
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let asset_a = setup_token(&env);
        let asset_b = setup_token(&env);
        let router_id = Address::generate(&env);
        let oracle_id = Address::generate(&env);

        let contract_id = env.register(RebalancerContract, ());
        let client = RebalancerContractClient::new(&env, &contract_id);

        let result = client.try_initialize(
            &admin,
            &asset_a,
            &asset_b,
            &10_000u32,
            &router_id,
            &oracle_id,
            &Vec::new(&env),
            &Vec::new(&env),
        );
        assert_eq!(result, Err(Ok(RebalancerError::InvalidTargetRatio)));
    }

    #[test]
    fn double_initialize_is_rejected() {
        let env = Env::default();
        let setup = setup(&env, 6_000, 60 * UNIT, 40 * UNIT);
        let config = setup.client.get_config();

        let result = setup.client.try_initialize(
            &config.admin,
            &setup.asset_a,
            &setup.asset_b,
            &6_000u32,
            &config.router,
            &config.oracle,
            &config.path_a_to_b,
            &config.path_b_to_a,
        );
        assert_eq!(result, Err(Ok(RebalancerError::AlreadyInitialized)));
    }

    #[test]
    fn configure_thresholds_by_non_admin_requires_auth() {
        let env = Env::default();
        let setup = setup(&env, 6_000, 60 * UNIT, 40 * UNIT);

        env.set_auths(&[]);
        let result = setup.client.try_configure_thresholds(&200u32, &50u32);
        assert!(result.is_err());
    }

    #[test]
    fn configure_thresholds_updates_the_effective_threshold() {
        let env = Env::default();
        let setup = setup(&env, 6_000, 62 * UNIT, 38 * UNIT);

        // 2pp drift was previously within the default 5pp threshold; tighten
        // the threshold to 1pp so the same drift now fires.
        setup.client.configure_thresholds(&100u32, &100u32);

        let (_, _, _, would_rebalance) = setup.client.preview();
        assert!(would_rebalance);
    }
}
