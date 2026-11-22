#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Bytes, Env, Address, Vec};

fn create_token_contract<'a>(e: &Env, admin: &Address) -> stellar_sdk::token::Client<'a> {
    let contract_address = e.register_stellar_asset_contract(admin.clone());
    stellar_sdk::token::Client::new(e, &contract_address)
}

#[test]
fn test_htlc_happy_path() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token = create_token_contract(&env, &admin);
    let token_address = token.address.clone();

    let htlc_id = env.register(HtlcContract, ());
    let htlc_client = HtlcContractClient::new(&env, &htlc_id);

    let amount = 100_000i128;
    token.mint(&sender, &amount);

    let preimage = Bytes::from_slice(&env, b"secret preimage");
    let hashlock = env.crypto().sha256(&preimage);
    let timelock = 1000u64;

    htlc_client.initialize(
        &sender,
        &recipient,
        &token_address,
        &amount,
        &hashlock,
        &timelock,
        &Vec::new(&env),
        &0,
    );

    assert_eq!(token.balance(&htlc_id), amount);
    assert_eq!(token.balance(&recipient), 0);

    htlc_client.claim(&preimage);

    assert_eq!(token.balance(&htlc_id), 0);
    assert_eq!(token.balance(&recipient), amount);
}

#[test]
fn test_htlc_invalid_preimage_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token = create_token_contract(&env, &admin);
    let token_address = token.address.clone();

    let htlc_id = env.register(HtlcContract, ());
    let htlc_client = HtlcContractClient::new(&env, &htlc_id);

    let amount = 100_000i128;
    token.mint(&sender, &amount);

    let preimage = Bytes::from_slice(&env, b"secret preimage");
    let wrong_preimage = Bytes::from_slice(&env, b"wrong preimage");
    let hashlock = env.crypto().sha256(&preimage);
    let timelock = 1000u64;

    htlc_client.initialize(
        &sender,
        &recipient,
        &token_address,
        &amount,
        &hashlock,
        &timelock,
        &Vec::new(&env),
        &0,
    );

    let res = htlc_client.try_claim(&wrong_preimage);
    assert!(res.is_err());
}

#[test]
fn test_htlc_double_claim_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token = create_token_contract(&env, &admin);
    let token_address = token.address.clone();

    let htlc_id = env.register(HtlcContract, ());
    let htlc_client = HtlcContractClient::new(&env, &htlc_id);

    let amount = 100_000i128;
    token.mint(&sender, &amount);

    let preimage = Bytes::from_slice(&env, b"secret preimage");
    let hashlock = env.crypto().sha256(&preimage);
    let timelock = 1000u64;

    htlc_client.initialize(
        &sender,
        &recipient,
        &token_address,
        &amount,
        &hashlock,
        &timelock,
        &Vec::new(&env),
        &0,
    );

    htlc_client.claim(&preimage);

    let res = htlc_client.try_claim(&preimage);
    assert!(res.is_err());
}

#[test]
fn test_htlc_refund_after_timelock() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token = create_token_contract(&env, &admin);
    let token_address = token.address.clone();

    let htlc_id = env.register(HtlcContract, ());
    let htlc_client = HtlcContractClient::new(&env, &htlc_id);

    let amount = 100_000i128;
    token.mint(&sender, &amount);

    let preimage = Bytes::from_slice(&env, b"secret preimage");
    let hashlock = env.crypto().sha256(&preimage);
    let timelock = 1000u64;

    htlc_client.initialize(
        &sender,
        &recipient,
        &token_address,
        &amount,
        &hashlock,
        &timelock,
        &Vec::new(&env),
        &0,
    );

    env.ledger().set(soroban_sdk::testutils::LedgerInfo {
        timestamp: timelock,
        protocol_version: 20,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 10,
        min_persistent_entry_ttl: 10,
        min_temp_entry_ttl: 10,
        max_entry_ttl: 100,
    });

    assert_eq!(token.balance(&sender), 0);
    htlc_client.refund();
    assert_eq!(token.balance(&sender), amount);
}

#[test]
fn test_htlc_refund_before_timelock_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let token = create_token_contract(&env, &admin);
    let token_address = token.address.clone();

    let htlc_id = env.register(HtlcContract, ());
    let htlc_client = HtlcContractClient::new(&env, &htlc_id);

    let amount = 100_000i128;
    token.mint(&sender, &amount);

    let preimage = Bytes::from_slice(&env, b"secret preimage");
    let hashlock = env.crypto().sha256(&preimage);
    let timelock = 1000u64;

    htlc_client.initialize(
        &sender,
        &recipient,
        &token_address,
        &amount,
        &hashlock,
        &timelock,
        &Vec::new(&env),
        &0,
    );

    env.ledger().set(soroban_sdk::testutils::LedgerInfo {
        timestamp: timelock - 1,
        protocol_version: 20,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 10,
        min_persistent_entry_ttl: 10,
        min_temp_entry_ttl: 10,
        max_entry_ttl: 100,
    });

    let res = htlc_client.try_refund();
    assert!(res.is_err());
}
