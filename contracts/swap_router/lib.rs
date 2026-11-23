//! Soroban Liquidity Pool Swap Router Contract
//! Routes swaps across multiple pools atomically to minimize slippage.
//! SPDX-License-Identifier: Apache-2.0

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env,
    IntoVal, Symbol, Vec,
};

/// Basis-point denominator used by every slippage computation.
const BPS: i128 = 10_000;

/// Maximum slippage tolerated on a single hop, expressed in basis points.
///
/// Every hop is quoted by its own pool (`get_quote`) immediately before it is
/// executed. The router then refuses to accept an output that is more than
/// this many basis points below that quote, both by passing the derived floor
/// to the pool as `min_amount_out` and by re-checking the returned amount.
/// This catches a stale, mispriced or malicious pool on an intermediate hop
/// instead of letting the damage propagate to the final output only.
pub const MAX_HOP_SLIPPAGE_BPS: u32 = 100;

/// Contract-level errors surfaced via the Soroban SDK error-code mechanism so
/// callers can distinguish *why* a swap was rejected.
#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum SwapError {
    /// The current ledger sequence has reached or passed `deadline`.
    DeadlineExceeded = 1,
    /// `deadline` was not set (zero), which would always be in the past.
    InvalidDeadline = 2,
    /// The swap path contains no hops.
    EmptyPath = 3,
    /// `amount_in` / `min_amount_out` is zero or negative, or a pool quoted a
    /// non-positive output.
    InvalidAmount = 4,
    /// Slippage exceeded: a hop (or the whole path) produced less than the
    /// enforced minimum output.
    SlippageExceeded = 5,
}

#[contracttype]
#[derive(Clone)]
pub struct SwapStep {
    /// The liquidity pool contract address to route through
    pub pool: Address,
    /// Input asset address
    pub asset_in: Address,
    /// Output asset address
    pub asset_out: Address,
}

#[contracttype]
#[derive(Clone)]
pub struct SwapParams {
    /// Ordered list of swap steps (multi-hop path)
    pub path: Vec<SwapStep>,
    /// Exact amount to swap in
    pub amount_in: i128,
    /// Minimum amount to receive (slippage protection)
    pub min_amount_out: i128,
    /// Recipient of the final output token
    pub recipient: Address,
    /// Deadline ledger sequence — transaction reverts if current >= deadline
    pub deadline: u32,
}

/// Emitted once a swap has settled: who funded it and what came out.
#[contractevent(topics = ["swap_executed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapExecuted {
    /// Address that authorised and funded the swap.
    #[topic]
    pub caller: Address,
    /// Exact amount taken from the caller.
    pub amount_in: i128,
    /// Amount delivered to the recipient.
    pub amount_out: i128,
}

#[contract]
pub struct SwapRouter;

