#![no_std]

//! Anchor escrow vault with an M-of-N multi-signature emergency pause.
//!
//! Users deposit the anchor's settlement token into the vault and withdraw
//! their own balance. If an anomaly or telecom exploit is detected, a quorum of
//! `threshold` admins (out of the `admins` set) can call [`AnchorVault::pause`]
//! to freeze every deposit and withdrawal; the same quorum is required to
//! [`AnchorVault::unpause`].
//!
//! Pause state machine:
//!
//! ```text
//!            pause (M-of-N)
//!   ACTIVE ─────────────────▶ PAUSED
//!     ▲                         │
//!     └──────── unpause ────────┘
//!               (M-of-N)
//! ```
//!
//! `deposit` and `withdraw` call [`assert_not_paused`] before touching any
//! state, so a paused vault rejects them with [`VaultError::ContractPaused`].

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env, Vec,
};

#[cfg(test)]
mod test;

// ── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VaultError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    /// Deposits and withdrawals are frozen by an emergency pause.
    ContractPaused = 3,
    /// `pause` called while the vault is already paused.
    AlreadyPaused = 4,
    /// `unpause` called while the vault is not paused.
    NotPaused = 5,
    /// Fewer distinct admin signers than the configured threshold.
    ThresholdNotMet = 6,
    /// A signer is not a member of the admin set.
    NotAdmin = 7,
    /// The same admin appears more than once in the signer list.
    DuplicateSigner = 8,
    /// Threshold must be between 1 and the number of admins.
    InvalidThreshold = 9,
    InvalidAmount = 10,
    InsufficientBalance = 11,
    /// The operator must be one of the signers.
    OperatorNotSigner = 12,
}

// ── Storage ──────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultConfig {
    pub admins: Vec<Address>,
    pub threshold: u32,
    pub token: Address,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Config,
    Paused,
    Balance(Address),
}

const INSTANCE_BUMP_THRESHOLD: u32 = 17_280; // ~1 day
const INSTANCE_BUMP_AMOUNT: u32 = 518_400; // ~30 days

// ── Events ───────────────────────────────────────────────────────────────────

/// Emitted when a quorum of admins freezes the vault.
#[contractevent(topics = ["ContractPaused"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractPaused {
    #[topic]
    pub operator: Address,
    pub timestamp: u64,
    pub signers: Vec<Address>,
}

/// Emitted when a quorum of admins lifts the emergency pause.
#[contractevent(topics = ["ContractUnpaused"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractUnpaused {
    #[topic]
    pub operator: Address,
    pub timestamp: u64,
    pub signers: Vec<Address>,
}

#[contractevent(topics = ["Deposit"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposit {
    #[topic]
    pub from: Address,
    pub amount: i128,
}

#[contractevent(topics = ["Withdraw"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdraw {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

// ── Internal helpers ─────────────────────────────────────────────────────────

fn bump(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn load_config(env: &Env) -> Result<VaultConfig, VaultError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(VaultError::NotInitialized)
}

fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

/// Guard for every value-moving entry point.
pub fn assert_not_paused(env: &Env) -> Result<(), VaultError> {
    if is_paused(env) {
        return Err(VaultError::ContractPaused);
    }
    Ok(())
}

/// Validate an M-of-N admin quorum and require every signer's authorization.
///
/// * every signer must be a configured admin,
/// * no admin may be counted twice,
/// * at least `threshold` distinct admins must sign,
/// * `operator` (the address recorded in the event) must be one of them.
fn require_quorum(
    env: &Env,
    config: &VaultConfig,
    operator: &Address,
    signers: &Vec<Address>,
) -> Result<(), VaultError> {
    let mut seen: Vec<Address> = Vec::new(env);
    for signer in signers.iter() {
        if !config.admins.contains(&signer) {
            return Err(VaultError::NotAdmin);
        }
        if seen.contains(&signer) {
            return Err(VaultError::DuplicateSigner);
        }
        seen.push_back(signer);
    }

    if seen.len() < config.threshold {
        return Err(VaultError::ThresholdNotMet);
    }
    if !seen.contains(operator) {
        return Err(VaultError::OperatorNotSigner);
    }

    // Validation passed: each admin in the quorum must have signed this call.
    for signer in seen.iter() {
        signer.require_auth();
    }
    Ok(())
}

