#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env, Vec};

#[contracttype]
#[derive(Clone)]
pub struct HtlcState {
    pub sender: Address,
    pub receiver: Address,
    pub token: Address,
    pub amount: i128,
    pub hashlock: BytesN<32>,
    pub timelock: u64,
    pub claimed: bool,
    pub refunded: bool,
    pub approved_signers: Vec<Address>,
    pub required_signatures: u32,
}

const HTLC: &str = "HTLC";

#[contract]
pub struct HtlcContract;

#[contractimpl]
impl HtlcContract {
    /// Initialize the HTLC. The sender must authorize this call and
    /// transfer `amount` tokens into the contract's own account.
    /// Optionally provide a list of approved signers and required signature count for multi-sig approval.
    pub fn initialize(
        env: Env,
        sender: Address,
        receiver: Address,
        token: Address,
        amount: i128,
        hashlock: BytesN<32>,
        timelock: u64,
        approved_signers: Vec<Address>,
        required_signatures: u32,
    ) {
        sender.require_auth();

        assert!(amount > 0, "amount must be positive");
        assert!(!env.storage().instance().has(&HTLC), "already initialised");

        // Ensure timelock is in the future
        assert!(
            timelock > env.ledger().timestamp(),
            "timelock must be in the future"
        );

        // Validate multi-sig parameters if provided
        if !approved_signers.is_empty() {
            assert!(
                required_signatures > 0 && required_signatures <= approved_signers.len(),
                "required_signatures must be between 1 and number of approved signers"
            );
        }

        // Pull funds from the sender into this contract.
        token::Client::new(&env, &token).transfer(&sender, env.current_contract_address(), &amount);

        env.storage().instance().set(
            &HTLC,
            &HtlcState {
                sender,
                receiver,
                token,
                amount,
                hashlock,
                timelock,
                claimed: false,
                refunded: false,
                approved_signers,
                required_signatures,
            },
        );

        // Extend the TTL of the instance storage to set up state renewal rules
        env.storage().instance().extend_ttl(1000, 10000);
    }

    /// Claim funds by providing the preimage.
    /// If multi-sig is enabled, requires authorization from the required number of approved signers.
    pub fn claim(env: Env, preimage: BytesN<32>, signers: Vec<Address>) {
        let mut state: HtlcState = env
            .storage()
            .instance()
            .get(&HTLC)
            .expect("not initialised");

        assert!(!state.claimed, "already claimed");
        assert!(!state.refunded, "already refunded");

        // Verify the hash of the preimage matches the hashlock
        let hash: BytesN<32> = env.crypto().sha256(&preimage.into()).into();
        assert!(hash == state.hashlock, "invalid preimage");

        // Multi-signature verification if approved signers are configured
        if !state.approved_signers.is_empty() {
            // Verify each signer is in the approved list and has authorized
            let mut valid_signature_count = 0u32;
            for signer in signers.iter() {
                // Check if signer is in approved list
                let is_approved = state
                    .approved_signers
                    .iter()
                    .any(|approved| approved == signer);
                assert!(is_approved, "signer not in approved list");

                // Require authorization from each signer
                signer.require_auth();
                valid_signature_count += 1;
            }

            assert!(
                valid_signature_count >= state.required_signatures,
                "insufficient signatures: required {}, got {}",
                state.required_signatures,
                valid_signature_count
            );
        } else {
            // If no multi-sig configured, receiver must authorize
            state.receiver.require_auth();
        }

        // Transfer funds to the receiver
        token::Client::new(&env, &state.token).transfer(
            &env.current_contract_address(),
            &state.receiver,
            &state.amount,
        );

        state.claimed = true;
        env.storage().instance().set(&HTLC, &state);

        env.storage().instance().extend_ttl(1000, 10000);
    }

    /// Refund funds to the sender after the timelock has expired.
    pub fn refund(env: Env) {
        let mut state: HtlcState = env
            .storage()
            .instance()
            .get(&HTLC)
            .expect("not initialised");

        assert!(!state.claimed, "already claimed");
        assert!(!state.refunded, "already refunded");

        // Check if timelock has expired
        assert!(
            env.ledger().timestamp() >= state.timelock,
            "timelock not yet expired"
        );

        // Transfer funds back to the sender
        token::Client::new(&env, &state.token).transfer(
            &env.current_contract_address(),
            &state.sender,
            &state.amount,
        );

        state.refunded = true;
        env.storage().instance().set(&HTLC, &state);

        env.storage().instance().extend_ttl(1000, 10000);
    }

    /// Return current HTLC state (read-only).
    pub fn get_state(env: Env) -> HtlcState {
        let state = env
            .storage()
            .instance()
            .get(&HTLC)
            .expect("not initialised");
        env.storage().instance().extend_ttl(1000, 10000);
        state
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Address, BytesN, Env,
    };

