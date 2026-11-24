#![no_main]

//! Fuzz target for the vault contract, which holds the operational
//! hot-wallet balances used for mobile-money cash-out disbursements.
//!
//! The contract's current authority model is a single admin (not yet a
//! weighted multi-signature scheme), so this harness fuzzes what the
//! contract actually enforces: `sweep` is the only fund-moving entrypoint,
//! and its two real risks are (1) an admin/destination address that
//! triggers unexpected behaviour and (2) an amount that lands on or past a
//! balance boundary. `signer_count`/`admin_index`/`destination_index` draw
//! from a randomized pool of candidate addresses standing in for a signer
//! set, and `SweepAmount` is deliberately biased toward the boundaries
//! around the vault's live balance — a uniformly random `i128` almost never
//! lands exactly on one by chance, which is exactly where off-by-one and
//! overflow bugs hide.

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env};
use vault::{VaultContract, VaultContractClient};

#[derive(Arbitrary, Debug)]
enum SweepAmount {
    Zero,
    NegativeOne,
    MinI128,
    MaxI128,
    ExactBalance,
    BalancePlusOne,
    BalanceMinusOne,
    Arbitrary(i128),
}

impl SweepAmount {
    fn resolve(&self, balance: i128) -> i128 {
        match self {
            SweepAmount::Zero => 0,
            SweepAmount::NegativeOne => -1,
            SweepAmount::MinI128 => i128::MIN,
            SweepAmount::MaxI128 => i128::MAX,
            SweepAmount::ExactBalance => balance,
            SweepAmount::BalancePlusOne => balance.saturating_add(1),
            SweepAmount::BalanceMinusOne => balance.saturating_sub(1),
            SweepAmount::Arbitrary(v) => *v,
        }
    }
}

#[derive(Arbitrary, Debug)]
struct SweepStep {
    amount: SweepAmount,
    /// Mint this many additional tokens into the vault before sweeping,
    /// simulating fresh cash-out deposits arriving between disbursements.
    top_up: u32,
}

#[derive(Arbitrary, Debug)]
struct FuzzInput {
    /// Size of the candidate address pool that `admin_index`/
    /// `destination_index` are drawn from (clamped to 1..=8 below).
    signer_count: u8,
    admin_index: u8,
    destination_index: u8,
    initial_mint: i128,
    steps: Vec<SweepStep>,
}

fuzz_target!(|input: FuzzInput| {
    let env = Env::default();
    env.mock_all_auths();

    let signer_count = (input.signer_count % 8) as usize + 1;
    let signers: Vec<Address> = (0..signer_count).map(|_| Address::generate(&env)).collect();
    let admin = signers[input.admin_index as usize % signers.len()].clone();
    let destination = signers[input.destination_index as usize % signers.len()].clone();

    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_id.address();
    let token_client = StellarAssetClient::new(&env, &token_address);

    let contract_id = env.register(VaultContract, ());
    let client = VaultContractClient::new(&env, &contract_id);

    if client.try_initialize(&admin, &token_address).is_err() {
        return;
    }

    let initial_mint = input.initial_mint.max(0);
    if initial_mint > 0 {
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            token_client.mint(&contract_id, &initial_mint);
        }));
        if res.is_err() {
            return;
        }
    }

    for step in input.steps.into_iter().take(64) {
        if step.top_up > 0 {
            let top_up = i128::from(step.top_up);
            let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                token_client.mint(&contract_id, &top_up);
            }));
            if res.is_err() {
                return;
            }
        }

        let balance_before = match client.try_get_balance() {
            Ok(balance) => balance,
            Err(_) => return,
        };

        let amount = step.amount.resolve(balance_before);
        let result = client.try_sweep(&amount, &destination);

        let balance_after = match client.try_get_balance() {
            Ok(balance) => balance,
            Err(_) => return,
        };

        // The vault's live balance must never go negative, and a failed
        // sweep must never mutate state — both are core safety invariants
        // for a contract that custodies hot-wallet disbursement funds.
        assert!(
            balance_after >= 0,
            "vault balance went negative: {balance_after}"
        );

        match result {
            Ok(_) => {
                assert!(
                    amount > 0,
                    "sweep succeeded with a non-positive amount: {amount}"
                );
                assert!(
                    amount <= balance_before,
                    "sweep succeeded for {amount}, beyond available balance {balance_before}"
                );
                assert_eq!(
                    balance_after,
                    balance_before - amount,
                    "vault balance did not decrease by exactly the swept amount"
                );
            }
            Err(_) => {
                assert!(
                    amount <= 0 || amount > balance_before,
                    "sweep of a valid amount ({amount}) unexpectedly failed against balance {balance_before}"
                );
                assert_eq!(
                    balance_after, balance_before,
                    "a failed sweep still moved funds"
                );
            }
        }
    }
});
