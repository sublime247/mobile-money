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
