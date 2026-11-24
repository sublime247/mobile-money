extern crate std;

use super::*;
use blacklist::{BlacklistContract, BlacklistContractClient};
use fee_tier::{
    mock::{MockStaking, MockStakingClient},
    FeeTierContract, FeeTierContractClient,
};
use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction, Events as _, Ledger as _},
    token::{self as sdk_token, StellarAssetClient},
    Event, String,
};

const START: u64 = 1_700_000_000;
const FEE_BPS: u32 = 100; // 1%
const UNIT: i128 = 10_000_000;

struct Setup {
    env: Env,
    admin: Address,
    fee_recipient: Address,
    token: sdk_token::Client<'static>,
    client: BridgeContractClient<'static>,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START);

    let admin = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();

    let contract_id = env.register(BridgeContract, ());
    let client = BridgeContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_id, &fee_recipient, &FEE_BPS);

    StellarAssetClient::new(&env, &token_id).mint(&contract_id, &(1_000_000 * UNIT));

    Setup {
        token: sdk_token::Client::new(&env, &token_id),
        env,
        admin,
        fee_recipient,
        client,
    }
}

/// Address of the account whose auth was required by the last invocation.
fn last_auth_address(env: &Env) -> Address {
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    let (address, invocation) = &auths[0];
    assert!(matches!(
        invocation.function,
        AuthorizedFunction::Contract(_)
    ));
    address.clone()
}

// ── Initialisation ───────────────────────────────────────────────────────────

#[test]
fn test_initialize() {
    let s = setup();
    assert_eq!(s.client.get_admin(), s.admin);
    assert_eq!(s.client.get_fee_bps(), FEE_BPS);
    assert_eq!(s.client.get_pending_admin(), None);
    assert_eq!(s.client.get_blacklist(), None);
    assert_eq!(s.client.get_fee_tier(), None);
}

#[test]
fn test_initialize_twice_fails() {
    let s = setup();
    let result = s
        .client
        .try_initialize(&s.admin, &s.token.address, &s.fee_recipient, &FEE_BPS);
    assert_eq!(result, Err(Ok(BridgeError::AlreadyInitialised)));
}

#[test]
fn test_initialize_rejects_excessive_fee() {
    let env = Env::default();
    env.mock_all_auths();
    let client = BridgeContractClient::new(&env, &env.register(BridgeContract, ()));
    let a = Address::generate(&env);
    let result = client.try_initialize(&a, &a, &a, &(MAX_FEE_BPS + 1));
    assert_eq!(result, Err(Ok(BridgeError::InvalidFee)));
}

// ── Two-step admin transfer ──────────────────────────────────────────────────

#[test]
fn test_propose_and_accept_after_delay() {
    let s = setup();
    let new_admin = Address::generate(&s.env);

    let pending = s.client.propose_admin(&new_admin);
    assert_eq!(last_auth_address(&s.env), s.admin);
    assert_eq!(
        pending,
        PendingAdmin {
            new_admin: new_admin.clone(),
            proposed_at: START,
            accept_after: START + ADMIN_TRANSFER_DELAY,
        }
    );
    assert_eq!(s.client.get_pending_admin(), Some(pending));
    // Proposal alone does not change the admin.
    assert_eq!(s.client.get_admin(), s.admin);

    s.env.ledger().set_timestamp(START + ADMIN_TRANSFER_DELAY);
    s.client.accept_admin();
    assert_eq!(last_auth_address(&s.env), new_admin);

    assert_eq!(s.client.get_admin(), new_admin);
    assert_eq!(s.client.get_pending_admin(), None);

    // The new admin now authorises admin-only calls.
    s.client.propose_fee_bps(&50);
    assert_eq!(last_auth_address(&s.env), new_admin);
}

#[test]
fn test_propose_emits_event() {
    let s = setup();
    let new_admin = Address::generate(&s.env);
    s.client.propose_admin(&new_admin);

    let expected = AdminProposed {
        current_admin: s.admin.clone(),
        new_admin,
        accept_after: START + ADMIN_TRANSFER_DELAY,
    };
    assert_eq!(
        s.env.events().all(),
        [expected.to_xdr(&s.env, &s.client.address)]
    );
}

