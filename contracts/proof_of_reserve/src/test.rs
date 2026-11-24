extern crate std;

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::vec as svec;
use soroban_sdk::{BytesN, IntoVal};

fn setup(
    env: &Env,
    auditor_count: u32,
    required: u32,
) -> (
    ProofOfReserveContractClient<'_>,
    Address,
    std::vec::Vec<Address>,
) {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let auditors: std::vec::Vec<Address> =
        (0..auditor_count).map(|_| Address::generate(env)).collect();

    let mut auditors_vec = Vec::new(env);
    for a in &auditors {
        auditors_vec.push_back(a.clone());
    }

    let contract_id = env.register(ProofOfReserveContract, ());
    let client = ProofOfReserveContractClient::new(env, &contract_id);
    client.initialize(&admin, &auditors_vec, &required);

    (client, admin, auditors)
}

#[test]
fn submit_attestation_with_enough_signers_is_accepted() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1_000);
    let (client, _admin, auditors) = setup(&env, 3, 2);

    let signers = svec![&env, auditors[0].clone(), auditors[1].clone()];
    client.submit_attestation(&1_000_000i128, &1_000_000i128, &signers);

    let attestation = client.latest_attestation();
    assert_eq!(attestation.on_chain_supply, 1_000_000);
    assert_eq!(attestation.reserve_balance, 1_000_000);
    assert_eq!(attestation.attested_at, 1_000);
    assert_eq!(attestation.signers.len(), 2);
}

#[test]
fn submit_attestation_with_too_few_signers_is_rejected() {
    let env = Env::default();
    let (client, _admin, auditors) = setup(&env, 3, 2);

    let signers = svec![&env, auditors[0].clone()];
    let result = client.try_submit_attestation(&1_000_000i128, &1_000_000i128, &signers);
    assert_eq!(result, Err(Ok(ProofOfReserveError::InsufficientSignatures)));
}

#[test]
fn duplicate_signer_entries_do_not_satisfy_the_threshold() {
    let env = Env::default();
    let (client, _admin, auditors) = setup(&env, 3, 2);

    // Same auditor listed twice must not count as two signatures.
    let signers = svec![&env, auditors[0].clone(), auditors[0].clone()];
    let result = client.try_submit_attestation(&1_000_000i128, &1_000_000i128, &signers);
    assert_eq!(result, Err(Ok(ProofOfReserveError::InsufficientSignatures)));
}

#[test]
fn submit_attestation_rejects_an_unauthorized_signer() {
    let env = Env::default();
    let (client, _admin, auditors) = setup(&env, 3, 2);
    let outsider = Address::generate(&env);

    let signers = svec![&env, auditors[0].clone(), outsider];
    let result = client.try_submit_attestation(&1_000_000i128, &1_000_000i128, &signers);
    assert_eq!(result, Err(Ok(ProofOfReserveError::UnauthorizedAuditor)));
}

#[test]
fn submit_attestation_rejects_negative_amounts() {
    let env = Env::default();
    let (client, _admin, auditors) = setup(&env, 1, 1);
    let signers = svec![&env, auditors[0].clone()];

    assert_eq!(
        client.try_submit_attestation(&-1i128, &1_000i128, &signers),
        Err(Ok(ProofOfReserveError::InvalidAmount))
    );
    assert_eq!(
        client.try_submit_attestation(&1_000i128, &-1i128, &signers),
        Err(Ok(ProofOfReserveError::InvalidAmount))
    );
}

#[test]
fn is_fully_backed_true_for_a_fresh_one_to_one_attestation() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1_000);
    let (client, _admin, auditors) = setup(&env, 1, 1);
    let signers = svec![&env, auditors[0].clone()];

    client.submit_attestation(&1_000_000i128, &1_000_000i128, &signers);
    assert!(client.is_fully_backed());
}

#[test]
fn is_fully_backed_true_when_reserves_exceed_supply() {
    let env = Env::default();
    let (client, _admin, auditors) = setup(&env, 1, 1);
    let signers = svec![&env, auditors[0].clone()];

    client.submit_attestation(&1_000_000i128, &1_200_000i128, &signers);
    assert!(client.is_fully_backed());
}

#[test]
fn is_fully_backed_false_when_reserves_fall_short() {
    let env = Env::default();
    let (client, _admin, auditors) = setup(&env, 1, 1);
    let signers = svec![&env, auditors[0].clone()];

    client.submit_attestation(&1_000_000i128, &900_000i128, &signers);
    assert!(!client.is_fully_backed());
}

