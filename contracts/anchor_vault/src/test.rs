extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, Event, IntoVal, Vec,
};

struct Setup {
    env: Env,
    admins: [Address; 3],
    user: Address,
    token: TokenClient<'static>,
    client: AnchorVaultClient<'static>,
}

/// 2-of-3 vault with a funded user.
fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);

    let admins = [
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token = TokenClient::new(&env, &sac.address());

    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &sac.address()).mint(&user, &1_000);

    let contract_id = env.register(AnchorVault, ());
    let client = AnchorVaultClient::new(&env, &contract_id);
    client.initialize(
        &vec![
            &env,
            admins[0].clone(),
            admins[1].clone(),
            admins[2].clone(),
        ],
        &2,
        &sac.address(),
    );

    Setup {
        env,
        admins,
        user,
        token,
        client,
    }
}

fn quorum(s: &Setup) -> Vec<Address> {
    vec![&s.env, s.admins[0].clone(), s.admins[1].clone()]
}

// ── Initialization ───────────────────────────────────────────────────────────

#[test]
fn initialize_rejects_invalid_threshold() {
    let env = Env::default();
    let client = AnchorVaultClient::new(&env, &env.register(AnchorVault, ()));
    let a = Address::generate(&env);
    let token = Address::generate(&env);

    assert_eq!(
        client.try_initialize(&vec![&env, a.clone()], &0, &token),
        Err(Ok(VaultError::InvalidThreshold))
    );
    assert_eq!(
        client.try_initialize(&vec![&env, a.clone()], &2, &token),
        Err(Ok(VaultError::InvalidThreshold))
    );
    assert_eq!(
        client.try_initialize(&vec![&env, a.clone(), a.clone()], &1, &token),
        Err(Ok(VaultError::DuplicateSigner))
    );
}

#[test]
fn initialize_only_once() {
    let s = setup();
    let token = Address::generate(&s.env);
    assert_eq!(
        s.client.try_initialize(&quorum(&s), &1, &token),
        Err(Ok(VaultError::AlreadyInitialized))
    );
}

// ── Normal operation ─────────────────────────────────────────────────────────

#[test]
fn deposit_and_withdraw_when_active() {
    let s = setup();
    assert!(!s.client.is_paused());

    s.client.deposit(&s.user, &400);
    assert_eq!(s.client.balance(&s.user), 400);
    assert_eq!(s.token.balance(&s.client.address), 400);

    s.client.withdraw(&s.user, &150);
    assert_eq!(s.client.balance(&s.user), 250);
    assert_eq!(s.token.balance(&s.user), 750);
}

#[test]
fn withdraw_more_than_balance_fails() {
    let s = setup();
    s.client.deposit(&s.user, &100);
    assert_eq!(
        s.client.try_withdraw(&s.user, &101),
        Err(Ok(VaultError::InsufficientBalance))
    );
}

// ── Pause state rejection ────────────────────────────────────────────────────

#[test]
fn pause_rejects_deposits_and_withdrawals() {
    let s = setup();
    s.client.deposit(&s.user, &500);

    s.client.pause(&s.admins[0], &quorum(&s));
    assert!(s.client.is_paused());

    assert_eq!(
        s.client.try_deposit(&s.user, &10),
        Err(Ok(VaultError::ContractPaused))
    );
    assert_eq!(
        s.client.try_withdraw(&s.user, &10),
        Err(Ok(VaultError::ContractPaused))
    );

    // Nothing moved while frozen.
    assert_eq!(s.client.balance(&s.user), 500);
    assert_eq!(s.token.balance(&s.client.address), 500);
    assert_eq!(s.token.balance(&s.user), 500);
}

#[test]
fn unpause_resumes_deposits_and_withdrawals() {
    let s = setup();
    s.client.deposit(&s.user, &500);
    s.client.pause(&s.admins[0], &quorum(&s));

    let resumers = vec![&s.env, s.admins[1].clone(), s.admins[2].clone()];
    s.client.unpause(&s.admins[2], &resumers);
    assert!(!s.client.is_paused());

    s.client.withdraw(&s.user, &200);
    s.client.deposit(&s.user, &50);
    assert_eq!(s.client.balance(&s.user), 350);
    assert_eq!(s.token.balance(&s.user), 650);
}

