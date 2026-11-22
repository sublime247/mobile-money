#![no_std]
//! Time-locked treasury withdrawal contract (issue #2005).
//!
//! Large withdrawals from an anchor's treasury reserve are routed through
//! this contract instead of moving funds directly, so a compromised or
//! malicious admin key cannot immediately drain reserves: any withdrawal at
//! or above the configured threshold must sit in a 48-hour window during
//! which a second admin action (`cancel_withdrawal`) can stop it.
//!
//! ## Threshold units
//!
//! The issue specifies the threshold in USD ("> $50,000 USD equivalent").
//! This contract has no on-chain price feed dependency (none was requested
//! by the issue, and adding one is a separate, oracle-integration-shaped
//! problem — see `contracts/oracle` for the existing price-oracle contract
//! this could be wired to later). Instead, `min_timelock_amount` is
//! configured directly in the reserve token's own stroop units at
//! `initialize` time; the deploying anchor is responsible for converting
//! its $50,000 policy into that token's units (and updating it if the
//! token's fiat value materially drifts).

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short, token,
    xdr::ToXdr, Address, BytesN, Env, Map, Symbol, Vec,
};

const CONFIG: Symbol = symbol_short!("CONFIG");
const REQUESTS: Symbol = symbol_short!("REQUESTS");
const NEXT_ID: Symbol = symbol_short!("NEXT_ID");
const GOVERNANCE: Symbol = symbol_short!("GOVERN");
const CANCEL_VOTES: Symbol = symbol_short!("CANCEL_V");

/// The mandatory delay between initiating and executing a withdrawal that
/// meets or exceeds `min_timelock_amount`.
pub const TIMELOCK_DURATION_SECONDS: u64 = 48 * 60 * 60;

#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum TimelockError {
    /// Contract has already been initialized.
    AlreadyInitialized = 1,
    /// Contract must be initialized before this call.
    NotInitialized = 2,
    /// A withdrawal amount must be strictly positive.
    InvalidAmount = 3,
    /// No withdrawal request exists for the given id.
    RequestNotFound = 4,
    /// The request has already been executed or cancelled.
    RequestAlreadyResolved = 5,
    /// `execute_withdrawal` was called before the 48-hour delay elapsed.
    TimelockNotExpired = 6,
    /// The governance admin list or cancellation threshold was invalid.
    InvalidGovernanceConfig = 7,
    /// The caller is not one of the configured governance admins.
    UnauthorizedGovernanceAdmin = 8,
    /// This governance admin has already voted to cancel the operation.
    AlreadyVoted = 9,
}

#[contracttype]
#[derive(Clone)]
pub struct TimelockConfig {
    pub admin: Address,
    pub token: Address,
    /// Withdrawals below this amount execute immediately via
    /// `withdraw_immediate`; at or above it, a withdrawal must go through
    /// `initiate_withdrawal`'s 48-hour delay.
    pub min_timelock_amount: i128,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum WithdrawalStatus {
    Pending,
    Executed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct GovernanceConfig {
    pub admins: Vec<Address>,
    pub cancellation_threshold: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct CancellationStatus {
    pub request_id: u64,
    pub approvals: Vec<Address>,
    pub threshold: u32,
}

// ── Events ───────────────────────────────────────────────────────────────────

#[contractevent(topics = ["timelock", "withdrawal_initiated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawalInitiated {
    #[topic]
    pub request_id: u64,
    pub amount: i128,
    pub executable_at: u64,
}

#[contractevent(topics = ["timelock", "withdrawal_cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawalCancelled {
    #[topic]
    pub request_id: u64,
}

#[contractevent(topics = ["timelock", "withdrawal_executed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawalExecuted {
    #[topic]
    pub request_id: u64,
}

#[contractevent(topics = ["timelock", "cancellation_vote_cast"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CancellationVoteCast {
    #[topic]
    pub request_id: u64,
    #[topic]
    pub admin: Address,
    pub approvals: u32,
    pub threshold: u32,
}

#[contractevent(topics = ["timelock", "operation_cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationCancelled {
    #[topic]
    pub request_id: u64,
    #[topic]
    pub operation_hash: BytesN<32>,
    pub approving_admins: Vec<Address>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct WithdrawalRequest {
    pub id: u64,
    pub recipient: Address,
    pub amount: i128,
    pub requested_at: u64,
    /// Ledger timestamp after which `execute_withdrawal` is permitted.
    pub executable_at: u64,
    pub status: WithdrawalStatus,
}

