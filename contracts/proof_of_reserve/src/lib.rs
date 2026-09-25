#![no_std]
//! Cryptographic proof-of-reserve verification contract (issue #2004).
//!
//! Lets an anchor's off-chain fiat float be attested on-chain, periodically,
//! by a configured set of authorized auditors, so anyone can publicly query
//! whether the anchor's on-chain token supply is still backed 1:1 by real
//! fiat reserves.
//!
//! ## What "cryptographically signed" means here
//!
//! Attestations are authorized via Soroban's own account/contract auth
//! (`Address::require_auth`) from a configured auditor address, the same
//! pattern this repo's `escrow` contract uses for its multi-sig upgrade
//! path (see `contracts/escrow/src/lib.rs::upgrade`). This is a real
//! cryptographic signature check: the network verifies the auditor
//! account's actual signature against the transaction before `require_auth`
//! succeeds. The contract does not additionally verify raw ed25519 bytes
//! itself, since Soroban's native auth framework already is that
//! verification and is the idiomatic way to require "signed by an
//! authorized key" on this platform.
//!
//! ## Threshold
//!
//! `required_signatures` (configured at `initialize`, matching escrow's
//! `required_admin_signatures` shape) is the minimum number of distinct
//! authorized auditors that must co-sign a single `submit_attestation`
//! call for it to be accepted. Set to `1` for a single-auditor deployment.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short, Address, Env,
    Symbol, Vec,
};

const ADMIN: Symbol = symbol_short!("ADMIN");
const AUDITORS: Symbol = symbol_short!("AUDITORS");
const REQ_SIGS: Symbol = symbol_short!("REQ_SIGS");
const LATEST: Symbol = symbol_short!("LATEST");

/// An attestation older than this many seconds is rejected by
/// `is_fully_backed`/`latest_attestation` callers that care about
/// freshness (the query itself still returns the stale record; staleness
/// is a property of the record relative to "now", not the storage layer).
pub const MAX_ATTESTATION_AGE_SECONDS: u64 = 24 * 60 * 60;

#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum ProofOfReserveError {
    /// Contract has already been initialized.
    AlreadyInitialized = 1,
    /// Contract must be initialized before this call.
    NotInitialized = 2,
    /// `required_signatures` was 0 or exceeded the number of auditors.
    InvalidThreshold = 3,
    /// A signer passed to `submit_attestation` is not an authorized auditor.
    UnauthorizedAuditor = 4,
    /// Fewer distinct authorized auditors signed than `required_signatures`.
    InsufficientSignatures = 5,
    /// `on_chain_supply` or `reserve_balance` was negative.
    InvalidAmount = 6,
    /// No attestation has ever been submitted.
    NoAttestation = 7,
    /// The latest attestation is older than `MAX_ATTESTATION_AGE_SECONDS`.
    AttestationStale = 8,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Attestation {
    /// Total on-chain token supply this attestation covers.
    pub on_chain_supply: i128,
    /// Off-chain fiat reserve balance, in the same unit/decimals as
    /// `on_chain_supply`, as reported by the auditors.
    pub reserve_balance: i128,
    /// Ledger timestamp this attestation was submitted.
    pub attested_at: u64,
    /// The distinct authorized auditors who co-signed this attestation.
    pub signers: Vec<Address>,
}

#[contractevent(topics = ["proof_of_reserve", "attestation_submitted"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttestationSubmitted {
    #[topic]
    pub attested_at: u64,
    pub on_chain_supply: i128,
    pub reserve_balance: i128,
    pub signer_count: u32,
}

#[contract]
pub struct ProofOfReserveContract;

#[contractimpl]
impl ProofOfReserveContract {
    /// Initialize the contract. Callable exactly once.
    ///
    /// `required_signatures` must be between 1 and `auditors.len()`
    /// inclusive.
    pub fn initialize(
        env: Env,
        admin: Address,
        auditors: Vec<Address>,
        required_signatures: u32,
    ) -> Result<(), ProofOfReserveError> {
        if env.storage().instance().has(&ADMIN) {
            return Err(ProofOfReserveError::AlreadyInitialized);
        }
        if required_signatures == 0 || required_signatures > auditors.len() {
            return Err(ProofOfReserveError::InvalidThreshold);
        }

        admin.require_auth();

        env.storage().instance().set(&ADMIN, &admin);
        env.storage().instance().set(&AUDITORS, &auditors);
        env.storage()
            .instance()
            .set(&REQ_SIGS, &required_signatures);
        env.storage().instance().extend_ttl(1000, 10000);

        Ok(())
    }

