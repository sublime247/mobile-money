#![no_std]

//! On-chain blacklist registry.
//!
//! The admin flags wallet addresses (with a reason) in persistent storage.
//! Other contracts (bridge, vault, escrow, ...) query `is_blacklisted` or
//! `ensure_not_blacklisted` before fulfilling a deposit or a fiat off-ramp
//! withdrawal, so a flagged wallet can neither send nor receive funds.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, String,
};

// ── TTL policy ───────────────────────────────────────────────────────────────

/// ~30 days at 5s ledgers.
const TTL_THRESHOLD: u32 = 518_400;
/// ~60 days at 5s ledgers.
const TTL_EXTEND_TO: u32 = 1_036_800;

// ── Error types ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum BlacklistError {
    /// Contract is already initialised.
    AlreadyInitialised = 1,
    /// Contract has not been initialised yet.
    NotInitialised = 2,
    /// Address is already on the blacklist.
    AlreadyBlacklisted = 3,
    /// Address is not on the blacklist.
    NotBlacklisted = 4,
    /// Address is blacklisted and may not transact.
    Blacklisted = 5,
    /// A non-empty reason is required when blacklisting.
    EmptyReason = 6,
}

// ── Storage ──────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin address (instance storage).
    Admin,
    /// Blacklist entry for an address (persistent storage).
    Entry(Address),
}

/// Record stored for every blacklisted address.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlacklistEntry {
    /// Why the address was flagged (e.g. "sanctions", "fraud report #123").
    pub reason: String,
    /// Ledger timestamp at which the address was flagged.
    pub added_at: u64,
}

// ── Events ───────────────────────────────────────────────────────────────────

/// Emitted when an address is added to the blacklist.
#[contractevent(topics = ["blacklist", "added"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AddressBlacklisted {
    #[topic]
    pub address: Address,
    pub reason: String,
}

/// Emitted when an address is removed from the blacklist.
#[contractevent(topics = ["blacklist", "removed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AddressUnblacklisted {
    #[topic]
    pub address: Address,
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct BlacklistContract;

#[contractimpl]
impl BlacklistContract {
    /// Initialise the registry with the admin allowed to manage it.
    pub fn initialize(env: Env, admin: Address) -> Result<(), BlacklistError> {
        admin.require_auth();

        if env.storage().instance().has(&DataKey::Admin) {
            return Err(BlacklistError::AlreadyInitialised);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }

    /// Flag `address` so it can no longer deposit or receive off-ramps.
    ///
    /// Emits `["blacklist", "added", address]` with the reason as data.
    pub fn add(env: Env, address: Address, reason: String) -> Result<(), BlacklistError> {
        Self::require_admin(&env)?;

        if reason.is_empty() {
            return Err(BlacklistError::EmptyReason);
        }

        let key = DataKey::Entry(address.clone());
        if env.storage().persistent().has(&key) {
            return Err(BlacklistError::AlreadyBlacklisted);
        }

        let entry = BlacklistEntry {
            reason: reason.clone(),
            added_at: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&key, &entry);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);

        AddressBlacklisted { address, reason }.publish(&env);
        Ok(())
    }

    /// Remove `address` from the blacklist.
    pub fn remove(env: Env, address: Address) -> Result<(), BlacklistError> {
        Self::require_admin(&env)?;

        let key = DataKey::Entry(address.clone());
        if !env.storage().persistent().has(&key) {
            return Err(BlacklistError::NotBlacklisted);
        }

        env.storage().persistent().remove(&key);

        AddressUnblacklisted { address }.publish(&env);
        Ok(())
    }

    /// Returns `true` when `address` is blacklisted.
    pub fn is_blacklisted(env: Env, address: Address) -> bool {
        let key = DataKey::Entry(address);
        let listed = env.storage().persistent().has(&key);
        if listed {
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        }
        listed
    }

    /// Fails with `Blacklisted` when `address` is blacklisted.
    ///
    /// Intended for cross-contract guards: a caller invoking this through the
    /// generated client aborts its own transaction when the address is flagged.
    pub fn ensure_not_blacklisted(env: Env, address: Address) -> Result<(), BlacklistError> {
        if Self::is_blacklisted(env, address) {
            return Err(BlacklistError::Blacklisted);
        }
        Ok(())
    }