#[contract]
pub struct TimelockContract;

#[contractimpl]
impl TimelockContract {
    /// Initialize the contract. Callable exactly once.
    pub fn initialize(
        env: Env,
        admin: Address,
        token: Address,
        min_timelock_amount: i128,
    ) -> Result<(), TimelockError> {
        if env.storage().instance().has(&CONFIG) {
            return Err(TimelockError::AlreadyInitialized);
        }
        if min_timelock_amount <= 0 {
            return Err(TimelockError::InvalidAmount);
        }

        admin.require_auth();

        let mut governance_admins = Vec::new(&env);
        governance_admins.push_back(admin.clone());
        env.storage().instance().set(
            &CONFIG,
            &TimelockConfig {
                admin,
                token,
                min_timelock_amount,
            },
        );
        env.storage().instance().set(
            &GOVERNANCE,
            &GovernanceConfig {
                admins: governance_admins,
                cancellation_threshold: 1,
            },
        );
        env.storage()
            .instance()
            .set(&REQUESTS, &Map::<u64, WithdrawalRequest>::new(&env));
        env.storage()
            .instance()
            .set(&CANCEL_VOTES, &Map::<u64, Vec<Address>>::new(&env));
        env.storage().instance().set(&NEXT_ID, &0u64);
        env.storage().instance().extend_ttl(1000, 10000);

        Ok(())
    }

    /// Initiate a time-locked withdrawal of `amount` to `recipient`.
    /// Admin-only. Returns the new request's id.
    ///
    /// Funds are pulled from the contract's own balance at execution time,
    /// not at initiation, so initiating a request does not itself move
    /// funds: only `execute_withdrawal`, after the delay, does.
    pub fn initiate_withdrawal(
        env: Env,
        recipient: Address,
        amount: i128,
    ) -> Result<u64, TimelockError> {
        let config = Self::get_config(&env)?;
        config.admin.require_auth();

        if amount <= 0 {
            return Err(TimelockError::InvalidAmount);
        }

        let now = env.ledger().timestamp();
        let mut requests = Self::get_requests(&env);
        let id = Self::next_id(&env);

        let executable_at = now.saturating_add(TIMELOCK_DURATION_SECONDS);

        requests.set(
            id,
            WithdrawalRequest {
                id,
                recipient,
                amount,
                requested_at: now,
                executable_at,
                status: WithdrawalStatus::Pending,
            },
        );
        env.storage().instance().set(&REQUESTS, &requests);
        env.storage().instance().extend_ttl(1000, 10000);

        WithdrawalInitiated {
            request_id: id,
            amount,
            executable_at,
        }
        .publish(&env);

        Ok(id)
    }

    /// Configure the governance admin set and the M-of-N threshold required
    /// to cancel a pending operation. Admin-only.
    pub fn configure_governance(
        env: Env,
        admins: Vec<Address>,
        cancellation_threshold: u32,
    ) -> Result<(), TimelockError> {
        let config = Self::get_config(&env)?;
        config.admin.require_auth();

        if admins.is_empty() || cancellation_threshold == 0 {
            return Err(TimelockError::InvalidGovernanceConfig);
        }
        if cancellation_threshold > admins.len() {
            return Err(TimelockError::InvalidGovernanceConfig);
        }
        for i in 0..admins.len() {
            let admin = admins.get(i).unwrap();
            for j in (i + 1)..admins.len() {
                if admin == admins.get(j).unwrap() {
                    return Err(TimelockError::InvalidGovernanceConfig);
                }
            }
        }

        env.storage().instance().set(
            &GOVERNANCE,
            &GovernanceConfig {
                admins,
                cancellation_threshold,
            },
        );
        env.storage()
            .instance()
            .set(&CANCEL_VOTES, &Map::<u64, Vec<Address>>::new(&env));
        env.storage().instance().extend_ttl(1000, 10000);

        Ok(())
    }

