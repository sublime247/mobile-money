extern crate std;

use super::*;
use soroban_sdk::symbol_short;
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::Event;

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
    pub fn set_rate_bps(env: Env, rate_bps: u32) {
        env.storage()
            .instance()
            .set(&symbol_short!("RATE"), &rate_bps);
    }

    pub fn get_rate(env: Env, _asset_in: Address, _asset_out: Address, amount_in: i128) -> i128 {
        let rate_bps: u32 = env
            .storage()
            .instance()
            .get(&symbol_short!("RATE"))
            .unwrap_or(10_000);
        amount_in * rate_bps as i128 / 10_000
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
    oracle_id: Address,
    bot: Address,
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
    let bot = Address::generate(env);
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
    client.authorize_rebalancer_bot(&bot);

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
        oracle_id,
        bot,
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

    let result = setup.client.check_and_rebalance(&setup.bot);
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

    let received = setup.client.check_and_rebalance(&setup.bot);

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

    setup.client.check_and_rebalance(&setup.bot);

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

    let received = setup.client.check_and_rebalance(&setup.bot);
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

    let received = setup.client.check_and_rebalance(&setup.bot);
    assert!(received > 0);
}

#[test]
fn check_and_rebalance_errors_when_both_balances_are_zero() {
    let env = Env::default();
    let setup = setup(&env, 5_000, 0, 0);

    let result = setup.client.try_check_and_rebalance(&setup.bot);
    assert_eq!(result, Err(Ok(RebalancerError::NothingToRebalance)));
}

