extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    Address, Env, Event, Vec,
};

struct Setup {
    env: Env,
    owner: Address,
    emergency_admin: Address,
    asset_in: Address,
    asset_out: Address,
    client: RouterClient<'static>,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();

    let owner = Address::generate(&env);
    let emergency_admin = Address::generate(&env);
    let asset_in = Address::generate(&env);
    let asset_out = Address::generate(&env);

    let contract_id = env.register(Router, ());
    let client = RouterClient::new(&env, &contract_id);
    client.initialize(&owner, &500, &1_000);
    client.set_emergency_admin(&owner, &emergency_admin);

    Setup {
        env,
        owner,
        emergency_admin,
        asset_in,
        asset_out,
        client,
    }
}

#[test]
fn test_pause_state_defaults_to_owner() {
    let env = Env::default();
    env.mock_all_auths();

    let owner = Address::generate(&env);
    let contract_id = env.register(Router, ());
    let client = RouterClient::new(&env, &contract_id);
    client.initialize(&owner, &500, &1_000);

    assert!(!client.is_paused());
    assert_eq!(client.get_emergency_admin(), owner);
}

#[test]
fn test_pause_blocks_route_and_swap_execution() {
    let s = setup();
    let caller = Address::generate(&s.env);
    let empty_path = Vec::new(&s.env);

    assert!(!s.client.is_paused());

    s.client.pause(&s.emergency_admin);
    assert!(s.client.is_paused());

    let route_result = s
        .client
        .try_find_optimal_route(&s.asset_in, &s.asset_out, &100, &3);
    assert_eq!(route_result, Err(Ok(RouterError::ContractPaused)));

    let swap_result = s.client.try_execute_swap(
        &caller,
        &empty_path,
        &s.asset_in,
        &s.asset_out,
        &100,
        &1,
        &1_000,
    );
    assert_eq!(swap_result, Err(Ok(RouterError::ContractPaused)));
}

#[test]
fn test_unpause_restores_route_execution() {
    let s = setup();

    s.client.pause(&s.emergency_admin);
    assert!(s.client.is_paused());

    s.client.unpause(&s.emergency_admin);
    assert!(!s.client.is_paused());

    // Routing resumes and now reaches normal route resolution rather than the
    // pause guard. With no pools configured it reports RouteNotFound.
    let route_result = s
        .client
        .try_find_optimal_route(&s.asset_in, &s.asset_out, &100, &3);
    assert_eq!(route_result, Err(Ok(RouterError::RouteNotFound)));
}

#[test]
fn test_only_emergency_admin_can_pause_and_unpause() {
    let s = setup();
    let outsider = Address::generate(&s.env);

    assert_eq!(
        s.client.try_pause(&outsider),
        Err(Ok(RouterError::NotEmergencyAdmin))
    );
    assert_eq!(
        s.client.try_unpause(&outsider),
        Err(Ok(RouterError::NotEmergencyAdmin))
    );
    assert!(!s.client.is_paused());
}

#[test]
fn test_owner_can_rotate_emergency_admin() {
    let s = setup();
    let new_admin = Address::generate(&s.env);

    s.client.set_emergency_admin(&s.owner, &new_admin);
    assert_eq!(s.client.get_emergency_admin(), new_admin);

    assert_eq!(
        s.client.try_pause(&s.emergency_admin),
        Err(Ok(RouterError::NotEmergencyAdmin))
    );

    s.client.pause(&new_admin);
    assert!(s.client.is_paused());
}

#[test]
fn test_pause_emits_contract_paused_event() {
    let s = setup();

    s.client.pause(&s.emergency_admin);

    let expected = ContractPaused {
        admin: s.emergency_admin.clone(),
    };
    assert_eq!(
        s.env.events().all(),
        [expected.to_xdr(&s.env, &s.client.address)]
    );
}

#[test]
fn test_unpause_emits_contract_unpaused_event() {
    let s = setup();

    let paused = ContractPaused {
        admin: s.emergency_admin.clone(),
    };
    let unpaused = ContractUnpaused {
        admin: s.emergency_admin.clone(),
    };

    s.client.pause(&s.emergency_admin);
    assert_eq!(
        s.env.events().all(),
        [paused.to_xdr(&s.env, &s.client.address)]
    );

    s.client.unpause(&s.emergency_admin);
    assert_eq!(
        s.env.events().all(),
        [unpaused.to_xdr(&s.env, &s.client.address)]
    );
}