    /// Cast a governance admin's signed cancellation vote for a pending
    /// operation. Returns the total approvals recorded so far; once the
    /// configured threshold is reached the operation is cancelled atomically.
    pub fn vote_cancel(env: Env, request_id: u64, admin: Address) -> Result<u32, TimelockError> {
        let governance = Self::load_governance(&env)?;
        if !governance.admins.iter().any(|a| a == admin) {
            return Err(TimelockError::UnauthorizedGovernanceAdmin);
        }
        admin.require_auth();

        let mut requests = Self::get_requests(&env);
        let request = requests
            .get(request_id)
            .ok_or(TimelockError::RequestNotFound)?;
        if request.status != WithdrawalStatus::Pending {
            return Err(TimelockError::RequestAlreadyResolved);
        }

        let mut votes = Self::get_cancel_votes(&env);
        let mut approvals = votes.get(request_id).unwrap_or_else(|| Vec::new(&env));
        if approvals.iter().any(|a| a == admin) {
            return Err(TimelockError::AlreadyVoted);
        }
        approvals.push_back(admin.clone());

        let approval_count = approvals.len();
        if approval_count >= governance.cancellation_threshold {
            let operation_hash = Self::operation_hash(&env, &request);
            let mut cancelled = request;
            cancelled.status = WithdrawalStatus::Cancelled;
            requests.set(request_id, cancelled);
            env.storage().instance().set(&REQUESTS, &requests);

            votes.remove(request_id);
            env.storage().instance().set(&CANCEL_VOTES, &votes);
            env.storage().instance().extend_ttl(1000, 10000);

            WithdrawalCancelled { request_id }.publish(&env);
            OperationCancelled {
                request_id,
                operation_hash,
                approving_admins: approvals.clone(),
            }
            .publish(&env);
        } else {
            votes.set(request_id, approvals.clone());
            env.storage().instance().set(&CANCEL_VOTES, &votes);
            env.storage().instance().extend_ttl(1000, 10000);

            CancellationVoteCast {
                request_id,
                admin,
                approvals: approval_count,
                threshold: governance.cancellation_threshold,
            }
            .publish(&env);
        }

        Ok(approval_count)
    }

    /// Submit a cancellation vote under the `cancel_operation` name. This is
    /// the same thresholded flow as `vote_cancel`; the operation is cancelled
    /// automatically as soon as the required number of admins have approved.
    pub fn cancel_operation(
        env: Env,
        request_id: u64,
        admin: Address,
    ) -> Result<u32, TimelockError> {
        Self::vote_cancel(env, request_id, admin)
    }

    /// Legacy single-admin cancellation entry point. It records the primary
    /// admin's cancellation vote; with the default one-of-one governance
    /// configuration this cancels immediately, while a multi-admin setup
    /// requires the remaining approvals through `vote_cancel`.
    pub fn cancel_withdrawal(env: Env, request_id: u64) -> Result<(), TimelockError> {
        let config = Self::get_config(&env)?;
        Self::vote_cancel(env, request_id, config.admin)?;
        Ok(())
    }

    pub fn get_governance(env: Env) -> Result<GovernanceConfig, TimelockError> {
        Self::load_governance(&env)
    }

    pub fn get_cancellation_status(
        env: Env,
        request_id: u64,
    ) -> Result<CancellationStatus, TimelockError> {
        let governance = Self::load_governance(&env)?;
        let approvals = Self::get_cancel_votes(&env)
            .get(request_id)
            .unwrap_or_else(|| Vec::new(&env));
        Ok(CancellationStatus {
            request_id,
            approvals,
            threshold: governance.cancellation_threshold,
        })
    }

    /// Execute a pending withdrawal once its 48-hour delay has elapsed.
    /// Callable by anyone (a "keeper" pattern, matching this repo's other
    /// permissionless-execution contracts): the delay itself is the
    /// safeguard, not caller authorization, so there is no reason to
    /// restrict who can trigger a withdrawal that has already survived its
    /// full review window.
    pub fn execute_withdrawal(env: Env, request_id: u64) -> Result<(), TimelockError> {
        let config = Self::get_config(&env)?;

        let mut requests = Self::get_requests(&env);
        let mut request = requests
            .get(request_id)
            .ok_or(TimelockError::RequestNotFound)?;

        if request.status != WithdrawalStatus::Pending {
            return Err(TimelockError::RequestAlreadyResolved);
        }
        if env.ledger().timestamp() < request.executable_at {
            return Err(TimelockError::TimelockNotExpired);
        }

        token::Client::new(&env, &config.token).transfer(
            &env.current_contract_address(),
            &request.recipient,
            &request.amount,
        );

        request.status = WithdrawalStatus::Executed;
        requests.set(request_id, request);
        env.storage().instance().set(&REQUESTS, &requests);

        let mut votes = Self::get_cancel_votes(&env);
        votes.remove(request_id);
        env.storage().instance().set(&CANCEL_VOTES, &votes);
        env.storage().instance().extend_ttl(1000, 10000);

        WithdrawalExecuted { request_id }.publish(&env);

        Ok(())
    }

