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
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short, Address,
    Bytes, BytesN, Env, Symbol, Vec,
};

const ADMIN: Symbol = symbol_short!("ADMIN");
const AUDITORS: Symbol = symbol_short!("AUDITORS");
const REQ_SIGS: Symbol = symbol_short!("REQ_SIGS");
const LATEST: Symbol = symbol_short!("LATEST");
const MAX_AGE: Symbol = symbol_short!("MAX_AGE");
const PENDING_MAX_AGE: Symbol = symbol_short!("PEND_AGE");
const CUSTODIANS: Symbol = symbol_short!("CUSTODIAN");

/// An attestation older than this many seconds is rejected by
/// `is_fully_backed`/`latest_attestation` callers that care about
/// freshness (the query itself still returns the stale record; staleness
/// is a property of the record relative to "now", not the storage layer).
pub const MAX_ATTESTATION_AGE_SECONDS: u64 = DEFAULT_MAX_ATTESTATION_AGE_SECONDS;

/// Freshness window used until the admin updates it via
/// `schedule_freshness_update` / `execute_freshness_update`.
pub const DEFAULT_MAX_ATTESTATION_AGE_SECONDS: u64 = 24 * 60 * 60;

/// Delay between scheduling and applying a freshness-window update. The
/// delay gives auditors and integrators a chance to observe an upcoming
/// change before it can affect whether attestations are considered stale.
pub const FRESHNESS_UPDATE_TIMELOCK_SECONDS: u64 = 48 * 60 * 60;

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
    /// The latest attestation is older than the configured freshness window.
    StaleAttestation = 8,
    /// The proposed freshness window was zero.
    InvalidFreshnessWindow = 9,
    /// No freshness-window update has been scheduled.
    NoPendingFreshnessUpdate = 10,
    /// The freshness-window update is still inside its timelock.
    FreshnessUpdateTimelockActive = 11,
    /// The Ed25519 public key is not a registered custodian key.
    UnauthorizedCustodian = 12,
    /// Circulating supply exceeds the verified reserve balance.
    UnderReserve = 13,
    /// The signed snapshot's timestamp does not match the ledger timestamp.
    AttestationTimestampMismatch = 14,
    /// The custodian key is already registered.
    CustodianAlreadyRegistered = 15,
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

/// A freshness-window change waiting out its timelock.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingFreshnessUpdate {
    pub new_max_age_seconds: u64,
    pub executable_at: u64,
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

/// Emitted when an off-chain custodian's Ed25519-signed balance snapshot has
/// been verified and the supply is confirmed to be fully backed.
#[contractevent(topics = ["proof_of_reserve", "reserve_attestation_verified"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReserveAttestationVerified {
    #[topic]
    pub attested_at: u64,
    pub reserve_balance: i128,
    pub on_chain_supply: i128,
    pub custodian: BytesN<32>,
}

#[contractevent(topics = ["proof_of_reserve", "freshness_update_scheduled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FreshnessUpdateScheduled {
    #[topic]
    pub admin: Address,
    pub new_max_age_seconds: u64,
    pub executable_at: u64,
}

