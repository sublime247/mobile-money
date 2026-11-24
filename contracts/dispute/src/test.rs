extern crate std;

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{vec, Address, BytesN, Env};

struct Setup<'a> {
    client: DisputeContractClient<'a>,
    buyer: Address,
    seller: Address,
    mediator: Address,
    outsider: Address,
}

fn setup(env: &Env) -> Setup<'_> {
    env.mock_all_auths();
    let buyer = Address::generate(env);
    let seller = Address::generate(env);
    let mediator = Address::generate(env);
    let outsider = Address::generate(env);

    let contract_id = env.register(DisputeContract, ());
    let client = DisputeContractClient::new(env, &contract_id);
    client.open_dispute(&7, &buyer, &seller, &mediator);

    Setup {
        client,
        buyer,
        seller,
        mediator,
        outsider,
    }
}

fn hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

#[test]
fn all_three_dispute_roles_can_anchor_evidence() {
    let env = Env::default();
    let s = setup(&env);

    s.client.submit_evidence_hash(&7, &s.buyer, &hash(&env, 1));
    s.client.submit_evidence_hash(&7, &s.seller, &hash(&env, 2));
    s.client
        .submit_evidence_hash(&7, &s.mediator, &hash(&env, 3));

    let evidence = s.client.get_evidence_hashes(&7);
    assert_eq!(
        evidence,
        vec![&env, hash(&env, 1), hash(&env, 2), hash(&env, 3)]
    );
    assert_eq!(s.client.get_dispute(&7).evidence_count, 3);
}

#[test]
fn unauthorized_submitter_cannot_anchor_evidence() {
    let env = Env::default();
    let s = setup(&env);

    assert_eq!(
        s.client
            .try_submit_evidence_hash(&7, &s.outsider, &hash(&env, 9)),
        Err(Ok(DisputeError::UnauthorizedSubmitter))
    );
    assert_eq!(s.client.get_evidence_hashes(&7).len(), 0);
}

#[test]
fn evidence_is_capped_at_ten_entries() {
    let env = Env::default();
    let s = setup(&env);

    for seed in 1..=10u8 {
        s.client
            .submit_evidence_hash(&7, &s.buyer, &hash(&env, seed));
    }
    assert_eq!(s.client.get_evidence_hashes(&7).len(), 10);
    assert_eq!(s.client.get_dispute(&7).evidence_count, 10);

    assert_eq!(
        s.client
            .try_submit_evidence_hash(&7, &s.buyer, &hash(&env, 11)),
        Err(Ok(DisputeError::EvidenceLimitReached))
    );
    assert_eq!(s.client.get_evidence_hashes(&7).len(), 10);
}

#[test]
fn unknown_dispute_and_duplicate_open_are_rejected() {
    let env = Env::default();
    let s = setup(&env);

    assert_eq!(
        s.client.try_get_evidence_hashes(&8),
        Err(Ok(DisputeError::NotFound))
    );
    assert_eq!(
        s.client
            .try_submit_evidence_hash(&8, &s.buyer, &hash(&env, 1)),
        Err(Ok(DisputeError::NotFound))
    );
    assert_eq!(
        s.client
            .try_open_dispute(&7, &s.buyer, &s.seller, &s.mediator),
        Err(Ok(DisputeError::AlreadyExists))
    );
}