    /// Withdraw an amount below `min_timelock_amount` immediately, with no
    /// delay. Admin-only. Exists so day-to-day operational withdrawals
    /// below the policy threshold are not forced through the 48-hour
    /// window meant for large, higher-risk withdrawals.
    pub fn withdraw_immediate(
        env: Env,
        recipient: Address,
        amount: i128,
    ) -> Result<(), TimelockError> {
        let config = Self::get_config(&env)?;
        config.admin.require_auth();

        if amount <= 0 {
            return Err(TimelockError::InvalidAmount);
        }
        if amount >= config.min_timelock_amount {
            return Err(TimelockError::InvalidAmount);
        }

        token::Client::new(&env, &config.token).transfer(
            &env.current_contract_address(),
            &recipient,
            &amount,
        );

        Ok(())
    }

    pub fn get_request(env: Env, request_id: u64) -> Result<WithdrawalRequest, TimelockError> {
        Self::get_requests(&env)
            .get(request_id)
            .ok_or(TimelockError::RequestNotFound)
    }

    pub fn min_timelock_amount(env: Env) -> Result<i128, TimelockError> {
        Ok(Self::get_config(&env)?.min_timelock_amount)
    }
}

impl TimelockContract {
    fn get_config(env: &Env) -> Result<TimelockConfig, TimelockError> {
        env.storage()
            .instance()
            .get(&CONFIG)
            .ok_or(TimelockError::NotInitialized)
    }

    fn load_governance(env: &Env) -> Result<GovernanceConfig, TimelockError> {
        env.storage()
            .instance()
            .get(&GOVERNANCE)
            .ok_or(TimelockError::NotInitialized)
    }

    fn get_requests(env: &Env) -> Map<u64, WithdrawalRequest> {
        env.storage()
            .instance()
            .get(&REQUESTS)
            .unwrap_or_else(|| Map::new(env))
    }

    fn get_cancel_votes(env: &Env) -> Map<u64, Vec<Address>> {
        env.storage()
            .instance()
            .get(&CANCEL_VOTES)
            .unwrap_or_else(|| Map::new(env))
    }

    fn operation_hash(env: &Env, request: &WithdrawalRequest) -> BytesN<32> {
        let mut bytes = request.id.to_xdr(env);
        bytes.append(&request.recipient.clone().to_xdr(env));
        bytes.append(&request.amount.to_xdr(env));
        bytes.append(&request.requested_at.to_xdr(env));
        bytes.append(&request.executable_at.to_xdr(env));
        env.crypto().sha256(&bytes).into()
    }

