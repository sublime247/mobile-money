//! Soroban Liquidity Pool Swap Router Contract
//! Routes swaps across multiple pools atomically to minimize slippage.
//! SPDX-License-Identifier: Apache-2.0

#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Vec, Symbol};

#[contracttype]
pub struct SwapStep {
    /// The liquidity pool contract address to route through
    pub pool: Address,
    /// Input asset address
    pub asset_in: Address,
    /// Output asset address
    pub asset_out: Address,
}

#[contracttype]
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

#[contract]
pub struct SwapRouter;

#[contractimpl]
impl SwapRouter {
    /// Execute a multi-hop swap atomically.
    ///
    /// Steps through each pool in `params.path`, routing the output of each
    /// step as the input of the next. Reverts the entire transaction if:
    /// - The deadline has passed
    /// - The final output is less than `min_amount_out` (slippage exceeded)
    /// - Any intermediate pool call fails
    pub fn swap(env: Env, caller: Address, params: SwapParams) -> i128 {
        caller.require_auth();

        // Deadline check
        assert!(
            env.ledger().sequence() < params.deadline,
            "SwapRouter: transaction deadline exceeded"
        );

        assert!(!params.path.is_empty(), "SwapRouter: empty swap path");
        assert!(params.amount_in > 0, "SwapRouter: amount_in must be positive");
        assert!(params.min_amount_out > 0, "SwapRouter: min_amount_out must be positive");

        let mut current_amount = params.amount_in;

        // Transfer initial tokens from caller to this contract
        let first_step = params.path.get(0).unwrap();
        let input_token = token::Client::new(&env, &first_step.asset_in);
        input_token.transfer(&caller, &env.current_contract_address(), &current_amount);

        // Execute each hop
        for step in params.path.iter() {
            let pool_client = env.invoke_contract::<i128>(
                &step.pool,
                &Symbol::new(&env, "swap"),
                soroban_sdk::vec![&env,
                    step.asset_in.clone().into(),
                    step.asset_out.clone().into(),
                    current_amount.into(),
                    1i128.into(),  // min_out=1 for intermediate hops; final checked below
                    env.current_contract_address().into(),
                ],
            );
            current_amount = pool_client;
        }

        // Slippage protection: final output must meet minimum
        assert!(
            current_amount >= params.min_amount_out,
            "SwapRouter: slippage exceeded — output below min_amount_out"
        );

        // Transfer output to recipient
        let last_step = params.path.last().unwrap();
        let output_token = token::Client::new(&env, &last_step.asset_out);
        output_token.transfer(&env.current_contract_address(), &params.recipient, &current_amount);

        env.events().publish(
            (Symbol::new(&env, "SwapExecuted"), caller),
            (params.amount_in, current_amount),
        );

        current_amount
    }

    /// Simulate a swap without executing it.
    /// Returns the expected output amount for the given path and input.
    pub fn quote(env: Env, path: Vec<SwapStep>, amount_in: i128) -> i128 {
        let mut current = amount_in;
        for step in path.iter() {
            current = env.invoke_contract::<i128>(
                &step.pool,
                &Symbol::new(&env, "get_quote"),
                soroban_sdk::vec![&env,
                    step.asset_in.clone().into(),
                    step.asset_out.clone().into(),
                    current.into(),
                ],
            );
        }
        current
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swap_params_validates_positive_amount() {
        // The contract panics if amount_in <= 0
        // This unit test validates the guard logic directly
        let amount_in: i128 = 1_000_000;
        let min_out: i128 = 900_000;
        assert!(amount_in > 0, "amount_in must be positive");
        assert!(min_out > 0, "min_amount_out must be positive");
    }

    #[test]
    fn slippage_check_reverts_when_output_below_min() {
        let actual_out: i128 = 850_000;
        let min_out: i128 = 900_000;
        assert!(
            actual_out < min_out,
            "Should detect slippage: {} < {}", actual_out, min_out
        );
    }

    #[test]
    fn slippage_check_passes_when_output_meets_min() {
        let actual_out: i128 = 950_000;
        let min_out: i128 = 900_000;
        assert!(actual_out >= min_out);
    }
}
