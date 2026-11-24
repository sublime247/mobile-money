//! Unit tests for the swap router.

extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Events, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    xdr::{ContractEventBody, ScMap, ScVal},
    Env,
};

const QBPS: Symbol = symbol_short!("QBPS");
const EBPS: Symbol = symbol_short!("EBPS");

/// Deterministic mock pool.
///
/// `get_quote` reports `quote_bps` while `swap` executes at `exec_bps`, so
/// tests can force the two apart. `swap` deliberately ignores the
/// `min_amount_out` argument it is handed: the router must protect itself
/// rather than trusting every pool to enforce the floor.
#[contract]
struct MockPool;

#[contractimpl]
impl MockPool {
    pub fn init(env: Env, quote_bps: i128, exec_bps: i128) {
        env.storage().instance().set(&QBPS, &quote_bps);
        env.storage().instance().set(&EBPS, &exec_bps);
    }

    pub fn get_quote(env: Env, _asset_in: Address, _asset_out: Address, amount_in: i128) -> i128 {
        let quote_bps: i128 = env.storage().instance().get(&QBPS).unwrap_or(10_000);
        amount_in * quote_bps / BPS
    }

    pub fn swap(
        env: Env,
        _asset_in: Address,
        asset_out: Address,
        amount_in: i128,
        _min_amount_out: i128,
        recipient: Address,
    ) -> i128 {
        let exec_bps: i128 = env.storage().instance().get(&EBPS).unwrap_or(10_000);
        let amount_out = amount_in * exec_bps / BPS;
        token::Client::new(&env, &asset_out).transfer(
            &env.current_contract_address(),
            &recipient,
            &amount_out,
        );
        amount_out
    }
}

/// Everything a swap test needs: three assets, two priced pools, a funded
/// caller and the router under test.
struct Fixture {
    env: Env,
    caller: Address,
    recipient: Address,
    asset_a: Address,
    asset_b: Address,
    asset_c: Address,
    pool_ab: Address,
    pool_bc: Address,
    client: SwapRouterClient<'static>,
}

/// @param hop1_bps / hop2_bps: `exec_bps` actually paid by each pool
/// (their `get_quote` always reports 9 900 bps, i.e. a 1 % pool fee).
fn setup(hop1_bps: i128, hop2_bps: i128) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(10);

    let admin = Address::generate(&env);
    let caller = Address::generate(&env);
    let recipient = Address::generate(&env);

    let asset_a = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let asset_b = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let asset_c = env.register_stellar_asset_contract_v2(admin).address();

    let pool_ab = env.register(MockPool, ());
    let pool_bc = env.register(MockPool, ());
    MockPoolClient::new(&env, &pool_ab).init(&9_900, &hop1_bps);
    MockPoolClient::new(&env, &pool_bc).init(&9_900, &hop2_bps);

    // Fund the caller with input tokens and both pools with output tokens.
    StellarAssetClient::new(&env, &asset_a).mint(&caller, &1_000_000);
    StellarAssetClient::new(&env, &asset_b).mint(&pool_ab, &1_000_000);
    StellarAssetClient::new(&env, &asset_c).mint(&pool_bc, &1_000_000);

    let router = env.register(SwapRouter, ());
    let client = SwapRouterClient::new(&env, &router);

    Fixture {
        env,
        caller,
        recipient,
        asset_a,
        asset_b,
        asset_c,
        pool_ab,
        pool_bc,
        client,
    }
}

impl Fixture {
    fn step(&self, pool: &Address, asset_in: &Address, asset_out: &Address) -> SwapStep {
        SwapStep {
            pool: pool.clone(),
            asset_in: asset_in.clone(),
            asset_out: asset_out.clone(),
        }
    }

    fn two_hop_path(&self) -> Vec<SwapStep> {
        let mut path = Vec::new(&self.env);
        path.push_back(self.step(&self.pool_ab, &self.asset_a, &self.asset_b));
        path.push_back(self.step(&self.pool_bc, &self.asset_b, &self.asset_c));
        path
    }

