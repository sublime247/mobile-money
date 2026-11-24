#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN,
    Env, Vec,
};

mod storage;
use storage::{ESCROW, ESCROW_ADMINS, REENTRANCY};

// ── Error types ──────────────────────────────────────────────────────────────

/// Contract-level errors surfaced via the Soroban SDK error-code mechanism.
/// The `#[contracterror]` attribute generates the required `From<soroban_sdk::Error>`
/// impl so the generated client exposes `try_*` variants that return
/// `Result<T, soroban_sdk::Error>` for testing failure paths.
#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum EscrowError {
    /// Storage key already exists – contract is already initialised.
    AlreadyInitialised = 1,
    /// Storage key not found – contract has not been initialised yet.
    NotInitialised = 2,
    /// Funds have already been released or refunded.
    AlreadyReleased = 3,
    /// The lock time has not yet expired; refund is premature.
    LockNotExpired = 4,
    /// The lock time has already expired; arbiter release window is closed.
    LockExpired = 5,
    /// Deposit amount must be strictly positive.
    InvalidAmount = 6,
    /// Fee basis points must be in [0, 10_000].
    InvalidFeeBps = 7,
    /// Beneficiary address must differ from depositor.
    InvalidBeneficiary = 8,
    /// Arbiter address must differ from both depositor and beneficiary.
    InvalidArbiter = 9,
    /// Upgrade attempted without admin signers configured.
    UpgradeNotConfigured = 10,
    /// A signer passed to `upgrade` is not in the approved admin list.
    InvalidAdminSigner = 11,
    /// Not enough valid admin signatures to authorise the upgrade.
    InsufficientAdminSignatures = 12,
}

// ── State ────────────────────────────────────────────────────────────────────

/// Lifecycle state of the escrow. `Pending` is the only state in which funds
/// can move; `Completed` and `Refunded` are terminal.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Pending,
    Completed,
    Refunded,
}

/// Persistent on-chain state for a single escrow instance — the *hot* half.
///
/// Only the fields that a fund-moving entry point needs are stored under this
/// key. The admin signer list is unbounded and is read exclusively by
/// [`EscrowContract::upgrade`], so it lives under [`storage::ESCROW_ADMINS`]
/// (see [`EscrowContract::get_admins`]) and is never serialised by
/// `release` / `refund` / `self_refund` / `emergency_refund`.
#[contracttype]
#[derive(Clone)]
pub struct EscrowState {
    /// Party that deposited funds and can claim a refund after expiry.
    pub depositor: Address,
    /// Party that receives funds on successful release.
    pub beneficiary: Address,
    /// Neutral third party that authorises release / early refund.
    pub arbiter: Address,
    /// SAC token address.
    pub token: Address,
    /// Gross amount locked in escrow (before fee deduction).
    pub amount: i128,
    pub emergency_unlock_timestamp: u64,
    pub lock_until_ledger: u32,
    pub fee_bps: u32,
    pub fee_recipient: Address,
    pub status: EscrowStatus,
}

impl EscrowState {
    /// Compute (fee_amount, net_beneficiary_amount).
    pub fn split(&self) -> Option<(i128, i128)> {
        let fee = self
            .amount
            .checked_mul(self.fee_bps as i128)?
            .checked_div(10_000)?;
        let net = self.amount.checked_sub(fee)?;
        Some((fee, net))
    }
}

/// Cold-path upgrade material stored under [`storage::ESCROW_ADMINS`].
#[contracttype]
#[derive(Clone)]
pub struct EscrowAdmins {
    /// Approved addresses that may co-sign a contract upgrade.
    pub admin_signers: Vec<Address>,
    /// Minimum number of admin signatures required to perform an upgrade.
    pub required_admin_signatures: u32,
}

#[contractevent(topics = ["escrow", "released"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowReleased {
    #[topic]
    pub beneficiary: Address,
    pub release_timestamp: u64,
    pub net_amount: i128,
    pub fee_amount: i128,
}

/// Shape of the `ESCROW` entry before the admin signer list was split out.
///
/// Used only by [`load_state`] to migrate instances written by an older wasm:
/// the signer list has to be moved to its own key *before* the hot entry is
/// rewritten, otherwise it would be silently dropped.
#[contracttype]
#[derive(Clone)]
pub struct LegacyEscrowState {
    pub depositor: Address,
    pub beneficiary: Address,
    pub arbiter: Address,
    pub token: Address,
    pub amount: i128,
    pub emergency_unlock_timestamp: u64,
    pub lock_until_ledger: u32,
    pub fee_bps: u32,
    pub fee_recipient: Address,
    pub released: bool,
    pub admin_signers: Vec<Address>,
    pub required_admin_signatures: u32,
}