    fn next_id(env: &Env) -> u64 {
        let id: u64 = env.storage().instance().get(&NEXT_ID).unwrap_or(0);
        env.storage().instance().set(&NEXT_ID, &(id + 1));
        id
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::testutils::{Address as _, Events as _, Ledger};
    use soroban_sdk::Event;

    /// 7-decimal-place stroop units, matching this repo's other contracts'
    /// SAC test tokens.
    const STROOP: i128 = 1;
    const UNIT: i128 = 10_000_000 * STROOP;
    const THRESHOLD: i128 = 50_000 * UNIT;
    const ABOVE_THRESHOLD: i128 = 60_000 * UNIT;
    const BELOW_THRESHOLD: i128 = 1_000 * UNIT;

    fn setup(env: &Env) -> (TimelockContractClient<'_>, Address, Address) {
        env.mock_all_auths();
        let admin = Address::generate(env);
        let token_admin = Address::generate(env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin);
        let token = token_id.address();

        let contract_id = env.register(TimelockContract, ());
        let client = TimelockContractClient::new(env, &contract_id);
        client.initialize(&admin, &token, &THRESHOLD);

        // Fund the contract so executed withdrawals have something to pay
        // out of.
        let sac = token::StellarAssetClient::new(env, &token);
        sac.mint(&contract_id, &(1_000_000 * UNIT));

        (client, admin, token)
    }

    #[test]
    fn initiate_then_execute_after_delay_pays_out() {
        let env = Env::default();
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let (client, _admin, token) = setup(&env);
        let recipient = Address::generate(&env);

        let amount = ABOVE_THRESHOLD;
        let id = client.initiate_withdrawal(&recipient, &amount);

        let request = client.get_request(&id);
        assert_eq!(request.status, WithdrawalStatus::Pending);
        assert_eq!(request.executable_at, 1_000 + TIMELOCK_DURATION_SECONDS);

        env.ledger()
            .with_mut(|li| li.timestamp = 1_000 + TIMELOCK_DURATION_SECONDS);
        client.execute_withdrawal(&id);

        let request = client.get_request(&id);
        assert_eq!(request.status, WithdrawalStatus::Executed);
        assert_eq!(token::Client::new(&env, &token).balance(&recipient), amount);
    }

    #[test]
    fn execute_before_delay_elapsed_is_rejected() {
        let env = Env::default();
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let (client, _admin, _token) = setup(&env);
        let recipient = Address::generate(&env);

        let id = client.initiate_withdrawal(&recipient, &ABOVE_THRESHOLD);

        // One second before the delay elapses.
        env.ledger()
            .with_mut(|li| li.timestamp = 1_000 + TIMELOCK_DURATION_SECONDS - 1);

        let result = client.try_execute_withdrawal(&id);
        assert_eq!(result, Err(Ok(TimelockError::TimelockNotExpired)));
    }

    #[test]
    fn execute_at_exactly_the_delay_boundary_succeeds() {
        let env = Env::default();
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let (client, _admin, _token) = setup(&env);
        let recipient = Address::generate(&env);

        let id = client.initiate_withdrawal(&recipient, &ABOVE_THRESHOLD);

        env.ledger()
            .with_mut(|li| li.timestamp = 1_000 + TIMELOCK_DURATION_SECONDS);

        let result = client.try_execute_withdrawal(&id);
        assert!(result.is_ok());
    }

    #[test]
    fn admin_can_cancel_a_pending_withdrawal_during_the_lock_window() {
        let env = Env::default();
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let (client, _admin, token) = setup(&env);
        let recipient = Address::generate(&env);

        let id = client.initiate_withdrawal(&recipient, &ABOVE_THRESHOLD);
        client.cancel_withdrawal(&id);

        let request = client.get_request(&id);
        assert_eq!(request.status, WithdrawalStatus::Cancelled);

        // Advancing past the delay and attempting to execute must still
        // fail: cancellation is permanent, not merely a pause.
        env.ledger()
            .with_mut(|li| li.timestamp = 1_000 + TIMELOCK_DURATION_SECONDS);
        let result = client.try_execute_withdrawal(&id);
        assert_eq!(result, Err(Ok(TimelockError::RequestAlreadyResolved)));
        assert_eq!(token::Client::new(&env, &token).balance(&recipient), 0);
    }

    #[test]
    fn cannot_cancel_an_already_executed_withdrawal() {
        let env = Env::default();
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let (client, _admin, _token) = setup(&env);
        let recipient = Address::generate(&env);

        let id = client.initiate_withdrawal(&recipient, &ABOVE_THRESHOLD);
        env.ledger()
            .with_mut(|li| li.timestamp = 1_000 + TIMELOCK_DURATION_SECONDS);
        client.execute_withdrawal(&id);

        let result = client.try_cancel_withdrawal(&id);
        assert_eq!(result, Err(Ok(TimelockError::RequestAlreadyResolved)));
    }

    #[test]
    fn cannot_execute_an_already_executed_withdrawal_twice() {
        let env = Env::default();
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let (client, _admin, _token) = setup(&env);
        let recipient = Address::generate(&env);

        let id = client.initiate_withdrawal(&recipient, &ABOVE_THRESHOLD);
        env.ledger()
            .with_mut(|li| li.timestamp = 1_000 + TIMELOCK_DURATION_SECONDS);
        client.execute_withdrawal(&id);

        let result = client.try_execute_withdrawal(&id);
        assert_eq!(result, Err(Ok(TimelockError::RequestAlreadyResolved)));
    }

    #[test]
    fn nonexistent_request_id_is_rejected_everywhere() {
        let env = Env::default();
        let (client, _admin, _token) = setup(&env);

        assert_eq!(
            client.try_get_request(&999),
            Err(Ok(TimelockError::RequestNotFound))
        );
        assert_eq!(
            client.try_execute_withdrawal(&999),
            Err(Ok(TimelockError::RequestNotFound))
        );
        assert_eq!(
            client.try_cancel_withdrawal(&999),
            Err(Ok(TimelockError::RequestNotFound))
        );
    }

    #[test]
    fn initiate_withdrawal_requires_admin_auth() {
        let env = Env::default();
        // Do NOT call env.mock_all_auths() globally for this test.
        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin);
        let token = token_id.address();

        let contract_id = env.register(TimelockContract, ());
        let client = TimelockContractClient::new(&env, &contract_id);

        env.mock_all_auths();
        client.initialize(&admin, &token, &THRESHOLD);

        // Clear mocked auths so the next call is checked for real.
        env.set_auths(&[]);
        let recipient = Address::generate(&env);
        let result = client.try_initiate_withdrawal(&recipient, &ABOVE_THRESHOLD);
        assert!(result.is_err());
    }

