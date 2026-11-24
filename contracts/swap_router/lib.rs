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

/// Emitted once a swap has settled: who funded it, what was swapped and how
/// far execution drifted from the pools' quotes.
#[contractevent(topics = ["swap_executed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapExecuted {
    /// Address that authorised and funded the swap.
    #[topic]
    pub caller: Address,
    /// Input token taken from the caller (first hop's `asset_in`).
    pub token_in: Address,
    /// Output token delivered to the recipient (last hop's `asset_out`).
    pub token_out: Address,
    /// Exact amount taken from the caller.
    pub amount_in: i128,
    /// Amount delivered to the recipient.
    pub amount_out: i128,
    /// Largest per-hop shortfall against the pool quote, in basis points.
    /// Zero when every hop executed at or above its quote.
    pub slippage_bps: u32,
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
        let mut slippage_bps: u32 = 0;
        for step in params.path.iter() {
            let expected = Self::hop_quote(&env, &step, current_amount)?;
            let hop_min = Self::hop_floor(expected)?;

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
            slippage_bps = slippage_bps.max(Self::shortfall_bps(expected, amount_out)?);
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
            token_in: first_step.asset_in,
            token_out: last_step.asset_out,
            amount_in: params.amount_in,
            amount_out: current_amount,
            slippage_bps,
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

    /// Ask `step.pool` for the output it expects for `amount_in`.
    fn hop_quote(env: &Env, step: &SwapStep, amount_in: i128) -> Result<i128, SwapError> {
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
        Ok(expected)
    }

    /// Per-hop minimum: the quoted amount minus [`MAX_HOP_SLIPPAGE_BPS`] of
    /// headroom. Never zero, so dust inputs stay bound.
    fn hop_floor(expected: i128) -> Result<i128, SwapError> {
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

    /// Shortfall of `actual` against `expected`, in basis points (0 when the
    /// hop met or beat its quote).
    fn shortfall_bps(expected: i128, actual: i128) -> Result<u32, SwapError> {
        if actual >= expected {
            return Ok(0);
        }
        let shortfall = (expected - actual)
            .checked_mul(BPS)
            .and_then(|value| value.checked_div(expected))
            .ok_or(SwapError::InvalidAmount)?;
        u32::try_from(shortfall).map_err(|_| SwapError::InvalidAmount)
    }
}

#[cfg(test)]
#[path = "src/test.rs"]
mod test;