fn balance_of(env: &Env, user: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Balance(user.clone()))
        .unwrap_or(0)
}

fn set_balance(env: &Env, user: &Address, amount: i128) {
    let key = DataKey::Balance(user.clone());
    if amount == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &amount);
    }
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct AnchorVault;

#[contractimpl]
impl AnchorVault {
    /// One-time setup of the admin set, quorum threshold and escrowed token.
    pub fn initialize(
        env: Env,
        admins: Vec<Address>,
        threshold: u32,
        token: Address,
    ) -> Result<(), VaultError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(VaultError::AlreadyInitialized);
        }
        if threshold == 0 || threshold > admins.len() {
            return Err(VaultError::InvalidThreshold);
        }
        let mut unique: Vec<Address> = Vec::new(&env);
        for admin in admins.iter() {
            if unique.contains(&admin) {
                return Err(VaultError::DuplicateSigner);
            }
            unique.push_back(admin);
        }

        env.storage().instance().set(
            &DataKey::Config,
            &VaultConfig {
                admins: unique,
                threshold,
                token,
            },
        );
        env.storage().instance().set(&DataKey::Paused, &false);
        bump(&env);
        Ok(())
    }

    /// Escrow `amount` of the vault token from `from`.
    pub fn deposit(env: Env, from: Address, amount: i128) -> Result<(), VaultError> {
        assert_not_paused(&env)?;
        let config = load_config(&env)?;
        from.require_auth();
        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }

        token::Client::new(&env, &config.token).transfer(
            &from,
            env.current_contract_address(),
            &amount,
        );
        set_balance(&env, &from, balance_of(&env, &from) + amount);
        bump(&env);

        Deposit { from, amount }.publish(&env);
        Ok(())
    }

    /// Release `amount` of `to`'s escrowed balance back to `to`.
    pub fn withdraw(env: Env, to: Address, amount: i128) -> Result<(), VaultError> {
        assert_not_paused(&env)?;
        let config = load_config(&env)?;
        to.require_auth();
        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }
        let balance = balance_of(&env, &to);
        if amount > balance {
            return Err(VaultError::InsufficientBalance);
        }

        // Effects before interaction.
        set_balance(&env, &to, balance - amount);
        token::Client::new(&env, &config.token).transfer(
            &env.current_contract_address(),
            &to,
            &amount,
        );
        bump(&env);

        Withdraw { to, amount }.publish(&env);
        Ok(())
    }

    /// Emergency freeze of deposits and withdrawals. Requires `threshold`
    /// distinct admin signatures; `operator` is recorded in the event.
    pub fn pause(env: Env, operator: Address, signers: Vec<Address>) -> Result<(), VaultError> {
        let config = load_config(&env)?;
        if is_paused(&env) {
            return Err(VaultError::AlreadyPaused);
        }
        require_quorum(&env, &config, &operator, &signers)?;

        env.storage().instance().set(&DataKey::Paused, &true);
        bump(&env);

        ContractPaused {
            operator,
            timestamp: env.ledger().timestamp(),
            signers,
        }
        .publish(&env);
        Ok(())
    }

    /// Lift the emergency pause. Requires the same M-of-N quorum as `pause`.
    pub fn unpause(env: Env, operator: Address, signers: Vec<Address>) -> Result<(), VaultError> {
        let config = load_config(&env)?;
        if !is_paused(&env) {
            return Err(VaultError::NotPaused);
        }
        require_quorum(&env, &config, &operator, &signers)?;

        env.storage().instance().set(&DataKey::Paused, &false);
        bump(&env);

        ContractUnpaused {
            operator,
            timestamp: env.ledger().timestamp(),
            signers,
        }
        .publish(&env);
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        is_paused(&env)
    }

    pub fn get_config(env: Env) -> Result<VaultConfig, VaultError> {
        load_config(&env)
    }

    pub fn balance(env: Env, user: Address) -> i128 {
        balance_of(&env, &user)
    }
}
