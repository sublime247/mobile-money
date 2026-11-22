#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env};

// ── Error types ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum VaultError {
    /// Contract is already initialised.
    AlreadyInitialised = 1,
    /// Contract has not been initialised yet.
    NotInitialised = 2,
    /// Insufficient balance to sweep.
    InsufficientBalance = 3,
    /// Invalid amount (must be positive).
    InvalidAmount = 4,
}

// ── State ────────────────────────────────────────────────────────────────────

/// Vault state.
#[contracttype]
#[derive(Clone)]
pub struct VaultState {
    /// Admin address that can manage and sweep the vault.
    pub admin: Address,
    /// Token address for the vault.
    pub token: Address,
}

const STATE: &str = "STATE";

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct VaultContract;

#[contractimpl]
impl VaultContract {
    /// Initialise the vault contract.
    ///
    /// # Arguments
    /// * `admin` - Admin address that can sweep the vault
    /// * `token` - Token address stored in the vault
    pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), VaultError> {
        admin.require_auth();

        if env.storage().instance().has(&STATE) {
            return Err(VaultError::AlreadyInitialised);
        }

        env.storage()
            .instance()
            .set(&STATE, &VaultState { admin, token });

        env.storage().instance().extend_ttl(1000, 10000);
        Ok(())
    }

    /// Sweep administration balances to a destination address.
    ///
    /// # Arguments
    /// * `amount` - Amount to sweep
    /// * `destination` - Destination address to receive the swept balances
    pub fn sweep(env: Env, amount: i128, destination: Address) -> Result<(), VaultError> {
        let state: VaultState = env
            .storage()
            .instance()
            .get(&STATE)
            .ok_or(VaultError::NotInitialised)?;

        state.admin.require_auth();

        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }

        let token_client = token::Client::new(&env, &state.token);
        let current_balance = token_client.balance(&env.current_contract_address());

        if amount > current_balance {
            return Err(VaultError::InsufficientBalance);
        }

        token_client.transfer(&env.current_contract_address(), &destination, &amount);

        env.storage().instance().extend_ttl(1000, 10000);
        Ok(())
    }

    /// Retrieve the current state of the vault.
    pub fn get_state(env: Env) -> Result<VaultState, VaultError> {
        let state = env
            .storage()
            .instance()
            .get(&STATE)
            .ok_or(VaultError::NotInitialised)?;
        env.storage().instance().extend_ttl(1000, 10000);
        Ok(state)
    }

    /// Retrieve the current token balance of the vault.
    pub fn get_balance(env: Env) -> Result<i128, VaultError> {
        let state: VaultState = env
            .storage()
            .instance()
            .get(&STATE)
            .ok_or(VaultError::NotInitialised)?;

        let token_client = token::Client::new(&env, &state.token);
        let balance = token_client.balance(&env.current_contract_address());

        env.storage().instance().extend_ttl(1000, 10000);
        Ok(balance)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env};

    const MINT_AMOUNT: i128 = 10_000_000;

    fn setup() -> (Env, Address, Address, Address, VaultContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        // Deploy a test token
        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin);

        let contract_id = env.register(VaultContract, ());
        let client = VaultContractClient::new(&env, &contract_id);

        (env, admin, user, token_id.address(), client)
    }

    #[test]
    fn test_initialize() {
        let (_env, admin, _user, token, client) = setup();

        client.initialize(&admin, &token);

        let state = client.get_state();
        assert_eq!(state.token, token);
        assert_eq!(state.admin, admin);

        let balance = client.get_balance();
        assert_eq!(balance, 0);
    }

    #[test]
    fn test_sweep() {
        let (env, admin, user, token, client) = setup();

        client.initialize(&admin, &token);

        // Mint tokens to the vault contract directly to simulate accumulated balances
        StellarAssetClient::new(&env, &token).mint(&client.address, &MINT_AMOUNT);

        assert_eq!(client.get_balance(), MINT_AMOUNT);

        // Sweep half the amount
        let sweep_amount = 5_000_000;
        client.sweep(&sweep_amount, &user);

        assert_eq!(client.get_balance(), 5_000_000);

        let token_client = token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&user), 5_000_000);
    }

    #[test]
    fn test_sweep_insufficient_balance() {
        let (env, admin, user, token, client) = setup();

        client.initialize(&admin, &token);

        StellarAssetClient::new(&env, &token).mint(&client.address, &1_000_000);

        // Try to sweep more than available
        let result = client.try_sweep(&2_000_000, &user);
        assert!(result.is_err());
    }

    #[test]
    fn test_sweep_invalid_amount() {
        let (env, admin, user, token, client) = setup();

        client.initialize(&admin, &token);

        StellarAssetClient::new(&env, &token).mint(&client.address, &1_000_000);

        // Try to sweep 0 or negative
        let result = client.try_sweep(&0, &user);
        assert!(result.is_err());

        let result_neg = client.try_sweep(&-100, &user);
        assert!(result_neg.is_err());
    }
}