#[test]
fn stale_attestation_is_rejected_by_is_fully_backed() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1_000);
    let (client, _admin, auditors) = setup(&env, 1, 1);
    let signers = svec![&env, auditors[0].clone()];

    client.submit_attestation(&1_000_000i128, &1_000_000i128, &signers);

    env.ledger()
        .with_mut(|li| li.timestamp = 1_000 + MAX_ATTESTATION_AGE_SECONDS + 1);

    let result = client.try_is_fully_backed();
    assert_eq!(result, Err(Ok(ProofOfReserveError::StaleAttestation)));
}

#[test]
fn attestation_exactly_at_the_staleness_boundary_is_still_fresh() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1_000);
    let (client, _admin, auditors) = setup(&env, 1, 1);
    let signers = svec![&env, auditors[0].clone()];

    client.submit_attestation(&1_000_000i128, &1_000_000i128, &signers);

    env.ledger()
        .with_mut(|li| li.timestamp = 1_000 + MAX_ATTESTATION_AGE_SECONDS);

    let result = client.try_is_fully_backed();
    assert!(result.is_ok());
}

#[test]
fn reserve_ratio_bps_reports_exact_backing_ratio() {
    let env = Env::default();
    let (client, _admin, auditors) = setup(&env, 1, 1);
    let signers = svec![&env, auditors[0].clone()];

    // 1,100,000 / 1,000,000 = 1.1 = 11,000 bps.
    client.submit_attestation(&1_000_000i128, &1_100_000i128, &signers);
    assert_eq!(client.reserve_ratio_bps(), 11_000);
}

#[test]
fn reserve_ratio_bps_rejects_stale_attestation() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1_000);
    let (client, _admin, auditors) = setup(&env, 1, 1);
    let signers = svec![&env, auditors[0].clone()];

    client.submit_attestation(&1_000_000i128, &1_000_000i128, &signers);
    env.ledger()
        .with_mut(|li| li.timestamp = 1_000 + MAX_ATTESTATION_AGE_SECONDS + 1);

    assert_eq!(
        client.try_reserve_ratio_bps(),
        Err(Ok(ProofOfReserveError::StaleAttestation))
    );
}

#[test]
fn freshness_update_cannot_execute_without_a_scheduled_update() {
    let env = Env::default();
    let (client, _admin, _auditors) = setup(&env, 1, 1);

    assert_eq!(
        client.try_execute_freshness_update(),
        Err(Ok(ProofOfReserveError::NoPendingFreshnessUpdate))
    );
}

#[test]
fn freshness_update_waits_for_the_timelock_and_is_then_enforced() {
    let env = Env::default();
    env.ledger().with_mut(|li| li.timestamp = 1_000);
    let (client, _admin, auditors) = setup(&env, 1, 1);

    assert_eq!(
        client.max_attestation_age_seconds(),
        DEFAULT_MAX_ATTESTATION_AGE_SECONDS
    );

    let new_window = 6 * 60 * 60;
    client.schedule_freshness_update(&new_window);

    let pending = client.pending_freshness_update().unwrap();
    assert_eq!(pending.new_max_age_seconds, new_window);
    assert_eq!(
        pending.executable_at,
        1_000 + FRESHNESS_UPDATE_TIMELOCK_SECONDS
    );

    // One second before the timelock elapses the update is not applied.
    env.ledger()
        .with_mut(|li| li.timestamp = 1_000 + FRESHNESS_UPDATE_TIMELOCK_SECONDS - 1);
    assert_eq!(
        client.try_execute_freshness_update(),
        Err(Ok(ProofOfReserveError::FreshnessUpdateTimelockActive))
    );
    assert_eq!(
        client.max_attestation_age_seconds(),
        DEFAULT_MAX_ATTESTATION_AGE_SECONDS
    );

    env.ledger()
        .with_mut(|li| li.timestamp = 1_000 + FRESHNESS_UPDATE_TIMELOCK_SECONDS);
    client.execute_freshness_update();

    assert_eq!(client.max_attestation_age_seconds(), new_window);
    assert!(client.pending_freshness_update().is_none());

    // The new six-hour window — not the old 24-hour default — is what
    // the freshness check now applies.
    let signers = svec![&env, auditors[0].clone()];
    client.submit_attestation(&1_000_000i128, &1_000_000i128, &signers);

    env.ledger()
        .with_mut(|li| li.timestamp = 1_000 + FRESHNESS_UPDATE_TIMELOCK_SECONDS + new_window);
    assert!(client.try_is_fully_backed().is_ok());

    env.ledger()
        .with_mut(|li| li.timestamp = 1_000 + FRESHNESS_UPDATE_TIMELOCK_SECONDS + new_window + 1);
    assert_eq!(
        client.try_is_fully_backed(),
        Err(Ok(ProofOfReserveError::StaleAttestation))
    );
}