    fn params(
        &self,
        path: Vec<SwapStep>,
        amount_in: i128,
        min_amount_out: i128,
        deadline: u32,
    ) -> SwapParams {
        SwapParams {
            path,
            amount_in,
            min_amount_out,
            recipient: self.recipient.clone(),
            deadline,
        }
    }
}

// ── Happy path ──────────────────────────────────────────────────────────

#[test]
fn test_swap_multi_hop_executes_within_deadline() {
    let fx = setup(9_900, 9_900);
    // 1_000_000 -> 990_000 (hop 1) -> 980_100 (hop 2)
    let params = fx.params(fx.two_hop_path(), 1_000_000, 980_000, 20);

    let out = fx.client.swap(&fx.caller, &params);
    assert_eq!(out, 980_100);

    let recipient_balance = TokenClient::new(&fx.env, &fx.asset_c).balance(&fx.recipient);
    assert_eq!(recipient_balance, 980_100);
}

#[test]
fn test_quote_matches_executed_output() {
    let fx = setup(9_900, 9_900);
    let path = fx.two_hop_path();
    assert_eq!(fx.client.quote(&path, &1_000_000), 980_100);
}

// ── Deadline checks ─────────────────────────────────────────────────────

#[test]
fn test_swap_reverts_when_deadline_reached() {
    let fx = setup(9_900, 9_900);
    // Current sequence is 10, so a deadline of 10 is already in the past.
    let params = fx.params(fx.two_hop_path(), 1_000_000, 900_000, 10);

    let res = fx.client.try_swap(&fx.caller, &params);
    assert_eq!(res, Err(Ok(SwapError::DeadlineExceeded)));

    // Nothing moved: the caller still holds every input token.
    let caller_balance = TokenClient::new(&fx.env, &fx.asset_a).balance(&fx.caller);
    assert_eq!(caller_balance, 1_000_000);
}

#[test]
fn test_swap_reverts_on_unset_deadline() {
    let fx = setup(9_900, 9_900);
    let params = fx.params(fx.two_hop_path(), 1_000_000, 900_000, 0);

    let res = fx.client.try_swap(&fx.caller, &params);
    assert_eq!(res, Err(Ok(SwapError::InvalidDeadline)));
}

// ── Slippage protection ─────────────────────────────────────────────────

#[test]
fn test_swap_reverts_when_final_output_below_min_amount_out() {
    let fx = setup(9_900, 9_900);
    // Actual output is 980_100 — ask for more than the pools can pay.
    let params = fx.params(fx.two_hop_path(), 1_000_000, 990_000, 20);

    let res = fx.client.try_swap(&fx.caller, &params);
    assert_eq!(res, Err(Ok(SwapError::SlippageExceeded)));

    let caller_balance = TokenClient::new(&fx.env, &fx.asset_a).balance(&fx.caller);
    assert_eq!(caller_balance, 1_000_000);
}

#[test]
fn test_swap_reverts_when_intermediate_hop_slips() {
    // Hop 1 behaves (99 % of quote); hop 2 pays out at 50 % of its quote,
    // i.e. it ignores the floor the router handed it.
    let fx = setup(9_900, 5_000);
    let params = fx.params(fx.two_hop_path(), 1_000_000, 100_000, 20);

    let res = fx.client.try_swap(&fx.caller, &params);
    assert_eq!(res, Err(Ok(SwapError::SlippageExceeded)));
}

#[test]
fn test_swap_allows_small_slippage_within_tolerance() {
    // Hop 2 pays 99 % of its quote — exactly at MAX_HOP_SLIPPAGE_BPS.
    let fx = setup(9_900, 9_801);
    let params = fx.params(fx.two_hop_path(), 1_000_000, 900_000, 20);

    let out = fx.client.swap(&fx.caller, &params);
    // Hop 2 quotes 980_100 and pays 970_299 — exactly its 1 % floor.
    assert_eq!(out, 970_299);
}

// ── Input validation ────────────────────────────────────────────────────

