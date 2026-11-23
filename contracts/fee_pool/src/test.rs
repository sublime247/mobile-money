extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

const MINT_AMOUNT: i128 = 10_000_000;

fn setup() -> (
    Env,
    Address,
    Address,
    Address,
    Address,
    FeePoolContractClient<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let fee_payer = Address::generate(&env);
    let platform_treasury = Address::generate(&env);

    // Deploy a test token
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    StellarAssetClient::new(&env, &token_id.address()).mint(&admin, &MINT_AMOUNT);
    StellarAssetClient::new(&env, &token_id.address()).mint(&fee_payer, &MINT_AMOUNT);

    let contract_id = env.register(FeePoolContract, ());
    let client = FeePoolContractClient::new(&env, &contract_id);

    (
        env,
        admin,
        fee_payer,
        platform_treasury,
        token_id.address(),
        client,
    )
}

#[test]
fn test_initialize() {
    let (_env, admin, _fee_payer, platform_treasury, token, client) = setup();

    client.initialize(&admin, &token, &platform_treasury, &100, &3600);

    let state = client.get_state();
    assert_eq!(state.token, token);
    assert_eq!(state.admin, admin);
    assert_eq!(state.platform_treasury, platform_treasury);
    assert_eq!(state.fee_bps, 100);
    assert_eq!(state.distribution_interval, 3600);
    assert_eq!(state.total_fees, 0);
    assert_eq!(state.last_distribution, 0);
}

#[test]
fn test_register_provider() {
    let (env, admin, _fee_payer, platform_treasury, token, client) = setup();

    client.initialize(&admin, &token, &platform_treasury, &100, &3600);

    let provider = Address::generate(&env);
    client.register_provider(&provider, &1_000_000, &95);

    let metrics = client.get_provider_metrics(&provider);
    assert_eq!(metrics.liquidity, 1_000_000);
    assert_eq!(metrics.uptime, 95);
    assert_eq!(metrics.transaction_count, 0);

    assert_eq!(client.get_total_shares(), 1_000_000);
    assert_eq!(client.get_provider_count(), 1);
}

#[test]
fn test_register_multiple_providers() {
    let (env, admin, _fee_payer, platform_treasury, token, client) = setup();

    client.initialize(&admin, &token, &platform_treasury, &100, &3600);

    let provider1 = Address::generate(&env);
    let provider2 = Address::generate(&env);
    let provider3 = Address::generate(&env);

    client.register_provider(&provider1, &1_000_000, &95);
    client.register_provider(&provider2, &2_000_000, &90);
    client.register_provider(&provider3, &500_000, &98);

    assert_eq!(client.get_provider_count(), 3);
    assert_eq!(client.get_total_shares(), 3_500_000);
}

#[test]
fn test_update_metrics() {
    let (env, admin, _fee_payer, platform_treasury, token, client) = setup();

    client.initialize(&admin, &token, &platform_treasury, &100, &3600);

    let provider = Address::generate(&env);
    client.register_provider(&provider, &1_000_000, &95);

    client.update_metrics(&provider, &1_500_000, &97, &100);

    let metrics = client.get_provider_metrics(&provider);
    assert_eq!(metrics.liquidity, 1_500_000);
    assert_eq!(metrics.uptime, 97);
    assert_eq!(metrics.transaction_count, 100);

    assert_eq!(client.get_total_shares(), 1_500_000);
}

#[test]
fn test_accumulate_fees() {
    let (env, admin, fee_payer, platform_treasury, token, client) = setup();

    client.initialize(&admin, &token, &platform_treasury, &100, &3600);

    client.accumulate_fees(&fee_payer, &500_000);

    // 1% (fee_bps=100) of 500_000 goes to the platform treasury,
    // the remainder pools for provider distribution.
    let state = client.get_state();
    assert_eq!(state.total_fees, 495_000);

    let tc = TokenClient::new(&env, &token);
    assert_eq!(tc.balance(&fee_payer), MINT_AMOUNT - 500_000);
    assert_eq!(tc.balance(&platform_treasury), 5_000);
    assert_eq!(tc.balance(&client.address), 495_000);
}