// ── Reentrancy guard ──────────────────────────────────────────
//
// Soroban's host already rejects a call into a contract that is on the call
// stack, so a callback-driven reentrancy attack is refused at the protocol
// level today. The router's guard is defence-in-depth on top of that rule.
// These tests exercise both layers: hostile token/pool contracts that try to
// call back into the router mid-transfer, and the storage lock itself, held
// exactly the way an in-flight invocation would hold it.

use soroban_sdk::{contract, contractimpl, token::StellarAssetClient, token::TokenClient};

const ROUTER_KEY: &str = "ROUTER";

/// Token whose `transfer` re-enters the router's `execute_payout`.
#[contract]
struct ReentrantToken;

#[contractimpl]
impl ReentrantToken {
    pub fn set_router(env: Env, router: Address) {
        env.storage().instance().set(&ROUTER_KEY, &router);
    }

    pub fn transfer(env: Env, _from: Address, to: Address, amount: i128) {
        let router: Address = env.storage().instance().get(&ROUTER_KEY).unwrap();
        let state = RouterClient::new(&env, &router).get_state();
        RouterClient::new(&env, &router).execute_payout(
            &state.owner,
            &env.current_contract_address(),
            &to,
            &amount,
        );
    }
}

/// Pool whose `swap` re-enters the router's `route_payment`.
#[contract]
struct ReentrantPool;

#[contractimpl]
impl ReentrantPool {
    pub fn set_router(env: Env, router: Address) {
        env.storage().instance().set(&ROUTER_KEY, &router);
    }

    pub fn swap(
        env: Env,
        asset_in: Address,
        asset_out: Address,
        amount_in: i128,
        _min_amount_out: i128,
        recipient: Address,
    ) -> i128 {
        let router: Address = env.storage().instance().get(&ROUTER_KEY).unwrap();
        let path = soroban_sdk::vec![&env, env.current_contract_address()];
        RouterClient::new(&env, &router).route_payment(
            &recipient,
            &recipient,
            &path,
            &asset_in,
            &asset_out,
            &amount_in,
            &1,
            &u32::MAX,
        )
    }
}

fn hold_lock(s: &Setup) {
    s.env.as_contract(&s.client.address, || {
        s.env.storage().instance().set(&REENTRANCY_KEY, &true);
    });
    assert!(s.client.reentrancy_guard_active());
}

fn release_lock(s: &Setup) {
    s.env.as_contract(&s.client.address, || {
        s.env.storage().instance().remove(&REENTRANCY_KEY);
    });
    assert!(!s.client.reentrancy_guard_active());
}

fn funded_token(s: &Setup, amount: i128) -> Address {
    let issuer = Address::generate(&s.env);
    let token = s.env.register_stellar_asset_contract_v2(issuer).address();
    StellarAssetClient::new(&s.env, &token).mint(&s.client.address, &amount);
    token
}

#[test]
fn test_guard_is_released_after_successful_payout() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let token = funded_token(&s, 1_000);

    assert!(!s.client.reentrancy_guard_active());
    s.client.execute_payout(&s.owner, &token, &recipient, &400);

    assert_eq!(TokenClient::new(&s.env, &token).balance(&recipient), 400);
    assert!(!s.client.reentrancy_guard_active());
}

#[test]
fn test_held_guard_rejects_every_protected_entrypoint() {
    let s = setup();
    let caller = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);
    let token = funded_token(&s, 1_000);
    let path = soroban_sdk::vec![&s.env, Address::generate(&s.env)];

    // Stand exactly where an in-flight protected call leaves storage.
    hold_lock(&s);

    assert_eq!(
        s.client
            .try_execute_payout(&s.owner, &token, &recipient, &100),
        Err(Ok(RouterError::ReentrancyGuard))
    );
    assert_eq!(
        s.client.try_route_payment(
            &caller,
            &recipient,
            &path,
            &s.asset_in,
            &s.asset_out,
            &100,
            &1,
            &1_000,
        ),
        Err(Ok(RouterError::ReentrancyGuard))
    );
    assert_eq!(
        s.client
            .try_execute_swap(&caller, &path, &s.asset_in, &s.asset_out, &100, &1, &1_000,),
        Err(Ok(RouterError::ReentrancyGuard))
    );

    // Nothing moved while the lock was held.
    assert_eq!(TokenClient::new(&s.env, &token).balance(&recipient), 0);

    // Once the lock is released the very same payout succeeds.
    release_lock(&s);
    s.client.execute_payout(&s.owner, &token, &recipient, &100);
    assert_eq!(TokenClient::new(&s.env, &token).balance(&recipient), 100);
    assert!(!s.client.reentrancy_guard_active());
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn test_nested_guard_acquisition_panics_with_reentrancy_guard() {
    let s = setup();
    s.env.as_contract(&s.client.address, || {
        let _outer = ReentrancyGuard::enter(&s.env);
        // A nested protected call inside the same invocation must abort.
        let _inner = ReentrancyGuard::enter(&s.env);
    });
}