    #[test]
    fn initiate_withdrawal_rejects_non_positive_amount() {
        let env = Env::default();
        let (client, _admin, _token) = setup(&env);
        let recipient = Address::generate(&env);

        assert_eq!(
            client.try_initiate_withdrawal(&recipient, &0i128),
            Err(Ok(TimelockError::InvalidAmount))
        );
        assert_eq!(
            client.try_initiate_withdrawal(&recipient, &-1i128),
            Err(Ok(TimelockError::InvalidAmount))
        );
    }

    #[test]
    fn withdraw_immediate_below_threshold_pays_out_with_no_delay() {
        let env = Env::default();
        let (client, _admin, token) = setup(&env);
        let recipient = Address::generate(&env);

        let amount = BELOW_THRESHOLD;
        client.withdraw_immediate(&recipient, &amount);

        assert_eq!(token::Client::new(&env, &token).balance(&recipient), amount);
    }

    #[test]
    fn withdraw_immediate_rejects_amount_at_or_above_threshold() {
        let env = Env::default();
        let (client, _admin, _token) = setup(&env);
        let recipient = Address::generate(&env);

        let result = client.try_withdraw_immediate(&recipient, &THRESHOLD);
        assert_eq!(result, Err(Ok(TimelockError::InvalidAmount)));
    }

    #[test]
    fn double_initialize_is_rejected() {
        let env = Env::default();
        let (client, admin, token) = setup(&env);

        let result = client.try_initialize(&admin, &token, &THRESHOLD);
        assert_eq!(result, Err(Ok(TimelockError::AlreadyInitialized)));
    }

    fn governance_setup(env: &Env) -> (TimelockContractClient<'_>, Address, Address, Address) {
        let (client, admin1, _token) = setup(env);
        let admin2 = Address::generate(env);
        let admin3 = Address::generate(env);
        let mut admins = Vec::new(env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());
        admins.push_back(admin3.clone());
        client.configure_governance(&admins, &2u32);
        (client, admin1, admin2, admin3)
    }