#[test]
fn unauthorized_bot_cannot_trigger_a_rebalance() {
    let env = Env::default();
    let setup = setup(&env, 6_000, 70 * UNIT, 30 * UNIT);
    let rogue = Address::generate(&env);

    assert_eq!(
        setup.client.try_check_and_rebalance(&rogue),
        Err(Ok(RebalancerError::UnauthorizedRebalancer))
    );
    assert_eq!(
        token::Client::new(&env, &setup.asset_a).balance(&setup.contract_id),
        70 * UNIT
    );
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

#[test]
fn check_rebalance_needed_reports_direction_and_exact_trade_size() {
    let env = Env::default();

    // 70/30 with a 60/40 target: sell 10 units of asset_a.
    let overweight_a = setup(&env, 6_000, 70 * UNIT, 30 * UNIT);
    let recommendation = overweight_a.client.check_rebalance_needed();
    assert!(recommendation.needed);
    assert_eq!(recommendation.direction, RebalanceDirection::SellAssetA);
    assert_eq!(recommendation.amount, 10 * UNIT);
    assert_eq!(recommendation.current_ratio_bps, 7_000);
    assert_eq!(recommendation.deviation_bps, 1_000);
    assert_eq!(recommendation.balance_a, 70 * UNIT);
    assert_eq!(recommendation.balance_b, 30 * UNIT);
    assert_eq!(recommendation.target_ratio_bps, 6_000);

    // 40/60 with the same target: sell 20 units of asset_b.
    let overweight_b = setup(&env, 6_000, 40 * UNIT, 60 * UNIT);
    let recommendation = overweight_b.client.check_rebalance_needed();
    assert!(recommendation.needed);
    assert_eq!(recommendation.direction, RebalanceDirection::SellAssetB);
    assert_eq!(recommendation.amount, 20 * UNIT);
    assert_eq!(recommendation.deviation_bps, 2_000);
}

#[test]
fn check_rebalance_needed_is_false_within_threshold_and_when_empty() {
    let env = Env::default();

    let within = setup(&env, 6_000, 62 * UNIT, 38 * UNIT);
    let recommendation = within.client.check_rebalance_needed();
    assert!(!recommendation.needed);
    assert_eq!(recommendation.direction, RebalanceDirection::None);
    assert_eq!(recommendation.amount, 0);
    assert_eq!(recommendation.deviation_bps, 200);

    let empty = setup(&env, 5_000, 0, 0);
    let recommendation = empty.client.check_rebalance_needed();
    assert!(!recommendation.needed);
    assert_eq!(recommendation.direction, RebalanceDirection::None);
    assert_eq!(recommendation.amount, 0);
    assert_eq!(recommendation.current_ratio_bps, 0);
}

#[test]
fn rebalancer_bot_allowlist_is_admin_controlled() {
    let env = Env::default();
    let setup = setup(&env, 6_000, 70 * UNIT, 30 * UNIT);
    let second_bot = Address::generate(&env);

    env.set_auths(&[]);
    assert!(setup
        .client
        .try_authorize_rebalancer_bot(&second_bot)
        .is_err());

    env.mock_all_auths_allowing_non_root_auth();
    setup.client.authorize_rebalancer_bot(&second_bot);
    assert!(setup.client.is_authorized_rebalancer_bot(&second_bot));
    assert_eq!(
        setup.client.try_check_and_rebalance(&second_bot),
        Ok(Ok(10 * UNIT))
    );

    setup.client.revoke_rebalancer_bot(&second_bot);
    assert!(!setup.client.is_authorized_rebalancer_bot(&second_bot));
    assert_eq!(
        setup.client.try_check_and_rebalance(&second_bot),
        Err(Ok(RebalancerError::UnauthorizedRebalancer))
    );
}

#[test]
fn rebalance_needed_alert_is_emitted_before_the_swap() {
    let env = Env::default();
    let setup = setup(&env, 6_000, 70 * UNIT, 30 * UNIT);

    setup.client.check_and_rebalance(&setup.bot);

    let expected = RebalanceNeeded {
        current_ratio_bps: 7_000,
        target_ratio_bps: 6_000,
        deviation_bps: 1_000,
        direction: RebalanceDirection::SellAssetA,
        recommended_amount: 10 * UNIT,
    };
    let emitted = env.events().all().filter_by_contract(&setup.contract_id);
    assert_eq!(
        emitted.events().first(),
        Some(&expected.to_xdr(&env, &setup.contract_id))
    );
}

#[test]
fn swap_is_rejected_when_it_would_not_reduce_deviation() {
    let env = Env::default();
    let setup = setup(&env, 6_000, 70 * UNIT, 30 * UNIT);
    // Quoting 3x makes the post-swap split 60/60 — 50% asset_a, which is
    // exactly as far from the 60% target as the original 70% was.
    MockOracleClient::new(&env, &setup.oracle_id).set_rate_bps(&30_000);

    assert_eq!(
        setup.client.try_check_and_rebalance(&setup.bot),
        Err(Ok(RebalancerError::SwapDoesNotImproveRatio))
    );
    assert_eq!(
        token::Client::new(&env, &setup.asset_a).balance(&setup.contract_id),
        70 * UNIT
    );
}

#[test]
fn a_zero_oracle_quote_cannot_pass_the_slippage_guard() {
    let env = Env::default();
    let setup = setup(&env, 6_000, 70 * UNIT, 30 * UNIT);
    MockOracleClient::new(&env, &setup.oracle_id).set_rate_bps(&0);

    assert_eq!(
        setup.client.try_check_and_rebalance(&setup.bot),
        Err(Ok(RebalancerError::OracleSlippageExceeded))
    );
}

#[test]
fn thresholds_outside_basis_point_range_are_rejected() {
    let env = Env::default();
    let setup = setup(&env, 6_000, 60 * UNIT, 40 * UNIT);

    assert_eq!(
        setup.client.try_configure_thresholds(&10_001, &100),
        Err(Ok(RebalancerError::InvalidThresholds))
    );
    assert_eq!(
        setup.client.try_configure_thresholds(&500, &10_001),
        Err(Ok(RebalancerError::InvalidThresholds))
    );
    assert_eq!(setup.client.get_config().imbalance_threshold_bps, 500);
}