#[test]
fn freshness_update_rejects_a_zero_window() {
    let env = Env::default();
    let (client, _admin, _auditors) = setup(&env, 1, 1);

    assert_eq!(
        client.try_schedule_freshness_update(&0u64),
        Err(Ok(ProofOfReserveError::InvalidFreshnessWindow))
    );
}

#[test]
fn freshness_update_requires_admin_auth() {
    let env = Env::default();
    let (client, _admin, _auditors) = setup(&env, 1, 1);

    env.set_auths(&[]);
    assert!(client.try_schedule_freshness_update(&3_600u64).is_err());
    assert!(client.try_execute_freshness_update().is_err());
}

#[test]
fn no_attestation_yet_is_reported_distinctly_from_stale() {
    let env = Env::default();
    let (client, _admin, _auditors) = setup(&env, 1, 1);

    assert_eq!(
        client.try_latest_attestation(),
        Err(Ok(ProofOfReserveError::NoAttestation))
    );
    assert_eq!(
        client.try_is_fully_backed(),
        Err(Ok(ProofOfReserveError::NoAttestation))
    );
}

#[test]
fn initialize_rejects_a_threshold_of_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let auditors = svec![&env, Address::generate(&env)];

    let contract_id = env.register(ProofOfReserveContract, ());
    let client = ProofOfReserveContractClient::new(&env, &contract_id);

    let result = client.try_initialize(&admin, &auditors, &0u32);
    assert_eq!(result, Err(Ok(ProofOfReserveError::InvalidThreshold)));
}

#[test]
fn initialize_rejects_a_threshold_above_auditor_count() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let auditors = svec![&env, Address::generate(&env)];

    let contract_id = env.register(ProofOfReserveContract, ());
    let client = ProofOfReserveContractClient::new(&env, &contract_id);

    let result = client.try_initialize(&admin, &auditors, &2u32);
    assert_eq!(result, Err(Ok(ProofOfReserveError::InvalidThreshold)));
}

#[test]
fn double_initialize_is_rejected() {
    let env = Env::default();
    let (client, admin, auditors) = setup(&env, 1, 1);

    let mut auditors_vec = Vec::new(&env);
    for a in &auditors {
        auditors_vec.push_back(a.clone());
    }

    let result = client.try_initialize(&admin, &auditors_vec, &1u32);
    assert_eq!(result, Err(Ok(ProofOfReserveError::AlreadyInitialized)));
}

#[test]
fn submit_attestation_requires_each_listed_signers_own_auth() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let auditor1 = Address::generate(&env);
    let auditor2 = Address::generate(&env);

    let mut auditors_vec = Vec::new(&env);
    auditors_vec.push_back(auditor1.clone());
    auditors_vec.push_back(auditor2.clone());

    let contract_id = env.register(ProofOfReserveContract, ());
    let client = ProofOfReserveContractClient::new(&env, &contract_id);

    env.mock_all_auths();
    client.initialize(&admin, &auditors_vec, &2u32);

    // Only auditor1 actually authorizes; auditor2 is listed but never
    // signs.
    env.set_auths(&[]);
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &auditor1,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &contract_id,
            fn_name: "submit_attestation",
            args: (
                1_000_000i128,
                1_000_000i128,
                svec![&env, auditor1.clone(), auditor2.clone()],
            )
                .into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let signers = svec![&env, auditor1.clone(), auditor2.clone()];
    let result = client.try_submit_attestation(&1_000_000i128, &1_000_000i128, &signers);
    assert!(result.is_err());
}

// ── Ed25519 custodian attestation coverage (issue #2421) ─────────────────────