#[test]
fn test_guard_is_released_when_internal_transfer_fails() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let token = funded_token(&s, 100);

    // Router only holds 100, so the token transfer itself fails.
    let result = s
        .client
        .try_execute_payout(&s.owner, &token, &recipient, &500);
    assert!(result.is_err());
    assert!(!s.client.reentrancy_guard_active());

    // The lock was not left behind: a valid payout goes through.
    s.client.execute_payout(&s.owner, &token, &recipient, &100);
    assert_eq!(TokenClient::new(&s.env, &token).balance(&recipient), 100);
    assert!(!s.client.reentrancy_guard_active());
}

#[test]
fn test_guard_is_released_when_entrypoint_returns_error() {
    let s = setup();
    let outsider = Address::generate(&s.env);
    let token = funded_token(&s, 100);

    assert_eq!(
        s.client
            .try_execute_payout(&outsider, &token, &outsider, &50),
        Err(Ok(RouterError::Unauthorized))
    );
    assert!(!s.client.reentrancy_guard_active());

    let caller = Address::generate(&s.env);
    let empty: Vec<Address> = Vec::new(&s.env);
    assert_eq!(
        s.client.try_route_payment(
            &caller,
            &caller,
            &empty,
            &s.asset_in,
            &s.asset_out,
            &100,
            &1,
            &1_000,
        ),
        Err(Ok(RouterError::EmptyPath))
    );
    assert!(!s.client.reentrancy_guard_active());
}

#[test]
fn test_reentrant_token_callback_into_execute_payout_is_rejected() {
    let s = setup();
    let recipient = Address::generate(&s.env);

    let evil_token = s.env.register(ReentrantToken, ());
    ReentrantTokenClient::new(&s.env, &evil_token).set_router(&s.client.address);

    // The token's transfer calls straight back into execute_payout.
    let result = s
        .client
        .try_execute_payout(&s.owner, &evil_token, &recipient, &100);
    assert!(result.is_err());

    // The attack reverted cleanly and left no lock behind.
    assert!(!s.client.reentrancy_guard_active());
    assert_eq!(s.env.events().all().events().len(), 0);
}

#[test]
fn test_reentrant_pool_callback_into_route_payment_is_rejected() {
    let s = setup();
    let payer = Address::generate(&s.env);
    let recipient = Address::generate(&s.env);

    let issuer = Address::generate(&s.env);
    let asset_in = s
        .env
        .register_stellar_asset_contract_v2(issuer.clone())
        .address();
    let asset_out = s.env.register_stellar_asset_contract_v2(issuer).address();
    StellarAssetClient::new(&s.env, &asset_in).mint(&payer, &10_000);
    StellarAssetClient::new(&s.env, &asset_out).mint(&s.client.address, &10_000);

    let evil_pool = s.env.register(ReentrantPool, ());
    ReentrantPoolClient::new(&s.env, &evil_pool).set_router(&s.client.address);
    s.client.add_pool(
        &s.owner,
        &LiquidityPool {
            pool_address: evil_pool.clone(),
            asset_in: asset_in.clone(),
            asset_out: asset_out.clone(),
            depth: 5_000,
        },
    );

    let path = soroban_sdk::vec![&s.env, evil_pool];
    let result = s.client.try_route_payment(
        &payer, &recipient, &path, &asset_in, &asset_out, &1_000, &1, &1_000,
    );
    assert!(result.is_err());

    // The whole payment reverted: no funds moved and no lock is left behind.
    assert_eq!(TokenClient::new(&s.env, &asset_in).balance(&payer), 10_000);
    assert_eq!(TokenClient::new(&s.env, &asset_out).balance(&recipient), 0);
    assert!(!s.client.reentrancy_guard_active());
}