/// Read the hot escrow state, transparently migrating a legacy entry into the
/// two-key layout the first time it is touched after an upgrade.
///
/// Returns `None` when the contract has not been initialised yet.
fn load_state(env: &Env) -> Option<EscrowState> {
    if !env.storage().instance().has(&ESCROW) {
        return None;
    }

    // Already migrated (or written by this version) — the normal fast path.
    if env.storage().instance().has(&ESCROW_ADMINS) {
        return env.storage().instance().get(&ESCROW);
    }

    let legacy: LegacyEscrowState = env.storage().instance().get(&ESCROW)?;
    env.storage().instance().set(
        &ESCROW_ADMINS,
        &EscrowAdmins {
            admin_signers: legacy.admin_signers,
            required_admin_signatures: legacy.required_admin_signatures,
        },
    );

    let state = EscrowState {
        depositor: legacy.depositor,
        beneficiary: legacy.beneficiary,
        arbiter: legacy.arbiter,
        token: legacy.token,
        amount: legacy.amount,
        emergency_unlock_timestamp: legacy.emergency_unlock_timestamp,
        lock_until_ledger: legacy.lock_until_ledger,
        fee_bps: legacy.fee_bps,
        fee_recipient: legacy.fee_recipient,
        status: if legacy.released {
            EscrowStatus::Completed
        } else {
            EscrowStatus::Pending
        },
    };
    env.storage().instance().set(&ESCROW, &state);
    Some(state)
}

/// Reentrancy guard held for the duration of a state-mutating entry point.
///
/// Soroban lets any contract the escrow calls into (the token, most notably)
/// call straight back into it. Acquiring this lock up-front means a callback
/// can never enter a second fund-moving function: the nested call observes the
/// lock and aborts, reverting the whole transaction.
///
/// The lock is released in `Drop`, so it is cleared on every return path —
/// success, `Err`, or panic (which rolls the frame back anyway).
struct ReentrancyGuard<'a> {
    env: &'a Env,
}

impl<'a> ReentrancyGuard<'a> {
    fn enter(env: &'a Env) -> Self {
        assert!(
            !env.storage().instance().has(&REENTRANCY),
            "escrow: reentrancy detected"
        );
        env.storage().instance().set(&REENTRANCY, &true);
        Self { env }
    }
}

impl Drop for ReentrancyGuard<'_> {
    fn drop(&mut self) {
        self.env.storage().instance().remove(&REENTRANCY);
    }
}