fn signing_key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn sign_snapshot(
    env: &Env,
    key: &SigningKey,
    on_chain_supply: i128,
    reserve_balance: i128,
    attested_at: u64,
) -> (BytesN<32>, BytesN<64>) {
    let public_key = BytesN::from_array(env, key.verifying_key().as_bytes());
    let message = ProofOfReserveContract::snapshot_message(
        env,
        on_chain_supply,
        reserve_balance,
        attested_at,
    );
    let signature: [u8; 64] = key.sign(&message.to_alloc_vec()).to_bytes();
    (public_key, BytesN::from_array(env, &signature))
}

fn setup_signed(env: &Env) -> (ProofOfReserveContractClient<'_>, Vec<Address>, SigningKey) {
    env.ledger().with_mut(|li| li.timestamp = 1_000);
    let (client, _admin, auditors) = setup(env, 1, 1);
    let key = signing_key();
    let (public_key, _) = sign_snapshot(env, &key, 0, 0, 1_000);
    client.register_custodian_key(&public_key);
    (client, svec![env, auditors[0].clone()], key)
}

#[test]
fn ed25519_signed_attestation_is_verified_and_stored() {
    let env = Env::default();
    let (client, signers, key) = setup_signed(&env);
    let (public_key, signature) = sign_snapshot(&env, &key, 1_000_000, 1_100_000, 1_000);

    client.verify_signed_attestation(
        &1_000_000i128,
        &1_100_000i128,
        &1_000u64,
        &public_key,
        &signature,
        &signers,
    );

    let record = client.latest_attestation();
    assert_eq!(record.on_chain_supply, 1_000_000);
    assert_eq!(record.reserve_balance, 1_100_000);
    assert_eq!(record.attested_at, 1_000);
    assert_eq!(client.reserve_ratio_bps(), 11_000);
    assert!(client.is_fully_backed());
}

#[test]
fn tampered_signature_is_rejected() {
    let env = Env::default();
    let (client, signers, key) = setup_signed(&env);
    // Signature is over 1_100_000; the caller claims 1_200_000. Both are
    // above supply, so this isolates signature verification from the
    // under-reserve guard.
    let (public_key, signature) = sign_snapshot(&env, &key, 1_000_000, 1_100_000, 1_000);

    let result = client.try_verify_signed_attestation(
        &1_000_000i128,
        &1_200_000i128,
        &1_000u64,
        &public_key,
        &signature,
        &signers,
    );
    assert!(result.is_err());
    assert!(client.try_latest_attestation().is_err());
}

#[test]
fn under_reserve_attestation_is_rejected() {
    let env = Env::default();
    let (client, signers, key) = setup_signed(&env);
    let (public_key, signature) = sign_snapshot(&env, &key, 1_000_000, 1_000_000, 1_000);

    assert_eq!(
        client.try_verify_signed_attestation(
            &1_100_000i128,
            &1_000_000i128,
            &1_000u64,
            &public_key,
            &signature,
            &signers,
        ),
        Err(Ok(ProofOfReserveError::UnderReserve))
    );
}

#[test]
fn unregistered_custodian_key_is_rejected() {
    let env = Env::default();
    let (client, signers, _key) = setup_signed(&env);
    let rogue_key = SigningKey::from_bytes(&[9u8; 32]);
    let (public_key, signature) = sign_snapshot(&env, &rogue_key, 1_000_000, 1_000_000, 1_000);

    assert_eq!(
        client.try_verify_signed_attestation(
            &1_000_000i128,
            &1_000_000i128,
            &1_000u64,
            &public_key,
            &signature,
            &signers,
        ),
        Err(Ok(ProofOfReserveError::UnauthorizedCustodian))
    );
}

#[test]
fn signed_snapshot_timestamp_must_match_ledger() {
    let env = Env::default();
    let (client, signers, key) = setup_signed(&env);
    let (public_key, signature) = sign_snapshot(&env, &key, 1_000_000, 1_000_000, 1_000);

    assert_eq!(
        client.try_verify_signed_attestation(
            &1_000_000i128,
            &1_000_000i128,
            &999u64,
            &public_key,
            &signature,
            &signers,
        ),
        Err(Ok(ProofOfReserveError::AttestationTimestampMismatch))
    );
}

#[test]
fn duplicating_a_custodian_key_is_rejected() {
    let env = Env::default();
    let (client, _signers, key) = setup_signed(&env);
    let (public_key, _) = sign_snapshot(&env, &key, 0, 0, 1_000);

    assert_eq!(
        client.try_register_custodian_key(&public_key),
        Err(Ok(ProofOfReserveError::CustodianAlreadyRegistered))
    );
}