#[test]
fn test_swap_reverts_on_empty_path() {
    let fx = setup(9_900, 9_900);
    let params = fx.params(Vec::new(&fx.env), 1_000_000, 1, 20);

    let res = fx.client.try_swap(&fx.caller, &params);
    assert_eq!(res, Err(Ok(SwapError::EmptyPath)));
}

#[test]
fn test_swap_reverts_on_non_positive_amounts() {
    let fx = setup(9_900, 9_900);

    let zero_in = fx.params(fx.two_hop_path(), 0, 1, 20);
    assert_eq!(
        fx.client.try_swap(&fx.caller, &zero_in),
        Err(Ok(SwapError::InvalidAmount))
    );

    let zero_min = fx.params(fx.two_hop_path(), 1_000_000, 0, 20);
    assert_eq!(
        fx.client.try_swap(&fx.caller, &zero_min),
        Err(Ok(SwapError::InvalidAmount))
    );
}

/// Read a `u32` field from the most recent contract event's data map.
fn last_event_u32(env: &Env, field: &str) -> Option<u32> {
    let events = env.events().all();
    let event = events.events().last()?;
    let ContractEventBody::V0(body) = &event.body;
    let ScVal::Map(Some(ScMap(entries))) = &body.data else {
        return None;
    };
    entries
        .iter()
        .find_map(|entry| match (&entry.key, &entry.val) {
            (ScVal::Symbol(key), ScVal::U32(value)) if key.0.as_slice() == field.as_bytes() => {
                Some(*value)
            }
            _ => None,
        })
}

// ── Out-of-tolerance executions ────────────────────────────────────────────

#[test]
fn test_swap_reverts_when_first_hop_exceeds_tolerance() {
    // Hop 1 pays 98 % of its quote, below the 99 % floor the router enforces.
    let fx = setup(9_800, 9_900);
    let params = fx.params(fx.two_hop_path(), 1_000_000, 900_000, 20);

    let res = fx.client.try_swap(&fx.caller, &params);
    assert_eq!(res, Err(Ok(SwapError::SlippageExceeded)));

    let caller_balance = TokenClient::new(&fx.env, &fx.asset_a).balance(&fx.caller);
    assert_eq!(caller_balance, 1_000_000);
}

#[test]
fn test_swap_reverts_just_past_tolerance() {
    // Hop 2 quotes 980_100 and its floor is 970_299. Paying 9_800 bps of the
    // hop input yields 970_200, just under that floor.
    let fx = setup(9_900, 9_800);
    let params = fx.params(fx.two_hop_path(), 1_000_000, 900_000, 20);

    let res = fx.client.try_swap(&fx.caller, &params);
    assert_eq!(res, Err(Ok(SwapError::SlippageExceeded)));
}

// ── SwapExecuted event ─────────────────────────────────────────────────────

#[test]
fn test_event_reports_zero_slippage_at_quote() {
    let fx = setup(9_900, 9_900);
    let params = fx.params(fx.two_hop_path(), 1_000_000, 900_000, 20);

    fx.client.swap(&fx.caller, &params);
    assert_eq!(last_event_u32(&fx.env, "slippage_bps"), Some(0));
}

#[test]
fn test_event_reports_effective_slippage_within_tolerance() {
    // Hop 2 pays 970_299 against a quote of 980_100: exactly 100 bps short.
    let fx = setup(9_900, 9_801);
    let params = fx.params(fx.two_hop_path(), 1_000_000, 900_000, 20);

    fx.client.swap(&fx.caller, &params);
    assert_eq!(last_event_u32(&fx.env, "slippage_bps"), Some(100));
}

#[test]
fn test_event_slippage_is_worst_hop_not_sum() {
    // Hop 1 pays 985_000 against a 990_000 quote (50 bps short). Hop 2 pays
    // 966_285 against 975_150 (90 bps short). The event reports the worst hop
    // (90), not the 140 total.
    let fx = setup(9_850, 9_810);
    let params = fx.params(fx.two_hop_path(), 1_000_000, 900_000, 20);

    let out = fx.client.swap(&fx.caller, &params);
    assert_eq!(out, 966_285);
    assert_eq!(last_event_u32(&fx.env, "slippage_bps"), Some(90));
}