    /// Submit a new reserve attestation, co-signed by at least
    /// `required_signatures` distinct authorized auditors.
    ///
    /// `signers` must be exactly the set of auditors co-signing this
    /// specific attestation: every entry is checked against the
    /// authorized auditor list AND is required to actually authorize this
    /// call (`require_auth`), so a caller cannot claim a signature that
    /// was not really given.
    pub fn submit_attestation(
        env: Env,
        on_chain_supply: i128,
        reserve_balance: i128,
        signers: Vec<Address>,
    ) -> Result<(), ProofOfReserveError> {
        if on_chain_supply < 0 || reserve_balance < 0 {
            return Err(ProofOfReserveError::InvalidAmount);
        }

        let auditors = Self::get_auditors(&env)?;
        let required: u32 = env
            .storage()
            .instance()
            .get(&REQ_SIGS)
            .ok_or(ProofOfReserveError::NotInitialized)?;

        // Every listed signer must be an authorized auditor and must
        // actually authorize this call. Duplicate entries in `signers`
        // are collapsed (via `valid_signers`) so repeating the same
        // auditor cannot be used to satisfy the threshold on its own.
        let mut valid_signers: Vec<Address> = Vec::new(&env);
        for signer in signers.iter() {
            let is_authorized = auditors.iter().any(|a| a == signer);
            if !is_authorized {
                return Err(ProofOfReserveError::UnauthorizedAuditor);
            }
            // Skip a repeated entry entirely, before calling
            // `require_auth` again on it: calling `require_auth` twice
            // for the same address within one invocation is unusual
            // enough (and, under `mock_all_auths` in tests, aborts rather
            // than erroring normally) that the dedup check must happen
            // first rather than relying on a second `require_auth` call
            // to fail cleanly.
            if valid_signers.iter().any(|s| s == signer) {
                continue;
            }
            signer.require_auth();
            valid_signers.push_back(signer.clone());
        }

        if valid_signers.len() < required {
            return Err(ProofOfReserveError::InsufficientSignatures);
        }

        let attested_at = env.ledger().timestamp();
        let attestation = Attestation {
            on_chain_supply,
            reserve_balance,
            attested_at,
            signers: valid_signers.clone(),
        };
        env.storage().instance().set(&LATEST, &attestation);
        env.storage().instance().extend_ttl(1000, 10000);

        AttestationSubmitted {
            attested_at,
            on_chain_supply,
            reserve_balance,
            signer_count: valid_signers.len(),
        }
        .publish(&env);

        Ok(())
    }

    /// Return the most recent attestation, regardless of age.
    pub fn latest_attestation(env: Env) -> Result<Attestation, ProofOfReserveError> {
        env.storage()
            .instance()
            .get(&LATEST)
            .ok_or(ProofOfReserveError::NoAttestation)
    }

    /// Whether the most recent attestation is fresh (within
    /// `MAX_ATTESTATION_AGE_SECONDS`) and reports `reserve_balance >=
    /// on_chain_supply` (fully, or over-, collateralized).
    ///
    /// Errors `AttestationStale` rather than returning `false` for a stale
    /// attestation: staleness means the anchor's backing status is
    /// currently *unknown*, not that it is known to be unbacked, and a
    /// caller (e.g. a wallet deciding whether to accept the anchor's
    /// token) should be able to tell those two situations apart rather
    /// than treating both as "not backed".
    pub fn is_fully_backed(env: Env) -> Result<bool, ProofOfReserveError> {
        let attestation = Self::latest_attestation(env.clone())?;
        Self::require_fresh(&env, &attestation)?;
        Ok(attestation.reserve_balance >= attestation.on_chain_supply)
    }

    /// The most recent attestation's reserve ratio in basis points
    /// (`reserve_balance * 10_000 / on_chain_supply`; `10_000` = exactly
    /// 1:1). Errors `AttestationStale` under the same freshness rule as
    /// `is_fully_backed`. Errors `InvalidAmount` if `on_chain_supply` is
    /// `0` (the ratio is undefined with no supply outstanding).
    pub fn reserve_ratio_bps(env: Env) -> Result<i128, ProofOfReserveError> {
        let attestation = Self::latest_attestation(env.clone())?;
        Self::require_fresh(&env, &attestation)?;
        if attestation.on_chain_supply == 0 {
            return Err(ProofOfReserveError::InvalidAmount);
        }
        Ok(attestation
            .reserve_balance
            .saturating_mul(10_000)
            .checked_div(attestation.on_chain_supply)
            .unwrap_or(i128::MAX))
    }

    pub fn admin(env: Env) -> Result<Address, ProofOfReserveError> {
        env.storage()
            .instance()
            .get(&ADMIN)
            .ok_or(ProofOfReserveError::NotInitialized)
    }

    pub fn auditors(env: Env) -> Result<Vec<Address>, ProofOfReserveError> {
        Self::get_auditors(&env)
    }
}

impl ProofOfReserveContract {
    fn get_auditors(env: &Env) -> Result<Vec<Address>, ProofOfReserveError> {
        env.storage()
            .instance()
            .get(&AUDITORS)
            .ok_or(ProofOfReserveError::NotInitialized)
    }

    fn require_fresh(env: &Env, attestation: &Attestation) -> Result<(), ProofOfReserveError> {
        let now = env.ledger().timestamp();
        let age = now.saturating_sub(attestation.attested_at);
        if age > MAX_ATTESTATION_AGE_SECONDS {
            return Err(ProofOfReserveError::AttestationStale);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::vec as svec;
    use soroban_sdk::IntoVal;

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
        assert_eq!(result, Err(Ok(ProofOfReserveError::AttestationStale)));
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
            Err(Ok(ProofOfReserveError::AttestationStale))
        );
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
}