fn ensure_trustline(env: &Env, token: &Address, recipient: &Address) {
    token::StellarAssetClient::new(env, token).trust(recipient);
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    // ── initialize ────────────────────────────────────────────────────────────

    /// Initialise escrow. The depositor must authorise this call; `amount`
    /// tokens are pulled from the depositor into the contract.
    ///
    /// * `lock_until_ledger`          – ledger after which the depositor may self-refund
    ///   without the arbiter. Pass `0` to disable self-refund entirely.
    /// * `fee_bps`                    – protocol fee in basis points (0–10 000).
    /// * `fee_recipient`              – receives the fee portion on release.
    /// * `admin_signers`              – approved addresses for multi-sig upgrades (empty = upgrades disabled).
    /// * `required_admin_signatures`  – minimum cosigners needed for an upgrade.
    pub fn initialize(
        env: Env,
        depositor: Address,
        beneficiary: Address,
        arbiter: Address,
        token: Address,
        amount: i128,
        emergency_unlock_timestamp: u64,
        lock_until_ledger: u32,
        fee_bps: u32,
        fee_recipient: Address,
        admin_signers: Vec<Address>,
        required_admin_signatures: u32,
    ) {
        let _guard = ReentrancyGuard::enter(&env);

        depositor.require_auth();

        assert!(amount > 0, "amount must be positive");
        assert!(
            amount <= i128::MAX / 10_000,
            "amount is too large to prevent fee overflow"
        );

        assert!(
            !env.storage().instance().has(&ESCROW),
            "already initialised"
        );

        assert!(
            emergency_unlock_timestamp > env.ledger().timestamp(),
            "emergency unlock must be in the future"
        );

        assert!(fee_bps <= 10_000, "fee basis points must be in [0, 10000]");

        assert!(
            depositor != beneficiary,
            "beneficiary must differ from depositor"
        );

        assert!(
            arbiter != depositor && arbiter != beneficiary,
            "arbiter must differ from depositor and beneficiary"
        );

        if !admin_signers.is_empty() {
            assert!(
                required_admin_signatures > 0 && required_admin_signatures <= admin_signers.len(),
                "required_admin_signatures must be between 1 and number of admin signers"
            );
        }

        // Dynamic token support:
        // Any Stellar asset can be passed through the token address.
        let token_client = token::Client::new(&env, &token);

        // Effects — publish the escrow *before* the deposit is pulled in, so a
        // callback from the token always observes a fully-formed escrow. The
        // admin signer list goes to its own entry: it is cold data and must
        // never be paid for on the fund-moving hot path.
        env.storage().instance().set(
            &ESCROW,
            &EscrowState {
                depositor: depositor.clone(),
                beneficiary,
                arbiter,
                token,
                amount,
                emergency_unlock_timestamp,
                lock_until_ledger,
                fee_bps,
                fee_recipient,
                status: EscrowStatus::Pending,
            },
        );
        env.storage().instance().set(
            &ESCROW_ADMINS,
            &EscrowAdmins {
                admin_signers,
                required_admin_signatures,
            },
        );

        env.storage().instance().extend_ttl(1000, 10000);

        // Interaction — only now are funds moved. Transfer directly asserts sufficient balance.
        token_client.transfer(&depositor, env.current_contract_address(), &amount);
    }

    // ── upgrade ───────────────────────────────────────────────────────────────

    /// Upgrade the contract WASM. Requires at least `required_admin_signatures`
    /// valid admin signatures. All signers passed must be in the approved list.
    pub fn upgrade(
        env: Env,
        new_wasm_hash: BytesN<32>,
        admin_signers: Vec<Address>,
    ) -> Result<(), EscrowError> {
        let _guard = ReentrancyGuard::enter(&env);

        // Loads (and, for a legacy layout, migrates) the escrow state so the
        // admin material is guaranteed to live under `ESCROW_ADMINS` below.
        load_state(&env).ok_or(EscrowError::NotInitialised)?;

        let admins: EscrowAdmins = env
            .storage()
            .instance()
            .get(&ESCROW_ADMINS)
            .ok_or(EscrowError::NotInitialised)?;

        if admins.admin_signers.is_empty() {
            return Err(EscrowError::UpgradeNotConfigured);
        }

        let mut valid_sig_count = 0u32;
        for signer in admin_signers.iter() {
            let is_approved = admins
                .admin_signers
                .iter()
                .any(|approved| approved == signer);
            if !is_approved {
                return Err(EscrowError::InvalidAdminSigner);
            }
            signer.require_auth();
            valid_sig_count += 1;
        }

        if valid_sig_count < admins.required_admin_signatures {
            return Err(EscrowError::InsufficientAdminSignatures);
        }

        env.deployer().update_current_contract_wasm(new_wasm_hash);

        Ok(())
    }

    // ── release ───────────────────────────────────────────────────────────────

    /// Release funds to the beneficiary (net of fee) and fee to `fee_recipient`.
    /// Only the arbiter may call this, and only while the lock is still active.
    pub fn release(env: Env) -> Result<(), EscrowError> {
        let _guard = ReentrancyGuard::enter(&env);

        let mut state: EscrowState = load_state(&env).ok_or(EscrowError::NotInitialised)?;

        state.arbiter.require_auth();

        if state.status != EscrowStatus::Pending {
            return Err(EscrowError::AlreadyReleased);
        }
        // Arbiter cannot release after the lock has expired.
        if state.lock_until_ledger > 0 && env.ledger().sequence() > state.lock_until_ledger {
            return Err(EscrowError::LockExpired);
        }

        let (fee, net) = state.split().ok_or(EscrowError::InvalidAmount)?;

        // Effects — mark the escrow Completed *before* any token interaction
        // so a callback from the token can never observe or re-spend a live
        // escrow.
        state.status = EscrowStatus::Completed;
        env.storage().instance().set(&ESCROW, &state);

        // Interactions
        let tc = token::Client::new(&env, &state.token);
        let contract_addr = env.current_contract_address();

        ensure_trustline(&env, &state.token, &state.beneficiary);
        if fee > 0 {
            ensure_trustline(&env, &state.token, &state.fee_recipient);
            tc.transfer(&contract_addr, &state.fee_recipient, &fee);
        }
        tc.transfer(&contract_addr, &state.beneficiary, &net);

        EscrowReleased {
            beneficiary: state.beneficiary,
            release_timestamp: env.ledger().timestamp(),
            net_amount: net,
            fee_amount: fee,
        }
        .publish(&env);

        Ok(())
    }

    // ── refund ────────────────────────────────────────────────────────────────

    /// Return the full `amount` to the depositor.
    /// Only the arbiter may call this, and only while the lock is still active.
    pub fn refund(env: Env) -> Result<(), EscrowError> {
        let _guard = ReentrancyGuard::enter(&env);

        let mut state: EscrowState = load_state(&env).ok_or(EscrowError::NotInitialised)?;

        state.arbiter.require_auth();

        if state.status != EscrowStatus::Pending {
            return Err(EscrowError::AlreadyReleased);
        }
        if state.lock_until_ledger > 0 && env.ledger().sequence() > state.lock_until_ledger {
            return Err(EscrowError::LockExpired);
        }

        // Effects — close the escrow before the transfer below.
        state.status = EscrowStatus::Refunded;
        env.storage().instance().set(&ESCROW, &state);

        // Interaction
        token::Client::new(&env, &state.token).transfer(
            &env.current_contract_address(),
            &state.depositor,
            &state.amount,
        );

        Ok(())
    }

    /// Emergency refund to the depositor after the unlock timestamp.
    /// Allows source wallets to recover funds during an extended bridge outage.
    pub fn emergency_refund(env: Env) {
        let _guard = ReentrancyGuard::enter(&env);

        let mut state: EscrowState = load_state(&env).expect("not initialised");

        state.depositor.require_auth();
        assert!(state.status == EscrowStatus::Pending, "already released");
        assert!(
            env.ledger().timestamp() >= state.emergency_unlock_timestamp,
            "emergency unlock not yet available"
        );

        // Effects — close the escrow before the transfer below.
        state.status = EscrowStatus::Refunded;
        env.storage().instance().set(&ESCROW, &state);

        // Interaction
        token::Client::new(&env, &state.token).transfer(
            &env.current_contract_address(),
            &state.depositor,
            &state.amount,
        );
    }

    // ── self_refund ───────────────────────────────────────────────────────────

    /// Allow the depositor to reclaim funds *after* the lock has expired,
    /// without the arbiter. The full `amount` is returned.
    pub fn self_refund(env: Env) -> Result<(), EscrowError> {
        let _guard = ReentrancyGuard::enter(&env);

        let mut state: EscrowState = load_state(&env).ok_or(EscrowError::NotInitialised)?;

        state.depositor.require_auth();

        if state.status != EscrowStatus::Pending {
            return Err(EscrowError::AlreadyReleased);
        }
        // Time-lock must have passed.
        if state.lock_until_ledger == 0 || env.ledger().sequence() <= state.lock_until_ledger {
            return Err(EscrowError::LockNotExpired);
        }

        // Effects — close the escrow before the transfer below.
        state.status = EscrowStatus::Refunded;
        env.storage().instance().set(&ESCROW, &state);

        // Interaction
        token::Client::new(&env, &state.token).transfer(
            &env.current_contract_address(),
            &state.depositor,
            &state.amount,
        );

        Ok(())
    }

    // ── views ─────────────────────────────────────────────────────────────────

    /// Return current escrow state (read-only).
    ///
    /// Contains only the hot-path fields; use [`Self::get_admins`] for the
    /// upgrade material.
    pub fn get_state(env: Env) -> EscrowState {
        let state = load_state(&env).expect("not initialised");
        env.storage().instance().extend_ttl(1000, 10000);
        state
    }

    /// Return the cold upgrade material: the approved admin signers and the
    /// signature threshold.
    pub fn get_admins(env: Env) -> EscrowAdmins {
        load_state(&env).expect("not initialised");
        env.storage().instance().extend_ttl(1000, 10000);
        env.storage()
            .instance()
            .get(&ESCROW_ADMINS)
            .expect("not initialised")
    }

    /// Whether the reentrancy lock is currently held — i.e. a fund-moving
    /// entry point is mid-flight and has called out to another contract.
    ///
    /// Read-only, so it can be called from a callback (for example the token
    /// contract during a transfer) to observe the guard.
    pub fn reentrancy_guard_active(env: Env) -> bool {
        env.storage().instance().has(&REENTRANCY)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _, Ledger, MockAuth, MockAuthInvoke},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Bytes, Env, Event, IntoVal,
    };

    const MINT_AMOUNT: i128 = 1_000_000;

    fn setup() -> (
        Env,
        Address,
        Address,
        Address,
        Address,
        Address,
        EscrowContractClient<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let depositor = Address::generate(&env);
        let beneficiary = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let fee_recipient = Address::generate(&env);

        // Deploy a test SAC token.
        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin);
        StellarAssetClient::new(&env, &token_id.address()).mint(&depositor, &MINT_AMOUNT);

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        (
            env,
            depositor,
            beneficiary,
            arbiter,
            fee_recipient,
            token_id.address(),
            client,
        )
    }

    // Helper: initialise with common defaults (no admin signers)
    #[allow(clippy::too_many_arguments)]
    fn init(
        client: &EscrowContractClient,
        depositor: &Address,
        beneficiary: &Address,
        arbiter: &Address,
        token: &Address,
        amount: i128,
        lock_until_ledger: u32,
        fee_bps: u32,
        fee_recipient: &Address,
    ) {
        let env = &client.env;
        let admin_signers: Vec<Address> = Vec::new(env);
        client.initialize(
            depositor,
            beneficiary,
            arbiter,
            token,
            &amount,
            &1_000, // emergency_unlock_timestamp
            &lock_until_ledger,
            &fee_bps,
            fee_recipient,
            &admin_signers,
            &0,
        );
    }

    #[allow(clippy::type_complexity)]
    fn setup_without_mock_auths() -> (
        Env,
        Address,
        Address,
        Address,
        Address,
        Address,
        EscrowContractClient<'static>,
    ) {
        let env = Env::default();

        let depositor = Address::generate(&env);
        let beneficiary = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let fee_recipient = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token = token_id.address();
        let sac = StellarAssetClient::new(&env, &token);
        sac.mock_auths(&[MockAuth {
            address: &token_admin,
            invoke: &MockAuthInvoke {
                contract: &sac.address,
                fn_name: "mint",
                args: (&depositor, MINT_AMOUNT).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .mint(&depositor, &MINT_AMOUNT);

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        (
            env,
            depositor,
            beneficiary,
            arbiter,
            fee_recipient,
            token,
            client,
        )
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Happy-path tests
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_initialize_and_release() {
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup();
        let amount: i128 = 500_000;
        let emergency_unlock_timestamp = 1_000;

        env.ledger().set_timestamp(100);

        let admin_signers: Vec<Address> = Vec::new(&env);
        client.initialize(
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            &amount,
            &emergency_unlock_timestamp,
            &100, // lock_until_ledger
            &0,   // fee_bps
            &fee_recipient,
            &admin_signers,
            &0,
        );

        let state = client.get_state();
        assert_eq!(state.amount, amount);
        assert_eq!(state.emergency_unlock_timestamp, emergency_unlock_timestamp);
        assert_eq!(state.status, EscrowStatus::Pending);

        // Depositor's balance should decrease by `amount`.
        let tc = TokenClient::new(&env, &token);
        assert_eq!(tc.balance(&depositor), MINT_AMOUNT - amount);
    }

    #[test]
    fn test_release_distributes_fee_and_net() {
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup();
        let amount: i128 = 500_000;
        // 2.5 % fee → fee = 12 500, net = 487 500
        let fee_bps: u32 = 250;

        init(
            &client,
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            amount,
            100,
            fee_bps,
            &fee_recipient,
        );

        client.release();

        let tc = TokenClient::new(&env, &token);
        let expected_fee = amount * fee_bps as i128 / 10_000;
        let expected_net = amount - expected_fee;

        assert_eq!(tc.balance(&beneficiary), expected_net);
        assert_eq!(tc.balance(&fee_recipient), expected_fee);

        let state = client.get_state();
        assert_eq!(state.status, EscrowStatus::Completed);
    }

    #[test]
    fn test_release_emits_escrow_released_event() {
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup();
        let amount: i128 = 500_000;
        let fee_bps: u32 = 250;

        init(
            &client,
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            amount,
            100,
            fee_bps,
            &fee_recipient,
        );

        env.ledger().set_timestamp(1_234);
        client.release();

        let expected_fee = amount * fee_bps as i128 / 10_000;
        let expected = EscrowReleased {
            beneficiary: beneficiary.clone(),
            release_timestamp: 1_234,
            net_amount: amount - expected_fee,
            fee_amount: expected_fee,
        };
        assert_eq!(
            env.events().all().filter_by_contract(&client.address),
            [expected.to_xdr(&env, &client.address)]
        );
    }

    #[test]
    fn test_failed_release_transfer_reverts_state_and_balances() {
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup();
        let amount: i128 = 500_000;

        init(
            &client,
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            amount,
            100,
            250,
            &fee_recipient,
        );

        let token_client = TokenClient::new(&env, &token);

        // Drain the escrow so the token transfer in `release` fails after the
        // state has already been written to Completed.
        token_client.transfer(&client.address, &depositor, &amount);
        assert_eq!(token_client.balance(&client.address), 0);

        assert!(client.try_release().is_err());

        // The failed invocation must roll the state and balances back.
        let state = client.get_state();
        assert_eq!(state.status, EscrowStatus::Pending);
        assert_eq!(token_client.balance(&client.address), 0);
        assert_eq!(token_client.balance(&beneficiary), 0);
        assert_eq!(token_client.balance(&fee_recipient), 0);
        assert!(!client.reentrancy_guard_active());
    }

    #[test]
    fn test_release_with_zero_fee() {
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup();
        let amount: i128 = 300_000;

        init(
            &client,
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            amount,
            50,
            0,
            &fee_recipient,
        );

        client.release();

        let tc = TokenClient::new(&env, &token);
        // Full amount goes to beneficiary; fee_recipient receives nothing.
        assert_eq!(tc.balance(&beneficiary), amount);
        assert_eq!(tc.balance(&fee_recipient), 0);
    }

    #[test]
    fn test_refund() {
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup();
        let amount: i128 = 200_000;
        let emergency_unlock_timestamp = 1_000;

        env.ledger().set_timestamp(100);

        let admin_signers: Vec<Address> = Vec::new(&env);
        client.initialize(
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            &amount,
            &emergency_unlock_timestamp,
            &100, // lock_until_ledger
            &0,   // fee_bps
            &fee_recipient,
            &admin_signers,
            &0,
        );
        client.refund();

        let state = client.get_state();
        assert_eq!(state.status, EscrowStatus::Refunded);
    }

    #[test]
    fn test_emergency_refund() {
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup();
        let amount: i128 = 300_000;
        let emergency_unlock_timestamp = 1_000;

        env.ledger().set_timestamp(100);

        let admin_signers: Vec<Address> = Vec::new(&env);
        client.initialize(
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            &amount,
            &emergency_unlock_timestamp,
            &100, // lock_until_ledger
            &0,   // fee_bps
            &fee_recipient,
            &admin_signers,
            &0,
        );

        env.ledger().set_timestamp(emergency_unlock_timestamp);

        client.emergency_refund();

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&depositor), MINT_AMOUNT);
        assert_eq!(client.get_state().status, EscrowStatus::Refunded);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Trustline / auth tests (from upstream)
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_release_reverts_without_beneficiary_trustline_auth() {
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) =
            setup_without_mock_auths();
        let amount: i128 = 500_000;
        let fee_bps: u32 = 250;
        let emergency_unlock_timestamp = 1_000_u64;
        let lock_until_ledger = 100_u32;

        env.ledger().set_timestamp(100);

        let admin_signers: Vec<Address> = Vec::new(&env);
        client
            .mock_auths(&[MockAuth {
                address: &depositor,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "initialize",
                    args: (
                        &depositor,
                        &beneficiary,
                        &arbiter,
                        &token,
                        amount,
                        emergency_unlock_timestamp,
                        lock_until_ledger,
                        fee_bps,
                        &fee_recipient,
                        &admin_signers,
                        0_u32,
                    )
                        .into_val(&env),
                    sub_invokes: &[MockAuthInvoke {
                        contract: &token,
                        fn_name: "transfer",
                        args: (&depositor, &client.address, amount).into_val(&env),
                        sub_invokes: &[],
                    }],
                },
            }])
            .initialize(
                &depositor,
                &beneficiary,
                &arbiter,
                &token,
                &amount,
                &emergency_unlock_timestamp,
                &lock_until_ledger,
                &fee_bps,
                &fee_recipient,
                &admin_signers,
                &0,
            );

        let release_result = client
            .mock_auths(&[MockAuth {
                address: &arbiter,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "release",
                    args: ().into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_release();

        assert!(release_result.is_ok());

        let state = client.get_state();
        assert_eq!(state.status, EscrowStatus::Completed);

        let token_client = TokenClient::new(&env, &token);
        let expected_fee = amount * fee_bps as i128 / 10_000;
        let expected_net = amount - expected_fee;
        assert_eq!(token_client.balance(&beneficiary), expected_net);
        assert_eq!(token_client.balance(&fee_recipient), expected_fee);
    }

    #[test]
    fn test_release_with_zero_fee_skips_fee_recipient_trustline_auth() {
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) =
            setup_without_mock_auths();
        let amount: i128 = 300_000;
        let emergency_unlock_timestamp = 1_000_u64;
        let lock_until_ledger = 50_u32;

        env.ledger().set_timestamp(100);

        let admin_signers: Vec<Address> = Vec::new(&env);
        client
            .mock_auths(&[MockAuth {
                address: &depositor,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "initialize",
                    args: (
                        &depositor,
                        &beneficiary,
                        &arbiter,
                        &token,
                        amount,
                        emergency_unlock_timestamp,
                        lock_until_ledger,
                        0_u32,
                        &fee_recipient,
                        &admin_signers,
                        0_u32,
                    )
                        .into_val(&env),
                    sub_invokes: &[MockAuthInvoke {
                        contract: &token,
                        fn_name: "transfer",
                        args: (&depositor, &client.address, amount).into_val(&env),
                        sub_invokes: &[],
                    }],
                },
            }])
            .initialize(
                &depositor,
                &beneficiary,
                &arbiter,
                &token,
                &amount,
                &emergency_unlock_timestamp,
                &lock_until_ledger,
                &0,
                &fee_recipient,
                &admin_signers,
                &0,
            );

        client
            .mock_auths(&[MockAuth {
                address: &arbiter,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "release",
                    args: ().into_val(&env),
                    sub_invokes: &[MockAuthInvoke {
                        contract: &token,
                        fn_name: "trust",
                        args: (&beneficiary,).into_val(&env),
                        sub_invokes: &[],
                    }],
                },
            }])
            .release();

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&beneficiary), amount);
        assert_eq!(token_client.balance(&fee_recipient), 0);
        assert_eq!(client.get_state().status, EscrowStatus::Completed);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Upgrade tests (our branch)
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_upgrade_happy_path() {
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup();
        let amount: i128 = 500_000;
        env.ledger().set_timestamp(100);

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let admin3 = Address::generate(&env);

        let mut admin_signers: Vec<Address> = Vec::new(&env);
        admin_signers.push_back(admin1.clone());
        admin_signers.push_back(admin2.clone());
        admin_signers.push_back(admin3.clone());

        client.initialize(
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            &amount,
            &1_000,
            &100,
            &0,
            &fee_recipient,
            &admin_signers,
            &2,
        );

        let dummy_wasm = Bytes::new(&env);
        let new_wasm_hash = env.deployer().upload_contract_wasm(dummy_wasm);

        let mut upgrade_signers: Vec<Address> = Vec::new(&env);
        upgrade_signers.push_back(admin1);
        upgrade_signers.push_back(admin2);

        client.upgrade(&new_wasm_hash, &upgrade_signers);
    }

    #[test]
    fn test_upgrade_without_admin_config_fails() {
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup();
        let amount: i128 = 500_000;
        env.ledger().set_timestamp(100);

        let admin_signers: Vec<Address> = Vec::new(&env);
        client.initialize(
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            &amount,
            &1_000,
            &100,
            &0,
            &fee_recipient,
            &admin_signers,
            &0,
        );

        let dummy_wasm = Bytes::new(&env);
        let new_wasm_hash = env.deployer().upload_contract_wasm(dummy_wasm);

        let upgrade_signers: Vec<Address> = Vec::new(&env);
        let res = client.try_upgrade(&new_wasm_hash, &upgrade_signers);
        assert_eq!(res, Err(Ok(EscrowError::UpgradeNotConfigured)));
    }

    #[test]
    fn test_upgrade_unapproved_signer_fails() {
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup();
        let amount: i128 = 500_000;
        env.ledger().set_timestamp(100);

        let admin1 = Address::generate(&env);
        let unapproved = Address::generate(&env);

        let mut admin_signers: Vec<Address> = Vec::new(&env);
        admin_signers.push_back(admin1);

        client.initialize(
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            &amount,
            &1_000,
            &100,
            &0,
            &fee_recipient,
            &admin_signers,
            &1,
        );

        let dummy_wasm = Bytes::new(&env);
        let new_wasm_hash = env.deployer().upload_contract_wasm(dummy_wasm);

        let mut upgrade_signers: Vec<Address> = Vec::new(&env);
        upgrade_signers.push_back(unapproved);

        let res = client.try_upgrade(&new_wasm_hash, &upgrade_signers);
        assert_eq!(res, Err(Ok(EscrowError::InvalidAdminSigner)));
    }

    #[test]
    fn test_upgrade_insufficient_signatures_fails() {
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup();
        let amount: i128 = 500_000;
        env.ledger().set_timestamp(100);

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);

        let mut admin_signers: Vec<Address> = Vec::new(&env);
        admin_signers.push_back(admin1.clone());
        admin_signers.push_back(admin2);

        client.initialize(
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            &amount,
            &1_000,
            &100,
            &0,
            &fee_recipient,
            &admin_signers,
            &2,
        );

        let dummy_wasm = Bytes::new(&env);
        let new_wasm_hash = env.deployer().upload_contract_wasm(dummy_wasm);

        let mut upgrade_signers: Vec<Address> = Vec::new(&env);
        upgrade_signers.push_back(admin1);

        let res = client.try_upgrade(&new_wasm_hash, &upgrade_signers);
        assert_eq!(res, Err(Ok(EscrowError::InsufficientAdminSignatures)));
    }

    #[test]
    fn test_upgrade_before_initialize_fails() {
        let (env, _depositor, _beneficiary, _arbiter, _fee_recipient, _token, client) = setup();

        let dummy_wasm = Bytes::new(&env);
        let new_wasm_hash = env.deployer().upload_contract_wasm(dummy_wasm);

        let upgrade_signers: Vec<Address> = Vec::new(&env);
        let res = client.try_upgrade(&new_wasm_hash, &upgrade_signers);
        assert_eq!(res, Err(Ok(EscrowError::NotInitialised)));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Storage layout (hot / cold split) and migration
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_admin_signers_live_outside_the_hot_state() {
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup();
        env.ledger().set_timestamp(100);

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let mut admin_signers: Vec<Address> = Vec::new(&env);
        admin_signers.push_back(admin1);
        admin_signers.push_back(admin2);

        let amount: i128 = 500_000;
        client.initialize(
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            &amount,
            &1_000,
            &100,
            &0,
            &fee_recipient,
            &admin_signers,
            &2,
        );

        // The hot entry carries only what the fund-moving paths need…
        let state = client.get_state();
        assert_eq!(state.amount, amount);
        assert_eq!(state.status, EscrowStatus::Pending);

        // …and the cold entry keeps the upgrade material.
        let admins = client.get_admins();
        assert_eq!(admins.required_admin_signatures, 2);
        assert_eq!(admins.admin_signers.len(), 2);
        assert_eq!(
            admins.admin_signers.get(0).unwrap(),
            admin_signers.get(0).unwrap()
        );
    }

    #[test]
    fn test_legacy_state_is_split_on_first_read() {
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup();
        env.ledger().set_timestamp(100);

        let admin1 = Address::generate(&env);
        let mut admin_signers: Vec<Address> = Vec::new(&env);
        admin_signers.push_back(admin1);

        let amount: i128 = 500_000;
        client.initialize(
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            &amount,
            &1_000,
            &100,
            &0,
            &fee_recipient,
            &admin_signers,
            &1,
        );

        // Rewrite storage the way an older wasm left it: one entry holding
        // everything, and no `ESCROW_ADMINS` entry at all.
        env.as_contract(&client.address, || {
            let legacy = LegacyEscrowState {
                depositor: depositor.clone(),
                beneficiary: beneficiary.clone(),
                arbiter: arbiter.clone(),
                token: token.clone(),
                amount,
                emergency_unlock_timestamp: 1_000,
                lock_until_ledger: 100,
                fee_bps: 0,
                fee_recipient: fee_recipient.clone(),
                released: false,
                admin_signers: admin_signers.clone(),
                required_admin_signatures: 1,
            };
            env.storage().instance().set(&ESCROW, &legacy);
            env.storage().instance().remove(&ESCROW_ADMINS);
        });

        // First read migrates the entry into the two-key layout…
        let state = client.get_state();
        assert_eq!(state.amount, amount);

        let admins = client.get_admins();
        assert_eq!(admins.required_admin_signatures, 1);
        assert_eq!(admins.admin_signers.len(), 1);

        // …and the migrated admin material still authorises an upgrade.
        let dummy_wasm = Bytes::new(&env);
        let new_wasm_hash = env.deployer().upload_contract_wasm(dummy_wasm);
        client.upgrade(&new_wasm_hash, &admin_signers);
    }

    // ---------------------------------------------------------------------
    // 5. Reentrancy guard
    // ---------------------------------------------------------------------
    //
    // Soroban's host rejects any call into a contract that is already on the
    // call stack, so today's protocol already refuses the callback that would
    // drive a reentrancy attack. This guard is defence-in-depth on top of
    // that: it pins the checks-effects-interactions ordering in place and
    // keeps the contract safe if the host ever relaxes that rule. The lock is
    // ordinary storage, so it can be exercised directly here — hold it the way
    // an in-flight call would and check that every fund-moving entry point
    // turns the caller away until it is released.

    #[test]
    fn test_reentrancy_lock_blocks_every_fund_moving_entry_point() {
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup();
        env.ledger().set_timestamp(100);

        let amount: i128 = 500_000;
        let admin_signers: Vec<Address> = Vec::new(&env);
        client.initialize(
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            &amount,
            &1_000,
            &100,
            &0,
            &fee_recipient,
            &admin_signers,
            &0,
        );

        let token_client = TokenClient::new(&env, &token);

        // Stand exactly where an in-flight call would leave storage: held.
        env.as_contract(&client.address, || {
            env.storage().instance().set(&REENTRANCY, &true);
        });
        assert!(client.reentrancy_guard_active());

        assert!(client.try_release().is_err());
        assert!(client.try_refund().is_err());
        assert!(client.try_emergency_refund().is_err());
        assert!(client.try_self_refund().is_err());

        // Nothing moved while the lock was held.
        assert_eq!(client.get_state().status, EscrowStatus::Pending);
        assert_eq!(token_client.balance(&client.address), amount);
        assert_eq!(token_client.balance(&beneficiary), 0);

        // Clear it and the very same call now succeeds.
        env.as_contract(&client.address, || {
            env.storage().instance().remove(&REENTRANCY);
        });
        assert!(!client.reentrancy_guard_active());

        client.release();
        assert_eq!(client.get_state().status, EscrowStatus::Completed);
        assert_eq!(token_client.balance(&beneficiary), amount);
        assert_eq!(token_client.balance(&client.address), 0);
        assert!(!client.reentrancy_guard_active());
    }

    #[test]
    fn test_reentrancy_lock_is_released_after_a_failed_call() {
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup();
        env.ledger().set_timestamp(100);

        let amount: i128 = 500_000;
        let admin_signers: Vec<Address> = Vec::new(&env);
        client.initialize(
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            &amount,
            &1_000,
            &100,
            &0,
            &fee_recipient,
            &admin_signers,
            &0,
        );

        // A failed entry point must not leave the lock behind for the next
        // caller — the guard unwinds with the frame either way. Here the
        // upgrade fails because no admin signers were configured.
        let dummy_wasm = Bytes::new(&env);
        let new_wasm_hash = env.deployer().upload_contract_wasm(dummy_wasm);
        assert!(client.try_upgrade(&new_wasm_hash, &admin_signers).is_err());
        assert!(!client.reentrancy_guard_active());

        // The next call sees a free lock.
        client.release();
        assert_eq!(client.get_state().status, EscrowStatus::Completed);
        assert!(!client.reentrancy_guard_active());
    }
}