    #[test]
    fn multi_admin_cancellation_requires_threshold_and_emits_operation_cancelled() {
        let env = Env::default();
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let (client, admin1, admin2, _admin3) = governance_setup(&env);
        let recipient = Address::generate(&env);

        let id = client.initiate_withdrawal(&recipient, &ABOVE_THRESHOLD);
        let request = client.get_request(&id);

        assert_eq!(client.vote_cancel(&id, &admin1), 1);
        assert_eq!(client.get_request(&id).status, WithdrawalStatus::Pending);

        let status = client.get_cancellation_status(&id);
        assert_eq!(status.threshold, 2);
        assert_eq!(status.approvals.len(), 1);

        assert_eq!(client.vote_cancel(&id, &admin2), 2);

        let mut approvals = Vec::new(&env);
        approvals.push_back(admin1);
        approvals.push_back(admin2);
        let expected = OperationCancelled {
            request_id: id,
            operation_hash: TimelockContract::operation_hash(&env, &request),
            approving_admins: approvals,
        };
        let emitted = env.events().all().filter_by_contract(&client.address);
        assert_eq!(
            emitted.events().last(),
            Some(&expected.to_xdr(&env, &client.address))
        );

        assert_eq!(client.get_request(&id).status, WithdrawalStatus::Cancelled);
        assert_eq!(client.get_cancellation_status(&id).approvals.len(), 0);

        env.ledger()
            .with_mut(|li| li.timestamp = 1_000 + TIMELOCK_DURATION_SECONDS);
        assert_eq!(
            client.try_execute_withdrawal(&id),
            Err(Ok(TimelockError::RequestAlreadyResolved))
        );
    }

    #[test]
    fn unauthorized_accounts_cannot_vote_or_cancel() {
        let env = Env::default();
        let (client, admin1, _admin2, _admin3) = governance_setup(&env);
        let recipient = Address::generate(&env);
        let id = client.initiate_withdrawal(&recipient, &ABOVE_THRESHOLD);
        let outsider = Address::generate(&env);

        assert_eq!(
            client.try_vote_cancel(&id, &outsider),
            Err(Ok(TimelockError::UnauthorizedGovernanceAdmin))
        );
        assert_eq!(
            client.try_cancel_operation(&id, &outsider),
            Err(Ok(TimelockError::UnauthorizedGovernanceAdmin))
        );

        // Even a real governance admin must supply their own authorization.
        env.set_auths(&[]);
        assert!(client.try_vote_cancel(&id, &admin1).is_err());
        assert!(client.try_cancel_operation(&id, &admin1).is_err());
    }

    #[test]
    fn governance_admin_cannot_vote_twice() {
        let env = Env::default();
        let (client, admin1, _admin2, _admin3) = governance_setup(&env);
        let recipient = Address::generate(&env);
        let id = client.initiate_withdrawal(&recipient, &ABOVE_THRESHOLD);

        client.vote_cancel(&id, &admin1);

        assert_eq!(
            client.try_vote_cancel(&id, &admin1),
            Err(Ok(TimelockError::AlreadyVoted))
        );
    }

    #[test]
    fn cancel_operation_alias_records_a_vote_without_cancelling_below_threshold() {
        let env = Env::default();
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let (client, admin1, _admin2, _admin3) = governance_setup(&env);
        let recipient = Address::generate(&env);
        let id = client.initiate_withdrawal(&recipient, &ABOVE_THRESHOLD);

        assert_eq!(client.cancel_operation(&id, &admin1), 1);
        assert_eq!(client.get_request(&id).status, WithdrawalStatus::Pending);

        env.ledger()
            .with_mut(|li| li.timestamp = 1_000 + TIMELOCK_DURATION_SECONDS);
        client.execute_withdrawal(&id);
        assert_eq!(client.get_request(&id).status, WithdrawalStatus::Executed);
    }

    #[test]
    fn configure_governance_rejects_invalid_thresholds_and_duplicates() {
        let env = Env::default();
        let (client, admin, _token) = setup(&env);

        let empty = Vec::new(&env);
        assert_eq!(
            client.try_configure_governance(&empty, &1u32),
            Err(Ok(TimelockError::InvalidGovernanceConfig))
        );

        let mut one_admin = Vec::new(&env);
        one_admin.push_back(admin.clone());
        assert_eq!(
            client.try_configure_governance(&one_admin, &2u32),
            Err(Ok(TimelockError::InvalidGovernanceConfig))
        );

        let mut duplicate = Vec::new(&env);
        duplicate.push_back(admin.clone());
        duplicate.push_back(admin);
        assert_eq!(
            client.try_configure_governance(&duplicate, &1u32),
            Err(Ok(TimelockError::InvalidGovernanceConfig))
        );
    }

    #[test]
    fn configure_governance_requires_admin_auth() {
        let env = Env::default();
        let (client, admin, _token) = setup(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin);

        env.set_auths(&[]);
        assert!(client.try_configure_governance(&admins, &1u32).is_err());
    }
}