#[test]
fn pause_and_unpause_are_not_idempotent() {
    let s = setup();
    assert_eq!(
        s.client.try_unpause(&s.admins[0], &quorum(&s)),
        Err(Ok(VaultError::NotPaused))
    );
    s.client.pause(&s.admins[0], &quorum(&s));
    assert_eq!(
        s.client.try_pause(&s.admins[0], &quorum(&s)),
        Err(Ok(VaultError::AlreadyPaused))
    );
}

// ── Multi-signature threshold ────────────────────────────────────────────────

#[test]
fn pause_requires_threshold_signers() {
    let s = setup();
    let one = vec![&s.env, s.admins[0].clone()];
    assert_eq!(
        s.client.try_pause(&s.admins[0], &one),
        Err(Ok(VaultError::ThresholdNotMet))
    );
    assert!(!s.client.is_paused());
}

#[test]
fn duplicate_signer_cannot_fake_quorum() {
    let s = setup();
    let dup = vec![&s.env, s.admins[0].clone(), s.admins[0].clone()];
    assert_eq!(
        s.client.try_pause(&s.admins[0], &dup),
        Err(Ok(VaultError::DuplicateSigner))
    );
}

#[test]
fn non_admin_signer_rejected() {
    let s = setup();
    let outsider = Address::generate(&s.env);
    let signers = vec![&s.env, s.admins[0].clone(), outsider.clone()];
    assert_eq!(
        s.client.try_pause(&s.admins[0], &signers),
        Err(Ok(VaultError::NotAdmin))
    );
}

#[test]
fn operator_must_be_a_signer() {
    let s = setup();
    assert_eq!(
        s.client.try_pause(&s.admins[2], &quorum(&s)),
        Err(Ok(VaultError::OperatorNotSigner))
    );
}

#[test]
fn unpause_requires_threshold_signers() {
    let s = setup();
    s.client.pause(&s.admins[0], &quorum(&s));
    let one = vec![&s.env, s.admins[1].clone()];
    assert_eq!(
        s.client.try_unpause(&s.admins[1], &one),
        Err(Ok(VaultError::ThresholdNotMet))
    );
    assert!(s.client.is_paused());
}

#[test]
fn pause_records_auth_from_every_signer() {
    let s = setup();
    s.client.pause(&s.admins[0], &quorum(&s));

    let authorizers: std::vec::Vec<Address> =
        s.env.auths().into_iter().map(|(addr, _)| addr).collect();
    assert_eq!(authorizers.len(), 2);
    assert!(authorizers.contains(&s.admins[0]));
    assert!(authorizers.contains(&s.admins[1]));
}

#[test]
#[should_panic]
fn pause_fails_when_a_quorum_member_did_not_sign() {
    let s = setup();
    let signers = quorum(&s);
    let args = (s.admins[0].clone(), signers.clone()).into_val(&s.env);

    // Only admins[0] actually authorizes; admins[1] is listed but never signed.
    s.env.mock_auths(&[MockAuth {
        address: &s.admins[0],
        invoke: &MockAuthInvoke {
            contract: &s.client.address,
            fn_name: "pause",
            args,
            sub_invokes: &[],
        },
    }]);
    s.client.pause(&s.admins[0], &signers);
}

// ── Events ───────────────────────────────────────────────────────────────────

#[test]
fn pause_emits_contract_paused_event() {
    let s = setup();
    s.client.pause(&s.admins[0], &quorum(&s));

    let expected = ContractPaused {
        operator: s.admins[0].clone(),
        timestamp: 1_700_000_000,
        signers: quorum(&s),
    };
    assert_eq!(
        s.env.events().all(),
        [expected.to_xdr(&s.env, &s.client.address)]
    );
}

#[test]
fn unpause_emits_contract_unpaused_event() {
    let s = setup();
    s.client.pause(&s.admins[0], &quorum(&s));
    s.env.ledger().set_timestamp(1_700_000_600);
    s.client.unpause(&s.admins[1], &quorum(&s));

    let expected = ContractUnpaused {
        operator: s.admins[1].clone(),
        timestamp: 1_700_000_600,
        signers: quorum(&s),
    };
    assert_eq!(
        s.env.events().all(),
        [expected.to_xdr(&s.env, &s.client.address)]
    );
}
