#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env};

// ── Error types ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum FaucetError {
    /// Contract is already initialized.
    AlreadyInitialized = 1,
    /// Contract is not initialized yet.
    NotInitialized = 2,
    /// Unauthorized caller.
    Unauthorized = 3,
    /// Requested amount must be greater than zero.
    InvalidAmount = 4,
    /// Requested amount exceeds the configured maximum claim limit.
    ExceedsMaxAmount = 5,
    /// 24-hour cooldown period is currently active for this recipient and token.
    CooldownActive = 6,
    /// Token is not supported or allowed by the faucet.
    UnsupportedToken = 7,
    /// Insufficient token balance in the faucet.
    InsufficientBalance = 8,
}

// ── Storage Keys & Types ─────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Faucet admin address.
    Admin,
    /// Maximum claim amount allowed per request (e.g., 10,000 tokens).
    MaxAmount,
    /// Cooldown period in seconds (e.g., 86,400 = 24 hours).
    Cooldown,
    /// Flag indicating whether a token address is allowed for faucet dispensing.
    AllowedToken(Address),
    /// Timestamp of the last claim per recipient and token.
    LastClaim(Address, Address),
}

/// Default 24 hours in seconds: 24 * 60 * 60 = 86,400.
pub const DEFAULT_COOLDOWN_SECONDS: u64 = 86_400;

/// Default maximum claim amount: 10,000 units (with 7 decimals = 100,000,000,000 stroops).
pub const DEFAULT_MAX_CLAIM_AMOUNT: i128 = 100_000_000_000;

const INSTANCE_BUMP_AMOUNT: u32 = 10_000;
const INSTANCE_LIFETIME_THRESHOLD: u32 = 1_000;
const PERSISTENT_BUMP_AMOUNT: u32 = 100_000;
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 10_000;

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct FaucetContract;