    /// Returns the blacklist record for `address`, if any.
    pub fn get_entry(env: Env, address: Address) -> Option<BlacklistEntry> {
        env.storage().persistent().get(&DataKey::Entry(address))
    }

    /// Returns the admin address.
    pub fn get_admin(env: Env) -> Result<Address, BlacklistError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(BlacklistError::NotInitialised)
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    fn require_admin(env: &Env) -> Result<Address, BlacklistError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(BlacklistError::NotInitialised)?;
        admin.require_auth();
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(admin)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _, Ledger as _},
        token::{self, StellarAssetClient},
        Event,
    };

    /// Minimal token-moving contract that consults the registry before every
    /// deposit and withdrawal, mirroring how production contracts integrate.
    #[contract]
    pub struct GuardedVault;

    #[contracttype]
    enum VaultKey {
        Registry,
        Token,
    }

    #[contractimpl]
    impl GuardedVault {
        pub fn init(env: Env, registry: Address, token: Address) {
            env.storage().instance().set(&VaultKey::Registry, &registry);
            env.storage().instance().set(&VaultKey::Token, &token);
        }

        pub fn deposit(env: Env, from: Address, amount: i128) {
            from.require_auth();
            Self::guard(&env, &from);
            Self::token(&env).transfer(&from, env.current_contract_address(), &amount);
        }

        pub fn withdraw(env: Env, to: Address, amount: i128) {
            Self::guard(&env, &to);
            Self::token(&env).transfer(&env.current_contract_address(), &to, &amount);
        }

        fn guard(env: &Env, address: &Address) {
            let registry: Address = env.storage().instance().get(&VaultKey::Registry).unwrap();
            BlacklistContractClient::new(env, &registry).ensure_not_blacklisted(address);
        }

        fn token(env: &Env) -> token::Client<'_> {
            let token: Address = env.storage().instance().get(&VaultKey::Token).unwrap();
            token::Client::new(env, &token)
        }
    }

    struct Setup {
        env: Env,
        admin: Address,
        client: BlacklistContractClient<'static>,
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let contract_id = env.register(BlacklistContract, ());
        let client = BlacklistContractClient::new(&env, &contract_id);
        client.initialize(&admin);

        Setup { env, admin, client }
    }

    fn reason(env: &Env, text: &str) -> String {
        String::from_str(env, text)
    }

    #[test]
    fn test_initialize_sets_admin() {
        let s = setup();
        assert_eq!(s.client.get_admin(), s.admin);
    }

    #[test]
    fn test_initialize_twice_fails() {
        let s = setup();
        let result = s.client.try_initialize(&s.admin);
        assert_eq!(result, Err(Ok(BlacklistError::AlreadyInitialised)));
    }

    #[test]
    fn test_add_and_remove() {
        let s = setup();
        let wallet = Address::generate(&s.env);
        s.env.ledger().set_timestamp(1_700_000_000);

        assert!(!s.client.is_blacklisted(&wallet));

        s.client.add(&wallet, &reason(&s.env, "sanctions"));
        assert!(s.client.is_blacklisted(&wallet));
        assert_eq!(
            s.client.get_entry(&wallet),
            Some(BlacklistEntry {
                reason: reason(&s.env, "sanctions"),
                added_at: 1_700_000_000,
            })
        );

        s.client.remove(&wallet);
        assert!(!s.client.is_blacklisted(&wallet));
        assert_eq!(s.client.get_entry(&wallet), None);
    }

    #[test]
    fn test_add_emits_event_with_address_and_reason() {
        let s = setup();
        let wallet = Address::generate(&s.env);

        s.client.add(&wallet, &reason(&s.env, "fraud report #42"));

        let expected = AddressBlacklisted {
            address: wallet.clone(),
            reason: reason(&s.env, "fraud report #42"),
        };
        assert_eq!(
            s.env.events().all(),
            [expected.to_xdr(&s.env, &s.client.address)]
        );
    }

    #[test]
    fn test_remove_emits_event() {
        let s = setup();
        let wallet = Address::generate(&s.env);
        s.client.add(&wallet, &reason(&s.env, "sanctions"));

        s.client.remove(&wallet);

        let expected = AddressUnblacklisted {
            address: wallet.clone(),
        };
        assert_eq!(
            s.env.events().all(),
            [expected.to_xdr(&s.env, &s.client.address)]
        );
    }

    #[test]
    fn test_add_duplicate_fails() {
        let s = setup();
        let wallet = Address::generate(&s.env);
        s.client.add(&wallet, &reason(&s.env, "sanctions"));

        let result = s.client.try_add(&wallet, &reason(&s.env, "again"));
        assert_eq!(result, Err(Ok(BlacklistError::AlreadyBlacklisted)));
    }

    #[test]
    fn test_add_empty_reason_fails() {
        let s = setup();
        let wallet = Address::generate(&s.env);

        let result = s.client.try_add(&wallet, &reason(&s.env, ""));
        assert_eq!(result, Err(Ok(BlacklistError::EmptyReason)));
    }

    #[test]
    fn test_remove_unknown_fails() {
        let s = setup();
        let wallet = Address::generate(&s.env);

        let result = s.client.try_remove(&wallet);
        assert_eq!(result, Err(Ok(BlacklistError::NotBlacklisted)));
    }

    #[test]
    fn test_add_before_initialize_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(BlacklistContract, ());
        let client = BlacklistContractClient::new(&env, &contract_id);
        let wallet = Address::generate(&env);

        let result = client.try_add(&wallet, &reason(&env, "sanctions"));
        assert_eq!(result, Err(Ok(BlacklistError::NotInitialised)));
    }

    #[test]
    #[should_panic]
    fn test_add_requires_admin_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let contract_id = env.register(BlacklistContract, ());
        let client = BlacklistContractClient::new(&env, &contract_id);

        env.mock_all_auths();
        client.initialize(&admin);
        env.set_auths(&[]);

        client.add(&Address::generate(&env), &reason(&env, "sanctions"));
    }

    #[test]
    fn test_ensure_not_blacklisted() {
        let s = setup();
        let wallet = Address::generate(&s.env);

        assert_eq!(s.client.try_ensure_not_blacklisted(&wallet), Ok(Ok(())));

        s.client.add(&wallet, &reason(&s.env, "sanctions"));
        assert_eq!(
            s.client.try_ensure_not_blacklisted(&wallet),
            Err(Ok(BlacklistError::Blacklisted))
        );
    }

    fn setup_vault(s: &Setup) -> (GuardedVaultClient<'static>, token::Client<'static>) {
        let token_admin = Address::generate(&s.env);
        let token_id = s
            .env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        let vault_id = s.env.register(GuardedVault, ());
        let vault = GuardedVaultClient::new(&s.env, &vault_id);
        vault.init(&s.client.address, &token_id);

        StellarAssetClient::new(&s.env, &token_id).mint(&vault_id, &1_000);
        (vault, token::Client::new(&s.env, &token_id))
    }

    #[test]
    fn test_blacklisted_deposit_is_rejected() {
        let s = setup();
        let (vault, token) = setup_vault(&s);
        let wallet = Address::generate(&s.env);
        StellarAssetClient::new(&s.env, &token.address).mint(&wallet, &500);

        s.client.add(&wallet, &reason(&s.env, "sanctions"));

        assert!(vault.try_deposit(&wallet, &100).is_err());
        assert_eq!(token.balance(&wallet), 500);
        assert_eq!(token.balance(&vault.address), 1_000);
    }

    #[test]
    fn test_blacklisted_withdrawal_is_rejected() {
        let s = setup();
        let (vault, token) = setup_vault(&s);
        let wallet = Address::generate(&s.env);

        s.client.add(&wallet, &reason(&s.env, "sanctions"));

        assert!(vault.try_withdraw(&wallet, &100).is_err());
        assert_eq!(token.balance(&wallet), 0);
        assert_eq!(token.balance(&vault.address), 1_000);
    }

    #[test]
    fn test_transfers_allowed_after_removal() {
        let s = setup();
        let (vault, token) = setup_vault(&s);
        let wallet = Address::generate(&s.env);
        StellarAssetClient::new(&s.env, &token.address).mint(&wallet, &500);

        s.client.add(&wallet, &reason(&s.env, "sanctions"));
        s.client.remove(&wallet);

        vault.deposit(&wallet, &100);
        vault.withdraw(&wallet, &50);
        assert_eq!(token.balance(&wallet), 450);
        assert_eq!(token.balance(&vault.address), 1_050);
    }
}