    fn setup(
        custom_issuer: Option<Address>,
    ) -> (Env, Address, Address, Address, HtlcContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();

        let sender = Address::generate(&env);
        let receiver = Address::generate(&env);

        // Deploy a test SAC token.
        let token_admin = custom_issuer.unwrap_or_else(|| Address::generate(&env));
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_sac = StellarAssetClient::new(&env, &token_id.address());
        token_sac.mint(&sender, &1_000_000);

        let contract_id = env.register(HtlcContract, ());
        let client = HtlcContractClient::new(&env, &contract_id);

        (env, sender, receiver, token_id.address(), client)
    }

    #[test]
    fn test_htlc_happy_path() {
        let (env, sender, receiver, token, client) = setup(None);
        let amount: i128 = 500_000;

        let preimage = BytesN::from_array(&env, &[1; 32]);
        let hashlock: BytesN<32> = env.crypto().sha256(&preimage.clone().into()).into();
        let timelock = 1000;

        env.ledger().set_timestamp(100);

        // Initialize without multi-sig (empty approved_signers)
        let approved_signers: Vec<Address> = Vec::new(&env);
        let required_signatures = 0u32;
        client.initialize(
            &sender,
            &receiver,
            &token,
            &amount,
            &hashlock,
            &timelock,
            &approved_signers,
            &required_signatures,
        );

        let state = client.get_state();
        assert_eq!(state.amount, amount);
        assert!(!state.claimed);

        // Claim with empty signers (receiver auth only)
        let signers: Vec<Address> = Vec::new(&env);
        client.claim(&preimage, &signers);

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&receiver), amount);
        assert!(client.get_state().claimed);
    }

    #[test]
    fn test_htlc_refund() {
        let (env, sender, receiver, token, client) = setup(None);
        let amount: i128 = 500_000;

        let preimage = BytesN::from_array(&env, &[1; 32]);
        let hashlock: BytesN<32> = env.crypto().sha256(&preimage.clone().into()).into();
        let timelock = 1000;

        env.ledger().set_timestamp(100);

        // Initialize without multi-sig
        let approved_signers: Vec<Address> = Vec::new(&env);
        let required_signatures = 0u32;
        client.initialize(
            &sender,
            &receiver,
            &token,
            &amount,
            &hashlock,
            &timelock,
            &approved_signers,
            &required_signatures,
        );

        // Jump to after timelock
        env.ledger().set_timestamp(1001);

        client.refund();

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&sender), 1_000_000);
        assert!(client.get_state().refunded);
    }

    #[test]
    fn test_setup_with_custom_issuer() {
        let env = Env::default();
        let custom_issuer = Address::generate(&env);
        let (env_out, _sender, _receiver, token, _client) = setup(Some(custom_issuer.clone()));

        // Verify the custom_issuer address can mint successfully (confirming it is the admin/issuer of the SAC token)
        let token_sac = StellarAssetClient::new(&env_out, &token);
        let recipient = Address::generate(&env_out);
        token_sac.mint(&recipient, &100);

        let token_client = TokenClient::new(&env_out, &token);
        assert_eq!(token_client.balance(&recipient), 100);
    }

    #[test]
    fn test_multisig_claim() {
        let (env, sender, receiver, token, client) = setup(None);
        let amount: i128 = 500_000;

        let preimage = BytesN::from_array(&env, &[1; 32]);
        let hashlock: BytesN<32> = env.crypto().sha256(&preimage.clone().into()).into();
        let timelock = 1000;

        env.ledger().set_timestamp(100);

        // Create approved signers
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let signer3 = Address::generate(&env);

        let mut approved_signers: Vec<Address> = Vec::new(&env);
        approved_signers.push_back(signer1.clone());
        approved_signers.push_back(signer2.clone());
        approved_signers.push_back(signer3.clone());

        let required_signatures = 2u32; // Require 2 out of 3 signatures
        client.initialize(
            &sender,
            &receiver,
            &token,
            &amount,
            &hashlock,
            &timelock,
            &approved_signers,
            &required_signatures,
        );

        let state = client.get_state();
        assert_eq!(state.amount, amount);
        assert_eq!(state.approved_signers.len(), 3);
        assert_eq!(state.required_signatures, 2);
        assert!(!state.claimed);

        // Claim with 2 signers (meets requirement)
        let mut signers: Vec<Address> = Vec::new(&env);
        signers.push_back(signer1.clone());
        signers.push_back(signer2.clone());
        client.claim(&preimage, &signers);

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&receiver), amount);
        assert!(client.get_state().claimed);
    }

    #[test]
    fn test_multisig_insufficient_signatures() {
        let (env, sender, receiver, token, client) = setup(None);
        let amount: i128 = 500_000;

        let preimage = BytesN::from_array(&env, &[1; 32]);
        let hashlock: BytesN<32> = env.crypto().sha256(&preimage.clone().into()).into();
        let timelock = 1000;

        env.ledger().set_timestamp(100);

        // Create approved signers
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let signer3 = Address::generate(&env);

        let mut approved_signers: Vec<Address> = Vec::new(&env);
        approved_signers.push_back(signer1.clone());
        approved_signers.push_back(signer2.clone());
        approved_signers.push_back(signer3.clone());

        let required_signatures = 2u32; // Require 2 out of 3 signatures
        client.initialize(
            &sender,
            &receiver,
            &token,
            &amount,
            &hashlock,
            &timelock,
            &approved_signers,
            &required_signatures,
        );

        // Try to claim with only 1 signer (insufficient)
        let mut signers: Vec<Address> = Vec::new(&env);
        signers.push_back(signer1.clone());

        let result = client.try_claim(&preimage, &signers);
        assert!(
            result.is_err(),
            "claim should fail with insufficient signatures"
        );
    }

    #[test]
    fn test_multisig_unapproved_signer() {
        let (env, sender, receiver, token, client) = setup(None);
        let amount: i128 = 500_000;

        let preimage = BytesN::from_array(&env, &[1; 32]);
        let hashlock: BytesN<32> = env.crypto().sha256(&preimage.clone().into()).into();
        let timelock = 1000;

        env.ledger().set_timestamp(100);

        // Create approved signers
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);

        let mut approved_signers: Vec<Address> = Vec::new(&env);
        approved_signers.push_back(signer1.clone());
        approved_signers.push_back(signer2.clone());

        let required_signatures = 1u32;
        client.initialize(
            &sender,
            &receiver,
            &token,
            &amount,
            &hashlock,
            &timelock,
            &approved_signers,
            &required_signatures,
        );

        // Try to claim with an unapproved signer
        let unapproved_signer = Address::generate(&env);
        let mut signers: Vec<Address> = Vec::new(&env);
        signers.push_back(unapproved_signer);

        let result = client.try_claim(&preimage, &signers);
        assert!(result.is_err(), "claim should fail with unapproved signer");
    }

    #[test]
    fn test_multisig_invalid_required_signatures() {
        let (env, sender, receiver, token, client) = setup(None);
        let amount: i128 = 500_000;

        let preimage = BytesN::from_array(&env, &[1; 32]);
        let hashlock: BytesN<32> = env.crypto().sha256(&preimage.clone().into()).into();
        let timelock = 1000;

        env.ledger().set_timestamp(100);

        // Create approved signers
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);

        let mut approved_signers: Vec<Address> = Vec::new(&env);
        approved_signers.push_back(signer1.clone());
        approved_signers.push_back(signer2.clone());

        // Try to initialize with required_signatures > approved_signers.len()
        let required_signatures = 3u32; // More than available signers

        let result = client.try_initialize(
            &sender,
            &receiver,
            &token,
            &amount,
            &hashlock,
            &timelock,
            &approved_signers,
            &required_signatures,
        );
        assert!(
            result.is_err(),
            "initialize should fail with invalid required_signatures"
        );
    }

    #[test]
    fn test_htlc_refund_before_timelock_fails() {
        let (env, sender, receiver, token, client) = setup(None);
        let amount: i128 = 500_000;

        let preimage = BytesN::from_array(&env, &[1; 32]);
        let hashlock: BytesN<32> = env.crypto().sha256(&preimage.clone().into()).into();
        let timelock = 1000;

        env.ledger().set_timestamp(100);

        let approved_signers: Vec<Address> = Vec::new(&env);
        let required_signatures = 0u32;
        client.initialize(
            &sender,
            &receiver,
            &token,
            &amount,
            &hashlock,
            &timelock,
            &approved_signers,
            &required_signatures,
        );

        // Try to refund exactly one second before timelock
        env.ledger().set_timestamp(999);

        let result = client.try_refund();
        assert!(
            result.is_err(),
            "refund should fail before timelock expires"
        );
    }

    #[test]
    fn test_htlc_refund_exact_timelock() {
        let (env, sender, receiver, token, client) = setup(None);
        let amount: i128 = 500_000;

        let preimage = BytesN::from_array(&env, &[1; 32]);
        let hashlock: BytesN<32> = env.crypto().sha256(&preimage.clone().into()).into();
        let timelock = 1000;

        env.ledger().set_timestamp(100);

        let approved_signers: Vec<Address> = Vec::new(&env);
        let required_signatures = 0u32;
        client.initialize(
            &sender,
            &receiver,
            &token,
            &amount,
            &hashlock,
            &timelock,
            &approved_signers,
            &required_signatures,
        );

        // Time reaches exactly the timelock
        env.ledger().set_timestamp(1000);

        client.refund();

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&sender), 1_000_000);
        assert!(client.get_state().refunded);
    }
}