#[contractimpl]
impl FaucetContract {
    /// Initialize the faucet contract.
    ///
    /// # Arguments
    /// * `admin` - Admin address authorized to manage faucet configuration
    /// * `max_claim_amount` - Maximum claim amount permitted per request
    /// * `cooldown_period` - Cooldown period in seconds (default 86,400 = 24 hours)
    pub fn initialize(
        env: Env,
        admin: Address,
        max_claim_amount: Option<i128>,
        cooldown_period: Option<u64>,
    ) -> Result<(), FaucetError> {
        admin.require_auth();

        if env.storage().instance().has(&DataKey::Admin) {
            return Err(FaucetError::AlreadyInitialized);
        }

        let max_amount = max_claim_amount.unwrap_or(DEFAULT_MAX_CLAIM_AMOUNT);
        if max_amount <= 0 {
            return Err(FaucetError::InvalidAmount);
        }

        let cooldown = cooldown_period.unwrap_or(DEFAULT_COOLDOWN_SECONDS);

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::MaxAmount, &max_amount);
        env.storage().instance().set(&DataKey::Cooldown, &cooldown);

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        Ok(())
    }

    /// Set whether a token is allowed in the faucet.
    ///
    /// # Arguments
    /// * `token` - Token contract address
    /// * `allowed` - Boolean status
    pub fn set_token_allowed(env: Env, token: Address, allowed: bool) -> Result<(), FaucetError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(FaucetError::NotInitialized)?;

        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::AllowedToken(token), &allowed);

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        Ok(())
    }

    /// Update the maximum claim amount per request.
    pub fn set_max_claim_amount(env: Env, max_amount: i128) -> Result<(), FaucetError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(FaucetError::NotInitialized)?;

        admin.require_auth();

        if max_amount <= 0 {
            return Err(FaucetError::InvalidAmount);
        }

        env.storage()
            .instance()
            .set(&DataKey::MaxAmount, &max_amount);

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        Ok(())
    }

    /// Update the cooldown period duration in seconds.
    pub fn set_cooldown_period(env: Env, cooldown: u64) -> Result<(), FaucetError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(FaucetError::NotInitialized)?;

        admin.require_auth();

        env.storage().instance().set(&DataKey::Cooldown, &cooldown);

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        Ok(())
    }

    /// Claim tokens from the faucet subject to rate limits.
    ///
    /// # Arguments
    /// * `recipient` - Beneficiary address receiving test tokens
    /// * `token` - Token contract address
    /// * `amount` - Amount of tokens to claim (up to max_claim_amount)
    pub fn claim(
        env: Env,
        recipient: Address,
        token: Address,
        amount: i128,
    ) -> Result<(), FaucetError> {
        recipient.require_auth();

        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(FaucetError::NotInitialized);
        }

        if amount <= 0 {
            return Err(FaucetError::InvalidAmount);
        }

        let max_amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MaxAmount)
            .unwrap_or(DEFAULT_MAX_CLAIM_AMOUNT);

        if amount > max_amount {
            return Err(FaucetError::ExceedsMaxAmount);
        }

        // Check token whitelist if explicit entry exists
        if env
            .storage()
            .instance()
            .has(&DataKey::AllowedToken(token.clone()))
        {
            let is_allowed: bool = env
                .storage()
                .instance()
                .get(&DataKey::AllowedToken(token.clone()))
                .unwrap_or(false);
            if !is_allowed {
                return Err(FaucetError::UnsupportedToken);
            }
        }

        let cooldown: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Cooldown)
            .unwrap_or(DEFAULT_COOLDOWN_SECONDS);

        let now = env.ledger().timestamp();
        let claim_key = DataKey::LastClaim(recipient.clone(), token.clone());

        if let Some(last_claim_time) = env.storage().persistent().get::<DataKey, u64>(&claim_key) {
            if now < last_claim_time + cooldown {
                return Err(FaucetError::CooldownActive);
            }
        }

        // Check faucet contract balance
        let token_client = token::Client::new(&env, &token);
        let current_contract = env.current_contract_address();
        let balance = token_client.balance(&current_contract);

        if balance < amount {
            return Err(FaucetError::InsufficientBalance);
        }

        // Record claim timestamp in persistent storage
        env.storage().persistent().set(&claim_key, &now);
        env.storage().persistent().extend_ttl(
            &claim_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        // Transfer tokens to recipient
        token_client.transfer(&current_contract, &recipient, &amount);

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        Ok(())
    }

    /// Get the timestamp of the last claim for a given recipient and token.
    pub fn get_last_claim(env: Env, recipient: Address, token: Address) -> Option<u64> {
        let claim_key = DataKey::LastClaim(recipient, token);
        let last_claim = env.storage().persistent().get(&claim_key);
        if last_claim.is_some() {
            env.storage().persistent().extend_ttl(
                &claim_key,
                PERSISTENT_LIFETIME_THRESHOLD,
                PERSISTENT_BUMP_AMOUNT,
            );
        }
        last_claim
    }

    /// Check whether a user is currently eligible to claim tokens.
    pub fn can_claim(env: Env, recipient: Address, token: Address) -> bool {
        let cooldown: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Cooldown)
            .unwrap_or(DEFAULT_COOLDOWN_SECONDS);

        let now = env.ledger().timestamp();
        let claim_key = DataKey::LastClaim(recipient, token);

        match env.storage().persistent().get::<DataKey, u64>(&claim_key) {
            Some(last_claim_time) => now >= last_claim_time + cooldown,
            None => true,
        }
    }

    /// Get the configured cooldown period in seconds.
    pub fn get_cooldown_period(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::Cooldown)
            .unwrap_or(DEFAULT_COOLDOWN_SECONDS)
    }

    /// Get the maximum allowed claim amount.
    pub fn get_max_claim_amount(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::MaxAmount)
            .unwrap_or(DEFAULT_MAX_CLAIM_AMOUNT)
    }

    /// Check if a token is explicitly configured and allowed.
    pub fn is_token_allowed(env: Env, token: Address) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::AllowedToken(token))
            .unwrap_or(true)
    }

    /// Admin withdraw tokens from faucet balance.
    pub fn withdraw(
        env: Env,
        token: Address,
        destination: Address,
        amount: i128,
    ) -> Result<(), FaucetError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(FaucetError::NotInitialized)?;

        admin.require_auth();

        if amount <= 0 {
            return Err(FaucetError::InvalidAmount);
        }

        let token_client = token::Client::new(&env, &token);
        let balance = token_client.balance(&env.current_contract_address());

        if balance < amount {
            return Err(FaucetError::InsufficientBalance);
        }

        token_client.transfer(&env.current_contract_address(), &destination, &amount);

        Ok(())
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::StellarAssetClient,
        Address, Env,
    };

    const INITIAL_FAUCET_BALANCE: i128 = 10_000_000_000_000; // 100,000 tokens
    const CLAIM_AMOUNT: i128 = 100_000_000_000; // 10,000 tokens

    fn setup() -> (
        Env,
        Address,
        Address,
        Address,
        FaucetContractClient<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin);
        let token_addr = token_id.address();

        let contract_id = env.register(FaucetContract, ());
        let client = FaucetContractClient::new(&env, &contract_id);

        // Fund faucet contract
        StellarAssetClient::new(&env, &token_addr).mint(&client.address, &INITIAL_FAUCET_BALANCE);

        (env, admin, user, token_addr, client)
    }

    #[test]
    fn test_initialize() {
        let (_env, admin, _user, _token, client) = setup();

        client.initialize(&admin, &Some(CLAIM_AMOUNT), &Some(86_400));

        assert_eq!(client.get_max_claim_amount(), CLAIM_AMOUNT);
        assert_eq!(client.get_cooldown_period(), 86_400);

        // Re-initialization fails
        let res = client.try_initialize(&admin, &Some(CLAIM_AMOUNT), &Some(86_400));
        assert_eq!(res.unwrap_err().unwrap(), FaucetError::AlreadyInitialized);
    }

    #[test]
    fn test_successful_claim() {
        let (env, admin, user, token, client) = setup();

        client.initialize(&admin, &Some(CLAIM_AMOUNT), &Some(86_400));

        assert!(client.can_claim(&user, &token));
        client.claim(&user, &token, &CLAIM_AMOUNT);

        let token_client = token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&user), CLAIM_AMOUNT);
        assert_eq!(
            token_client.balance(&client.address),
            INITIAL_FAUCET_BALANCE - CLAIM_AMOUNT
        );

        assert_eq!(
            client.get_last_claim(&user, &token),
            Some(env.ledger().timestamp())
        );
        assert!(!client.can_claim(&user, &token));
    }

    #[test]
    fn test_cooldown_enforcement_24_hours() {
        let (env, admin, user, token, client) = setup();

        client.initialize(&admin, &Some(CLAIM_AMOUNT), &Some(86_400));

        // Initial claim
        client.claim(&user, &token, &CLAIM_AMOUNT);

        // Immediate subsequent claim must fail with CooldownActive
        let err = client.try_claim(&user, &token, &CLAIM_AMOUNT);
        assert_eq!(err.unwrap_err().unwrap(), FaucetError::CooldownActive);

        // Advance ledger timestamp by 23 hours 59 minutes (86,340 seconds)
        env.ledger().with_mut(|li| {
            li.timestamp += 86_340;
        });

        assert!(!client.can_claim(&user, &token));
        let err2 = client.try_claim(&user, &token, &CLAIM_AMOUNT);
        assert_eq!(err2.unwrap_err().unwrap(), FaucetError::CooldownActive);

        // Advance past 24 hours (total +86,401 seconds)
        env.ledger().with_mut(|li| {
            li.timestamp += 61;
        });

        assert!(client.can_claim(&user, &token));
        // Claim succeeds after cooldown expires
        client.claim(&user, &token, &CLAIM_AMOUNT);

        let token_client = token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&user), CLAIM_AMOUNT * 2);
    }

    #[test]
    fn test_exceeds_max_claim_amount() {
        let (_env, admin, user, token, client) = setup();

        client.initialize(&admin, &Some(CLAIM_AMOUNT), &Some(86_400));

        // Claiming more than max allowed fails
        let err = client.try_claim(&user, &token, &(CLAIM_AMOUNT + 1));
        assert_eq!(err.unwrap_err().unwrap(), FaucetError::ExceedsMaxAmount);
    }

    #[test]
    fn test_invalid_amounts() {
        let (_env, admin, user, token, client) = setup();

        client.initialize(&admin, &Some(CLAIM_AMOUNT), &Some(86_400));

        let err_zero = client.try_claim(&user, &token, &0);
        assert_eq!(err_zero.unwrap_err().unwrap(), FaucetError::InvalidAmount);

        let err_neg = client.try_claim(&user, &token, &-1000);
        assert_eq!(err_neg.unwrap_err().unwrap(), FaucetError::InvalidAmount);
    }

    #[test]
    fn test_token_whitelist_control() {
        let (env, admin, user, token, client) = setup();

        client.initialize(&admin, &Some(CLAIM_AMOUNT), &Some(86_400));

        // Disable token
        client.set_token_allowed(&token, &false);
        assert!(!client.is_token_allowed(&token));

        let err = client.try_claim(&user, &token, &CLAIM_AMOUNT);
        assert_eq!(err.unwrap_err().unwrap(), FaucetError::UnsupportedToken);

        // Re-enable token
        client.set_token_allowed(&token, &true);
        assert!(client.is_token_allowed(&token));

        client.claim(&user, &token, &CLAIM_AMOUNT);
        let token_client = token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&user), CLAIM_AMOUNT);
    }

    #[test]
    fn test_multi_token_independent_cooldowns() {
        let (env, admin, user, token1, client) = setup();

        // Create second token (e.g. XAF and KES)
        let token_admin2 = Address::generate(&env);
        let token_id2 = env.register_stellar_asset_contract_v2(token_admin2);
        let token2 = token_id2.address();
        StellarAssetClient::new(&env, &token2).mint(&client.address, &INITIAL_FAUCET_BALANCE);

        client.initialize(&admin, &Some(CLAIM_AMOUNT), &Some(86_400));

        // Claim token 1
        client.claim(&user, &token1, &CLAIM_AMOUNT);

        // Claim token 2 should succeed immediately since cooldowns are per-token
        client.claim(&user, &token2, &CLAIM_AMOUNT);

        let token1_client = token::Client::new(&env, &token1);
        let token2_client = token::Client::new(&env, &token2);

        assert_eq!(token1_client.balance(&user), CLAIM_AMOUNT);
        assert_eq!(token2_client.balance(&user), CLAIM_AMOUNT);
    }

    #[test]
    fn test_admin_configuration_updates_and_withdraw() {
        let (env, admin, _user, token, client) = setup();

        client.initialize(&admin, &Some(CLAIM_AMOUNT), &Some(86_400));

        // Admin updates config
        let new_max = 50_000_000_000;
        let new_cooldown = 43_200; // 12 hours

        client.set_max_claim_amount(&new_max);
        client.set_cooldown_period(&new_cooldown);

        assert_eq!(client.get_max_claim_amount(), new_max);
        assert_eq!(client.get_cooldown_period(), new_cooldown);

        // Admin withdraws tokens
        let destination = Address::generate(&env);
        client.withdraw(&token, &destination, &1_000_000_000);

        let token_client = token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&destination), 1_000_000_000);
    }
}