#[test]
fn test_accept_emits_event() {
    let s = setup();
    let new_admin = Address::generate(&s.env);
    s.client.propose_admin(&new_admin);
    s.env.ledger().set_timestamp(START + ADMIN_TRANSFER_DELAY);
    s.client.accept_admin();

    let expected = AdminTransferred {
        previous_admin: s.admin.clone(),
        new_admin,
    };
    assert_eq!(
        s.env.events().all(),
        [expected.to_xdr(&s.env, &s.client.address)]
    );
}

#[test]
fn test_accept_before_delay_fails() {
    let s = setup();
    let new_admin = Address::generate(&s.env);
    s.client.propose_admin(&new_admin);

    s.env
        .ledger()
        .set_timestamp(START + ADMIN_TRANSFER_DELAY - 1);
    assert_eq!(
        s.client.try_accept_admin(),
        Err(Ok(BridgeError::AdminTransferNotReady))
    );
    assert_eq!(s.client.get_admin(), s.admin);
    assert!(s.client.get_pending_admin().is_some());
}

#[test]
fn test_accept_without_proposal_fails() {
    let s = setup();
    assert_eq!(
        s.client.try_accept_admin(),
        Err(Ok(BridgeError::NoPendingAdmin))
    );
}

#[test]
#[should_panic]
fn test_accept_requires_proposed_admin_auth() {
    let s = setup();
    s.client.propose_admin(&Address::generate(&s.env));
    s.env.ledger().set_timestamp(START + ADMIN_TRANSFER_DELAY);

    s.env.set_auths(&[]);
    s.client.accept_admin();
}

#[test]
#[should_panic]
fn test_propose_requires_admin_auth() {
    let s = setup();
    s.env.set_auths(&[]);
    s.client.propose_admin(&Address::generate(&s.env));
}

#[test]
fn test_propose_self_fails() {
    let s = setup();
    assert_eq!(
        s.client.try_propose_admin(&s.admin),
        Err(Ok(BridgeError::InvalidAdmin))
    );
}

#[test]
fn test_revoke_proposal() {
    let s = setup();
    let new_admin = Address::generate(&s.env);
    s.client.propose_admin(&new_admin);

    s.client.revoke_admin_proposal();
    assert_eq!(last_auth_address(&s.env), s.admin);
    assert_eq!(
        s.env.events().all(),
        [AdminProposalRevoked {
            revoked_admin: new_admin
        }
        .to_xdr(&s.env, &s.client.address)]
    );
    assert_eq!(s.client.get_pending_admin(), None);

    // Revoked proposals can no longer be accepted, even after the delay.
    s.env.ledger().set_timestamp(START + ADMIN_TRANSFER_DELAY);
    assert_eq!(
        s.client.try_accept_admin(),
        Err(Ok(BridgeError::NoPendingAdmin))
    );
    assert_eq!(s.client.get_admin(), s.admin);
}

#[test]
fn test_revoke_without_proposal_fails() {
    let s = setup();
    assert_eq!(
        s.client.try_revoke_admin_proposal(),
        Err(Ok(BridgeError::NoPendingAdmin))
    );
}

#[test]
fn test_new_proposal_replaces_and_restarts_delay() {
    let s = setup();
    let first = Address::generate(&s.env);
    let second = Address::generate(&s.env);

    s.client.propose_admin(&first);
    s.env.ledger().set_timestamp(START + 3_600);
    s.client.propose_admin(&second);

    // First proposal's delay has elapsed, but it was replaced.
    s.env.ledger().set_timestamp(START + ADMIN_TRANSFER_DELAY);
    assert_eq!(
        s.client.try_accept_admin(),
        Err(Ok(BridgeError::AdminTransferNotReady))
    );

    s.env
        .ledger()
        .set_timestamp(START + 3_600 + ADMIN_TRANSFER_DELAY);
    s.client.accept_admin();
    assert_eq!(s.client.get_admin(), second);
}

// ── Deposits & settlement ────────────────────────────────────────────────────

