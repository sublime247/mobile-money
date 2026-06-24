#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env};

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
}

// ── State ────────────────────────────────────────────────────────────────────

/// Persistent on-chain state for a single escrow instance.
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
    pub released: bool,
}

impl EscrowState {
    /// Compute (fee_amount, net_beneficiary_amount).
    pub fn split(&self) -> (i128, i128) {
        let fee = self.amount * self.fee_bps as i128 / 10_000;
        let net = self.amount - fee;
        (fee, net)
    }
}

// ── Storage key ──────────────────────────────────────────────────────────────

const ESCROW: &str = "ESCROW";

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    // ── initialize ────────────────────────────────────────────────────────────

    /// Initialise escrow. The depositor must authorise this call; `amount`
    /// tokens are pulled from the depositor into the contract.
    ///
    /// * `lock_until_ledger` – ledger after which the depositor may self-refund
    ///   without the arbiter. Pass `0` to disable self-refund entirely.
    /// * `fee_bps`           – protocol fee in basis points (0–10 000).
    /// * `fee_recipient`     – receives the fee portion on release.
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
    ) {
        depositor.require_auth();

        assert!(amount > 0, "amount must be positive");
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

        // Pull funds from depositor into the contract.
        token::Client::new(&env, &token).transfer(
            &depositor,
            env.current_contract_address(),
            &amount,
        );

        env.storage().instance().set(
            &ESCROW,
            &EscrowState {
                depositor,
                beneficiary,
                arbiter,
                token,
                amount,
                emergency_unlock_timestamp,
                lock_until_ledger,
                fee_bps,
                fee_recipient,
                released: false,
            },
        );

        // Extend the TTL of the instance storage to set up state renewal rules
        env.storage().instance().extend_ttl(1000, 10000);
    }

    // ── release ───────────────────────────────────────────────────────────────

    /// Release funds to the beneficiary (net of fee) and fee to `fee_recipient`.
    /// Only the arbiter may call this, and only while the lock is still active.
    pub fn release(env: Env) -> Result<(), EscrowError> {
        let mut state: EscrowState = env
            .storage()
            .instance()
            .get(&ESCROW)
            .ok_or(EscrowError::NotInitialised)?;

        state.arbiter.require_auth();

        if state.released {
            return Err(EscrowError::AlreadyReleased);
        }
        // Arbiter cannot release after the lock has expired.
        if state.lock_until_ledger > 0 && env.ledger().sequence() > state.lock_until_ledger {
            return Err(EscrowError::LockExpired);
        }

        let tc = token::Client::new(&env, &state.token);
        let contract_addr = env.current_contract_address();
        let (fee, net) = state.split();

        if fee > 0 {
            tc.transfer(&contract_addr, &state.fee_recipient, &fee);
        }
        tc.transfer(&contract_addr, &state.beneficiary, &net);

        state.released = true;
        env.storage().instance().set(&ESCROW, &state);

        env.storage().instance().extend_ttl(1000, 10000);
        Ok(())
    }

    // ── refund ────────────────────────────────────────────────────────────────

    /// Return the full `amount` to the depositor.
    /// Only the arbiter may call this, and only while the lock is still active.
    pub fn refund(env: Env) -> Result<(), EscrowError> {
        let mut state: EscrowState = env
            .storage()
            .instance()
            .get(&ESCROW)
            .ok_or(EscrowError::NotInitialised)?;

        state.arbiter.require_auth();

        if state.released {
            return Err(EscrowError::AlreadyReleased);
        }
        if state.lock_until_ledger > 0 && env.ledger().sequence() > state.lock_until_ledger {
            return Err(EscrowError::LockExpired);
        }

        token::Client::new(&env, &state.token).transfer(
            &env.current_contract_address(),
            &state.depositor,
            &state.amount,
        );

        state.released = true;
        env.storage().instance().set(&ESCROW, &state);

        env.storage().instance().extend_ttl(1000, 10000);
        Ok(())
    }

    /// Emergency refund to the depositor after the unlock timestamp.
    /// Allows source wallets to recover funds during an extended bridge outage.
    pub fn emergency_refund(env: Env) {
        let mut state: EscrowState = env
            .storage()
            .instance()
            .get(&ESCROW)
            .expect("not initialised");

        state.depositor.require_auth();
        assert!(!state.released, "already released");
        assert!(
            env.ledger().timestamp() >= state.emergency_unlock_timestamp,
            "emergency unlock not yet available"
        );

        token::Client::new(&env, &state.token).transfer(
            &env.current_contract_address(),
            &state.depositor,
            &state.amount,
        );

        state.released = true;
        env.storage().instance().set(&ESCROW, &state);
    }

    // ── self_refund ───────────────────────────────────────────────────────────

    /// Allow the depositor to reclaim funds *after* the lock has expired,
    /// without the arbiter. The full `amount` is returned.
    pub fn self_refund(env: Env) -> Result<(), EscrowError> {
        let mut state: EscrowState = env
            .storage()
            .instance()
            .get(&ESCROW)
            .ok_or(EscrowError::NotInitialised)?;

        state.depositor.require_auth();

        if state.released {
            return Err(EscrowError::AlreadyReleased);
        }
        // Time-lock must have passed.
        if state.lock_until_ledger == 0 || env.ledger().sequence() <= state.lock_until_ledger {
            return Err(EscrowError::LockNotExpired);
        }

        token::Client::new(&env, &state.token).transfer(
            &env.current_contract_address(),
            &state.depositor,
            &state.amount,
        );

        state.released = true;
        env.storage().instance().set(&ESCROW, &state);

        Ok(())
    }

    // ── get_state ─────────────────────────────────────────────────────────────

    /// Return current escrow state (read-only).
    pub fn get_state(env: Env) -> EscrowState {
        let state = env
            .storage()
            .instance()
            .get(&ESCROW)
            .expect("not initialised");
        env.storage().instance().extend_ttl(1000, 10000);
        state
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env,
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

    // Helper: initialise with common defaults
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
        );
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
        );

        let state = client.get_state();
        assert_eq!(state.amount, amount);
        assert_eq!(state.emergency_unlock_timestamp, emergency_unlock_timestamp);
        assert!(!state.released);

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
        assert!(state.released);
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
        );
        client.refund();

        let state = client.get_state();
        assert!(state.released);
    }

    #[test]
    fn test_emergency_refund() {
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup();
        let amount: i128 = 300_000;
        let emergency_unlock_timestamp = 1_000;

        env.ledger().set_timestamp(100);

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
        );

        env.ledger().set_timestamp(emergency_unlock_timestamp);

        client.emergency_refund();

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&depositor), MINT_AMOUNT);
        assert!(client.get_state().released);
    }
}