#[contractevent(topics = ["proof_of_reserve", "freshness_updated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FreshnessUpdated {
    #[topic]
    pub admin: Address,
    pub old_max_age_seconds: u64,
    pub new_max_age_seconds: u64,
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
        env.storage()
            .instance()
            .set(&MAX_AGE, &MAX_ATTESTATION_AGE_SECONDS);
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

    /// Whether the most recent attestation is fresh (within the configured
    /// freshness window, `max_attestation_age_seconds`) and reports
    /// `reserve_balance >= on_chain_supply` (fully, or over-,
    /// collateralized).
    ///
    /// Errors `StaleAttestation` rather than returning `false` for a stale
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
    /// 1:1). Errors `StaleAttestation` under the same freshness rule as
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
        Self::get_admin(&env)
    }

    pub fn auditors(env: Env) -> Result<Vec<Address>, ProofOfReserveError> {
        Self::get_auditors(&env)
    }

    /// Ed25519 public keys of the off-chain custodians whose signed balance
    /// snapshots this contract accepts.
    pub fn custodian_keys(env: Env) -> Vec<BytesN<32>> {
        env.storage()
            .instance()
            .get(&CUSTODIANS)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Register an off-chain custodian's Ed25519 public key. Admin-only.
    pub fn register_custodian_key(
        env: Env,
        public_key: BytesN<32>,
    ) -> Result<(), ProofOfReserveError> {
        Self::get_admin(&env)?.require_auth();

        let mut keys = Self::custodian_keys(env.clone());
        if keys.iter().any(|k| k == public_key) {
            return Err(ProofOfReserveError::CustodianAlreadyRegistered);
        }
        keys.push_back(public_key);
        env.storage().instance().set(&CUSTODIANS, &keys);
        env.storage().instance().extend_ttl(1000, 10000);
        Ok(())
    }

    /// Verify an Ed25519-signed custodial balance snapshot and, if the
    /// circulating stablecoin supply is fully backed, record it using the
    /// existing auditor co-signature flow.
    ///
    /// The signed message is the canonical byte sequence built by
    /// [`Self::snapshot_message`]; signing anything else (a different balance,
    /// supply or timestamp) fails verification. A snapshot whose
    /// `on_chain_supply` exceeds `reserve_balance` is rejected outright —
    /// an under-reserved attestation must never become the latest record.
    pub fn verify_signed_attestation(
        env: Env,
        on_chain_supply: i128,
        reserve_balance: i128,
        attested_at: u64,
        public_key: BytesN<32>,
        signature: BytesN<64>,
        signers: Vec<Address>,
    ) -> Result<(), ProofOfReserveError> {
        let keys = Self::custodian_keys(env.clone());
        if !keys.iter().any(|k| k == public_key) {
            return Err(ProofOfReserveError::UnauthorizedCustodian);
        }
        if attested_at != env.ledger().timestamp() {
            return Err(ProofOfReserveError::AttestationTimestampMismatch);
        }
        if on_chain_supply < 0 || reserve_balance < 0 {
            return Err(ProofOfReserveError::InvalidAmount);
        }
        if on_chain_supply > reserve_balance {
            return Err(ProofOfReserveError::UnderReserve);
        }

        let message = Self::snapshot_message(&env, on_chain_supply, reserve_balance, attested_at);
        // `ed25519_verify` traps the host call if the signature is invalid.
        // Callers therefore never observe a "verified" result for a tampered
        // snapshot.
        env.crypto()
            .ed25519_verify(&public_key, &message, &signature);

        Self::submit_attestation(env.clone(), on_chain_supply, reserve_balance, signers)?;

        ReserveAttestationVerified {
            attested_at,
            reserve_balance,
            on_chain_supply,
            custodian: public_key,
        }
        .publish(&env);

        Ok(())
    }

    /// The freshness window currently used by `is_fully_backed` and
    /// `reserve_ratio_bps`, in seconds.
    pub fn max_attestation_age_seconds(env: Env) -> u64 {
        Self::max_age(&env)
    }

    /// The freshness-window update waiting out its timelock, if any.
    pub fn pending_freshness_update(env: Env) -> Option<PendingFreshnessUpdate> {
        env.storage().instance().get(&PENDING_MAX_AGE)
    }

    /// Schedule an update to the maximum accepted attestation age.
    /// Admin-only, and not applied until `FRESHNESS_UPDATE_TIMELOCK_SECONDS`
    /// have elapsed (see `execute_freshness_update`).
    pub fn schedule_freshness_update(
        env: Env,
        new_max_age_seconds: u64,
    ) -> Result<(), ProofOfReserveError> {
        let admin = Self::get_admin(&env)?;
        admin.require_auth();

        if new_max_age_seconds == 0 {
            return Err(ProofOfReserveError::InvalidFreshnessWindow);
        }

        let executable_at = env
            .ledger()
            .timestamp()
            .saturating_add(FRESHNESS_UPDATE_TIMELOCK_SECONDS);
        env.storage().instance().set(
            &PENDING_MAX_AGE,
            &PendingFreshnessUpdate {
                new_max_age_seconds,
                executable_at,
            },
        );
        env.storage().instance().extend_ttl(1000, 10000);

        FreshnessUpdateScheduled {
            admin,
            new_max_age_seconds,
            executable_at,
        }
        .publish(&env);

        Ok(())
    }

    /// Apply the scheduled freshness-window update once its timelock has
    /// elapsed. Admin-only.
    pub fn execute_freshness_update(env: Env) -> Result<(), ProofOfReserveError> {
        let admin = Self::get_admin(&env)?;
        admin.require_auth();

        let pending: PendingFreshnessUpdate = env
            .storage()
            .instance()
            .get(&PENDING_MAX_AGE)
            .ok_or(ProofOfReserveError::NoPendingFreshnessUpdate)?;

        if env.ledger().timestamp() < pending.executable_at {
            return Err(ProofOfReserveError::FreshnessUpdateTimelockActive);
        }

        let old_max_age_seconds = Self::max_age(&env);
        env.storage()
            .instance()
            .set(&MAX_AGE, &pending.new_max_age_seconds);
        env.storage().instance().remove(&PENDING_MAX_AGE);
        env.storage().instance().extend_ttl(1000, 10000);

        FreshnessUpdated {
            admin,
            old_max_age_seconds,
            new_max_age_seconds: pending.new_max_age_seconds,
        }
        .publish(&env);

        Ok(())
    }
}

impl ProofOfReserveContract {
    fn get_admin(env: &Env) -> Result<Address, ProofOfReserveError> {
        env.storage()
            .instance()
            .get(&ADMIN)
            .ok_or(ProofOfReserveError::NotInitialized)
    }

    fn get_auditors(env: &Env) -> Result<Vec<Address>, ProofOfReserveError> {
        env.storage()
            .instance()
            .get(&AUDITORS)
            .ok_or(ProofOfReserveError::NotInitialized)
    }

    fn max_age(env: &Env) -> u64 {
        env.storage()
            .instance()
            .get(&MAX_AGE)
            .unwrap_or(MAX_ATTESTATION_AGE_SECONDS)
    }

    /// Canonical, domain-separated serialization of a custodial snapshot.
    /// All integers are big-endian so the bytes an off-chain custodian signs
    /// are reproducible from the contract's public inputs.
    fn snapshot_message(
        env: &Env,
        on_chain_supply: i128,
        reserve_balance: i128,
        attested_at: u64,
    ) -> Bytes {
        let mut message = Bytes::new(env);
        message.extend_from_array(b"RESERVE_ATTESTATION_V1\0");
        message.extend_from_slice(&attested_at.to_be_bytes());
        message.extend_from_slice(&on_chain_supply.to_be_bytes());
        message.extend_from_slice(&reserve_balance.to_be_bytes());
        message
    }

    fn require_fresh(env: &Env, attestation: &Attestation) -> Result<(), ProofOfReserveError> {
        let now = env.ledger().timestamp();
        let age = now.saturating_sub(attestation.attested_at);
        if age > Self::max_age(env) {
            return Err(ProofOfReserveError::StaleAttestation);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test;