#[test]
fn test_distribute_single_provider() {
    let (env, admin, fee_payer, platform_treasury, token, client) = setup();

    client.initialize(&admin, &token, &platform_treasury, &100, &3600);

    let provider = Address::generate(&env);
    client.register_provider(&provider, &1_000_000, &100);

    client.accumulate_fees(&fee_payer, &100_000);

    env.ledger().set_timestamp(3600);
    client.distribute();

    let state = client.get_state();
    assert_eq!(state.total_fees, 0);
    assert_eq!(state.last_distribution, 3600);

    // Platform kept its 1% cut (1_000); the provider gets the rest (99_000).
    let tc = TokenClient::new(&env, &token);
    assert_eq!(tc.balance(&platform_treasury), 1_000);
    assert_eq!(tc.balance(&provider), 99_000);
}

#[test]
fn test_distribute_multiple_providers() {
    let (env, admin, fee_payer, platform_treasury, token, client) = setup();

    client.initialize(&admin, &token, &platform_treasury, &100, &3600);

    let provider1 = Address::generate(&env);
    let provider2 = Address::generate(&env);
    let provider3 = Address::generate(&env);

    // Register providers with different metrics
    client.register_provider(&provider1, &1_000_000, &100);
    client.register_provider(&provider2, &2_000_000, &90);
    client.register_provider(&provider3, &500_000, &95);

    // Add some transaction history
    client.update_metrics(&provider1, &1_000_000, &100, &100);
    client.update_metrics(&provider2, &2_000_000, &90, &50);
    client.update_metrics(&provider3, &500_000, &95, &25);

    client.accumulate_fees(&fee_payer, &1_000_000);

    env.ledger().set_timestamp(3600);
    client.distribute();

    let state = client.get_state();
    assert_eq!(state.total_fees, 0);

    let tc = TokenClient::new(&env, &token);
    let p1_balance = tc.balance(&provider1);
    let p2_balance = tc.balance(&provider2);
    let p3_balance = tc.balance(&provider3);

    // Verify all providers received something
    assert!(p1_balance > 0);
    assert!(p2_balance > 0);
    assert!(p3_balance > 0);

    // Platform kept its 1% cut (10_000); providers split the rest (990_000).
    // Each provider's share is integer-divided, so up to one stroop per
    // provider can remain undistributed as dust.
    assert_eq!(tc.balance(&platform_treasury), 10_000);
    let distributed = p1_balance + p2_balance + p3_balance;
    assert!((990_000 - 3..=990_000).contains(&distributed));
}

#[test]
fn test_distribution_interval() {
    let (env, admin, fee_payer, platform_treasury, token, client) = setup();

    client.initialize(&admin, &token, &platform_treasury, &100, &3600);

    let provider = Address::generate(&env);
    client.register_provider(&provider, &1_000_000, &100);

    client.accumulate_fees(&fee_payer, &100_000);

    env.ledger().set_timestamp(3600);
    client.distribute();

    client.accumulate_fees(&fee_payer, &50_000);

    // Try to distribute before interval elapses
    env.ledger().set_timestamp(4000);
    let result = client.try_distribute();
    assert!(result.is_err());

    // Distribute after interval elapses
    env.ledger().set_timestamp(7200);
    client.distribute();
}

#[test]
fn test_no_fees_available() {
    let (env, admin, _fee_payer, platform_treasury, token, client) = setup();

    client.initialize(&admin, &token, &platform_treasury, &100, &3600);

    let provider = Address::generate(&env);
    client.register_provider(&provider, &1_000_000, &100);

    env.ledger().set_timestamp(3600);
    let result = client.try_distribute();
    assert!(result.is_err());
}

#[test]
fn test_error_already_registered() {
    let (env, admin, _fee_payer, platform_treasury, token, client) = setup();

    client.initialize(&admin, &token, &platform_treasury, &100, &3600);

    let provider = Address::generate(&env);
    client.register_provider(&provider, &1_000_000, &95);

    let result = client.try_register_provider(&provider, &2_000_000, &90);
    assert!(result.is_err());
}

#[test]
fn test_error_not_registered() {
    let (env, admin, _fee_payer, platform_treasury, token, client) = setup();

    client.initialize(&admin, &token, &platform_treasury, &100, &3600);

    let provider = Address::generate(&env);
    let result = client.try_get_provider_metrics(&provider);
    assert!(result.is_err());
}

#[test]
fn test_error_invalid_liquidity() {
    let (env, admin, _fee_payer, platform_treasury, token, client) = setup();

    client.initialize(&admin, &token, &platform_treasury, &100, &3600);

    let provider = Address::generate(&env);
    let result = client.try_register_provider(&provider, &0, &95);
    assert!(result.is_err());
}