#[test]
fn test_deposit() {
    let s = setup();
    let user = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.token.address).mint(&user, &(10 * UNIT));

    s.client.deposit(&user, &(4 * UNIT));
    assert_eq!(s.token.balance(&user), 6 * UNIT);
}

#[test]
fn test_deposit_invalid_amount() {
    let s = setup();
    let user = Address::generate(&s.env);
    assert_eq!(
        s.client.try_deposit(&user, &0),
        Err(Ok(BridgeError::InvalidAmount))
    );
}

#[test]
fn test_settle_charges_standard_fee_without_fee_tier() {
    let s = setup();
    let user = Address::generate(&s.env);

    let settlement = s.client.settle(&user, &(1_000 * UNIT));
    assert_eq!(
        settlement,
        Settlement {
            amount: 1_000 * UNIT,
            standard_fee: 10 * UNIT,
            fee: 10 * UNIT,
            payout: 990 * UNIT,
        }
    );
    assert_eq!(s.token.balance(&user), 990 * UNIT);
    assert_eq!(s.token.balance(&s.fee_recipient), 10 * UNIT);
}

#[test]
fn test_settle_insufficient_balance() {
    let s = setup();
    let user = Address::generate(&s.env);
    assert_eq!(
        s.client.try_settle(&user, &(2_000_000 * UNIT)),
        Err(Ok(BridgeError::InsufficientBalance))
    );
}

#[test]
fn test_settle_applies_fee_tier_discount() {
    let s = setup();
    let staking_id = s.env.register(MockStaking, ());
    let staking = MockStakingClient::new(&s.env, &staking_id);
    let fee_tier_id = s.env.register(FeeTierContract, ());
    FeeTierContractClient::new(&s.env, &fee_tier_id).initialize(&s.admin, &staking_id, &7);
    s.client.set_fee_tier(&Some(fee_tier_id));

    let amount = 1_000 * UNIT; // standard fee: 10 tokens
    let cases: [(i128, i128); 4] = [
        (0, 10 * UNIT),                 // no tier
        (1_000 * UNIT, 9 * UNIT),       // tier 1: 10% off
        (5_000 * UNIT, 75 * UNIT / 10), // tier 2: 25% off
        (10_000 * UNIT, 5 * UNIT),      // tier 3: 50% off
    ];
    for (stake, expected_fee) in cases {
        let user = Address::generate(&s.env);
        staking.set_stake(&user, &stake);
        let fees_before = s.token.balance(&s.fee_recipient);

        let settlement = s.client.settle(&user, &amount);

        assert_eq!(settlement.standard_fee, 10 * UNIT);
        assert_eq!(settlement.fee, expected_fee, "stake {stake}");
        assert_eq!(s.token.balance(&user), amount - expected_fee);
        assert_eq!(
            s.token.balance(&s.fee_recipient) - fees_before,
            expected_fee
        );
    }

    s.client.set_fee_tier(&None);
    assert_eq!(s.client.get_fee_tier(), None);
}

#[test]
fn test_blacklisted_deposit_and_settlement_rejected() {
    let s = setup();
    let registry_id = s.env.register(BlacklistContract, ());
    let registry = BlacklistContractClient::new(&s.env, &registry_id);
    registry.initialize(&s.admin);
    s.client.set_blacklist(&Some(registry_id));

    let user = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.token.address).mint(&user, &(10 * UNIT));
    registry.add(&user, &String::from_str(&s.env, "sanctions"));

    assert_eq!(
        s.client.try_deposit(&user, &UNIT),
        Err(Ok(BridgeError::Blacklisted))
    );
    assert_eq!(
        s.client.try_settle(&user, &UNIT),
        Err(Ok(BridgeError::Blacklisted))
    );
    assert_eq!(s.token.balance(&user), 10 * UNIT);

    // Once cleared, the same user can transact again.
    registry.remove(&user);
    s.client.deposit(&user, &UNIT);
    s.client.settle(&user, &(100 * UNIT));
    assert_eq!(s.token.balance(&user), 9 * UNIT + 99 * UNIT);
}