#[contractimpl]
impl SwapRouter {
    /// Execute a multi-hop swap atomically.
    ///
    /// Steps through each pool in `params.path`, routing the output of each
    /// step as the input of the next. Reverts the entire transaction if:
    /// - The deadline is unset or has passed (checked before any funds move)
    /// - Any single hop returns less than its own quote minus
    ///   [`MAX_HOP_SLIPPAGE_BPS`] (slippage protection)
    /// - The final output is less than `min_amount_out` (slippage exceeded)
    /// - Any intermediate pool call fails
    pub fn swap(env: Env, caller: Address, params: SwapParams) -> Result<i128, SwapError> {
        caller.require_auth();

        // ── Deadline check ──────────────────────────────────────────────────
        // Runs before the first token transfer so an expired transaction can
        // never pull funds out of the caller's wallet.
        if params.deadline == 0 {
            return Err(SwapError::InvalidDeadline);
        }
        if env.ledger().sequence() >= params.deadline {
            return Err(SwapError::DeadlineExceeded);
        }

        if params.path.is_empty() {
            return Err(SwapError::EmptyPath);
        }
        if params.amount_in <= 0 {
            return Err(SwapError::InvalidAmount);
        }
        if params.min_amount_out <= 0 {
            return Err(SwapError::InvalidAmount);
        }

        let mut current_amount = params.amount_in;

        // Transfer initial tokens from caller to this contract
        let first_step = params.path.get(0).ok_or(SwapError::EmptyPath)?;
        let input_token = token::Client::new(&env, &first_step.asset_in);
        input_token.transfer(&caller, env.current_contract_address(), &current_amount);

        // Execute each hop with per-hop slippage protection.
        for step in params.path.iter() {
            let hop_min = Self::hop_minimum(&env, &step, current_amount)?;

            let amount_out: i128 = env.invoke_contract(
                &step.pool,
                &Symbol::new(&env, "swap"),
                soroban_sdk::vec![
                    &env,
                    step.asset_in.clone().into_val(&env),
                    step.asset_out.clone().into_val(&env),
                    current_amount.into_val(&env),
                    hop_min.into_val(&env),
                    env.current_contract_address().into_val(&env),
                ],
            );

            // Pools are expected to honour `min_amount_out`; verify anyway so
            // a pool that ignores it cannot underpay an intermediate hop.
            if amount_out < hop_min {
                return Err(SwapError::SlippageExceeded);
            }
            current_amount = amount_out;
        }

        // Slippage protection: final output must meet minimum
        if current_amount < params.min_amount_out {
            return Err(SwapError::SlippageExceeded);
        }

        // Transfer output to recipient
        let last_step = params.path.last().ok_or(SwapError::EmptyPath)?;
        let output_token = token::Client::new(&env, &last_step.asset_out);
        output_token.transfer(
            &env.current_contract_address(),
            &params.recipient,
            &current_amount,
        );

        env.events().publish_event(&SwapExecuted {
            caller,
            amount_in: params.amount_in,
            amount_out: current_amount,
        });

        Ok(current_amount)
    }

    /// Simulate a swap without executing it.
    /// Returns the expected output amount for the given path and input.
    pub fn quote(env: Env, path: Vec<SwapStep>, amount_in: i128) -> i128 {
        let mut current = amount_in;
        for step in path.iter() {
            current = env.invoke_contract::<i128>(
                &step.pool,
                &Symbol::new(&env, "get_quote"),
                soroban_sdk::vec![
                    &env,
                    step.asset_in.clone().into_val(&env),
                    step.asset_out.clone().into_val(&env),
                    current.into_val(&env),
                ],
            );
        }
        current
    }

    /// Ask `step.pool` for its expected output and derive the per-hop
    /// minimum: the quoted amount minus [`MAX_HOP_SLIPPAGE_BPS`] of headroom.
    fn hop_minimum(env: &Env, step: &SwapStep, amount_in: i128) -> Result<i128, SwapError> {
        if amount_in <= 0 {
            return Err(SwapError::InvalidAmount);
        }

        let expected: i128 = env.invoke_contract(
            &step.pool,
            &Symbol::new(env, "get_quote"),
            soroban_sdk::vec![
                env,
                step.asset_in.clone().into_val(env),
                step.asset_out.clone().into_val(env),
                amount_in.into_val(env),
            ],
        );

        if expected <= 0 {
            return Err(SwapError::InvalidAmount);
        }

        let keep = BPS
            .checked_sub(MAX_HOP_SLIPPAGE_BPS as i128)
            .ok_or(SwapError::InvalidAmount)?;
        let floor = expected
            .checked_mul(keep)
            .and_then(|value| value.checked_div(BPS))
            .ok_or(SwapError::InvalidAmount)?;

        // Never hand a pool a zero minimum — dust inputs must still be bound.
        Ok(if floor > 0 { floor } else { 1 })
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use soroban_sdk::{
        contract, contractimpl, symbol_short,
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
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

        pub fn get_quote(
            env: Env,
            _asset_in: Address,
            _asset_out: Address,
            amount_in: i128,
        ) -> i128 {
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
}