#[test]
fn test_error_invalid_uptime() {
    let (env, admin, _fee_payer, platform_treasury, token, client) = setup();

    client.initialize(&admin, &token, &platform_treasury, &100, &3600);

    let provider = Address::generate(&env);
    let result = client.try_register_provider(&provider, &1_000_000, &101);
    assert!(result.is_err());
}

fn setup_fee_update(env: &Env) -> (FeePoolContractClient<'_>, Address, Address) {
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.timestamp = 1_000);

    let admin = Address::generate(env);
    let token_admin = Address::generate(env);
    let token = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    StellarAssetClient::new(env, &token).mint(&admin, &10_000_000);
    let treasury = Address::generate(env);

    let contract_id = env.register(FeePoolContract, ());
    let client = FeePoolContractClient::new(env, &contract_id);
    client.initialize(&admin, &token, &treasury, &100, &3_600);

    (client, admin, treasury)
}

#[test]
fn fee_increase_requires_the_full_48_hour_notice_period() {
    let env = Env::default();
    let (client, _admin, _treasury) = setup_fee_update(&env);

    client.propose_fee_update(&200);
    let pending = client.get_pending_fee_update().unwrap();
    assert_eq!(pending.new_fee_bps, 200);
    assert_eq!(pending.executable_at, 1_000 + FEE_UPDATE_TIMELOCK_SECONDS);

    // Immediately and one second before the deadline: both rejected.
    assert_eq!(
        client.try_apply_fee_update(),
        Err(Ok(FeePoolError::FeeUpdateTimelockActive))
    );
    env.ledger().with_mut(|li| {
        li.timestamp = 1_000 + FEE_UPDATE_TIMELOCK_SECONDS - 1;
    });
    assert_eq!(
        client.try_apply_fee_update(),
        Err(Ok(FeePoolError::FeeUpdateTimelockActive))
    );
    assert_eq!(client.get_state().fee_bps, 100);

    // Exactly 172,800 seconds after the proposal: now applicable.
    env.ledger().with_mut(|li| {
        li.timestamp = 1_000 + FEE_UPDATE_TIMELOCK_SECONDS;
    });
    client.apply_fee_update();
    assert_eq!(client.get_state().fee_bps, 200);
    assert!(client.get_pending_fee_update().is_none());
}

#[test]
fn proposed_fee_increase_can_be_cancelled_before_activation() {
    let env = Env::default();
    let (client, _admin, _treasury) = setup_fee_update(&env);

    client.propose_fee_update(&500);
    client.cancel_fee_update();

    assert!(client.get_pending_fee_update().is_none());
    env.ledger().with_mut(|li| {
        li.timestamp = 1_000 + FEE_UPDATE_TIMELOCK_SECONDS;
    });
    assert_eq!(
        client.try_apply_fee_update(),
        Err(Ok(FeePoolError::NoPendingFeeUpdate))
    );
    assert_eq!(client.get_state().fee_bps, 100);
}

#[test]
fn applying_a_fee_update_without_a_proposal_is_rejected() {
    let env = Env::default();
    let (client, _admin, _treasury) = setup_fee_update(&env);

    assert_eq!(
        client.try_apply_fee_update(),
        Err(Ok(FeePoolError::NoPendingFeeUpdate))
    );
    assert_eq!(
        client.try_cancel_fee_update(),
        Err(Ok(FeePoolError::NoPendingFeeUpdate))
    );
}

#[test]
fn non_admin_cannot_propose_or_apply_a_fee_update() {
    let env = Env::default();
    let (client, _admin, _treasury) = setup_fee_update(&env);

    // Drop the blanket auth mock so only real authorizations count.
    env.set_auths(&[]);
    assert!(client.try_propose_fee_update(&200).is_err());

    env.mock_all_auths();
    client.propose_fee_update(&200);
    env.set_auths(&[]);
    assert!(client.try_apply_fee_update().is_err());
}

#[test]
fn invalid_fee_bps_cannot_be_proposed() {
    let env = Env::default();
    let (client, _admin, _treasury) = setup_fee_update(&env);

    assert_eq!(
        client.try_propose_fee_update(&10_001),
        Err(Ok(FeePoolError::InvalidFeeBps))
    );
    assert!(client.get_pending_fee_update().is_none());
}
