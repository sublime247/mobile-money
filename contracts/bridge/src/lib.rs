#![no_std]

//! Mobile-money ↔ Stellar bridge.
//!
//! Users deposit tokens to on-ramp; the operator (admin) settles fiat
//! off-ramps by paying tokens out minus the bridge fee. Both directions are
//! screened against the optional blacklist registry, and the fee is
//! discounted through the optional fee-tier contract.
//!
//! Admin ownership moves in two steps: the current admin proposes a new
//! admin, who can accept only after a 24-hour delay. The current admin can
//! revoke the proposal at any time before it is accepted.
//!
//! The settlement fee — the parameter most directly exposed to a malicious
//! or mistaken admin, since it is taken out of every off-ramp payout — goes
//! through the same propose-then-execute shape as admin transfer: the admin
//! proposes a new fee, and it only takes effect after [`FEE_TIMELOCK_DELAY`]
//! (24 hours), giving depositors time to react before it lands. The
//! blacklist / fee-tier registry addresses are lower-risk wiring (screening
//! and discount lookups, not fund movement) set once at deploy time, so they
//! stay immediate and admin-gated like before.
//!
//! An emergency circuit breaker lets the admin instantly `pause` deposits
//! and settlements — with no delay, unlike the timelocked parameter path —
//! in response to an upstream provider outage or a suspicious transaction
//! spike, and `unpause` once the issue is resolved.

#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, token,
    Address, Env,
};

// ── Constants ────────────────────────────────────────────────────────────────

/// Delay between proposing and accepting a new admin (24 hours).
pub const ADMIN_TRANSFER_DELAY: u64 = 24 * 60 * 60;
/// Delay between proposing and executing a new settlement fee (24 hours).
pub const FEE_TIMELOCK_DELAY: u64 = 24 * 60 * 60;
/// Basis-point denominator (100%).
pub const BPS_DENOMINATOR: i128 = 10_000;
/// Standard fee can never exceed 10%.
pub const MAX_FEE_BPS: u32 = 1_000;

const TTL_THRESHOLD: u32 = 518_400;
const TTL_EXTEND_TO: u32 = 1_036_800;

// ── External contract interfaces ─────────────────────────────────────────────

/// Subset of the blacklist registry used by the bridge.
#[contractclient(name = "BlacklistClient")]
pub trait BlacklistInterface {
    fn is_blacklisted(env: Env, address: Address) -> bool;
}

/// Subset of the fee-tier contract used by the bridge.
#[contractclient(name = "FeeTierClient")]
pub trait FeeTierInterface {
    fn discounted_fee(env: Env, user: Address, standard_fee: i128) -> i128;
}

// ── Error types ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum BridgeError {
    AlreadyInitialised = 1,
    NotInitialised = 2,
    InvalidAmount = 3,
    InvalidFee = 4,
    /// Address is flagged in the blacklist registry.
    Blacklisted = 5,
    /// No admin transfer is pending.
    NoPendingAdmin = 6,
    /// The 24-hour delay has not elapsed yet.
    AdminTransferNotReady = 7,
    /// Proposed admin must differ from the current admin.
    InvalidAdmin = 8,
    InsufficientBalance = 9,
    /// No fee update is pending.
    NoPendingFeeUpdate = 10,
    /// The 24-hour timelock has not elapsed yet.
    FeeUpdateNotReady = 11,
    /// Deposits and settlements are halted by the emergency circuit breaker.
    ContractPaused = 12,
}

// ── Types & storage ──────────────────────────────────────────────────────────

/// An admin transfer awaiting acceptance.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAdmin {
    pub new_admin: Address,
    pub proposed_at: u64,
    /// Earliest ledger timestamp at which `accept_admin` succeeds.
    pub accept_after: u64,
}

/// Breakdown of a settlement payout.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settlement {
    pub amount: i128,
    pub standard_fee: i128,
    pub fee: i128,
    pub payout: i128,
}

/// A proposed settlement fee awaiting its timelock delay before it can execute.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingFeeUpdate {
    pub fee_bps: u32,
    pub proposed_at: u64,
    /// Earliest ledger timestamp at which `execute_fee_update` succeeds.
    pub execute_after: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    PendingAdmin,
    Token,
    FeeRecipient,
    FeeBps,
    Blacklist,
    FeeTier,
    PendingFeeUpdate,
    Paused,
}

// ── Events ───────────────────────────────────────────────────────────────────

#[contractevent(topics = ["bridge", "admin_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminProposed {
    #[topic]
    pub current_admin: Address,
    #[topic]
    pub new_admin: Address,
    pub accept_after: u64,
}

#[contractevent(topics = ["bridge", "admin_revoked"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminProposalRevoked {
    #[topic]
    pub revoked_admin: Address,
}

#[contractevent(topics = ["bridge", "admin_accepted"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferred {
    #[topic]
    pub previous_admin: Address,
    #[topic]
    pub new_admin: Address,
}

#[contractevent(topics = ["bridge", "deposit"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    #[topic]
    pub from: Address,
    pub amount: i128,
}

#[contractevent(topics = ["bridge", "settled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settled {
    #[topic]
    pub to: Address,
    pub amount: i128,
    pub fee: i128,
}

#[contractevent(topics = ["bridge", "fee_update_proposed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeUpdateProposed {
    #[topic]
    pub admin: Address,
    pub fee_bps: u32,
    pub execute_after: u64,
}

#[contractevent(topics = ["bridge", "fee_update_revoked"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeUpdateRevoked {
    #[topic]
    pub admin: Address,
}

#[contractevent(topics = ["bridge", "fee_update_executed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeUpdateExecuted {
    #[topic]
    pub admin: Address,
    pub fee_bps: u32,
}

#[contractevent(topics = ["bridge", "paused"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EmergencyPaused {
    #[topic]
    pub admin: Address,
}

#[contractevent(topics = ["bridge", "unpaused"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EmergencyUnpaused {
    #[topic]
    pub admin: Address,
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct BridgeContract;

#[contractimpl]
impl BridgeContract {
    /// Initialise the bridge.
    ///
    /// * `token` - token deposited and paid out by the bridge
    /// * `fee_recipient` - receives settlement fees
    /// * `fee_bps` - standard settlement fee in basis points (max 10%)
    pub fn initialize(
        env: Env,
        admin: Address,
        token: Address,
        fee_recipient: Address,
        fee_bps: u32,
    ) -> Result<(), BridgeError> {
        admin.require_auth();

        let storage = env.storage().instance();
        if storage.has(&DataKey::Admin) {
            return Err(BridgeError::AlreadyInitialised);
        }
        if fee_bps > MAX_FEE_BPS {
            return Err(BridgeError::InvalidFee);
        }

        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Token, &token);
        storage.set(&DataKey::FeeRecipient, &fee_recipient);
        storage.set(&DataKey::FeeBps, &fee_bps);
        storage.extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }

    // ── Two-step admin transfer ──────────────────────────────────────────────

    /// Propose `new_admin`. Replaces (and restarts the delay of) any pending
    /// proposal.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<PendingAdmin, BridgeError> {
        let admin = Self::require_admin(&env)?;
        if new_admin == admin {
            return Err(BridgeError::InvalidAdmin);
        }

        let now = env.ledger().timestamp();
        let pending = PendingAdmin {
            new_admin: new_admin.clone(),
            proposed_at: now,
            accept_after: now + ADMIN_TRANSFER_DELAY,
        };
        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &pending);

        AdminProposed {
            current_admin: admin,
            new_admin,
            accept_after: pending.accept_after,
        }
        .publish(&env);
        Ok(pending)
    }

    /// Cancel the pending admin proposal.
    pub fn revoke_admin_proposal(env: Env) -> Result<(), BridgeError> {
        Self::require_admin(&env)?;
        let pending = Self::pending_admin(&env)?;
        env.storage().instance().remove(&DataKey::PendingAdmin);

        AdminProposalRevoked {
            revoked_admin: pending.new_admin,
        }
        .publish(&env);
        Ok(())
    }

    /// Complete the transfer. Must be signed by the proposed admin, at least
    /// [`ADMIN_TRANSFER_DELAY`] seconds after the proposal.
    pub fn accept_admin(env: Env) -> Result<(), BridgeError> {
        let pending = Self::pending_admin(&env)?;
        pending.new_admin.require_auth();

        if env.ledger().timestamp() < pending.accept_after {
            return Err(BridgeError::AdminTransferNotReady);
        }

        let previous_admin = Self::get_admin(env.clone())?;
        let storage = env.storage().instance();
        storage.set(&DataKey::Admin, &pending.new_admin);
        storage.remove(&DataKey::PendingAdmin);
        storage.extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);

        AdminTransferred {
            previous_admin,
            new_admin: pending.new_admin,
        }
        .publish(&env);
        Ok(())
    }

    pub fn get_admin(env: Env) -> Result<Address, BridgeError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(BridgeError::NotInitialised)
    }

    pub fn get_pending_admin(env: Env) -> Option<PendingAdmin> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    // ── Configuration ────────────────────────────────────────────────────────

    /// Set (or clear with `None`) the blacklist registry.
    pub fn set_blacklist(env: Env, blacklist: Option<Address>) -> Result<(), BridgeError> {
        Self::require_admin(&env)?;
        Self::set_optional(&env, DataKey::Blacklist, blacklist);
        Ok(())
    }

    /// Set (or clear with `None`) the fee-tier discount contract.
    pub fn set_fee_tier(env: Env, fee_tier: Option<Address>) -> Result<(), BridgeError> {
        Self::require_admin(&env)?;
        Self::set_optional(&env, DataKey::FeeTier, fee_tier);
        Ok(())
    }

    // ── Settlement fee (timelocked) ──────────────────────────────────────────
    //
    // The fee is the parameter most directly felt by depositors, so instead
    // of an immediate setter it goes through the same propose-then-execute
    // shape as admin transfer: `propose_fee_bps` queues the new rate, and it
    // only takes effect [`FEE_TIMELOCK_DELAY`] seconds later via
    // `execute_fee_update`. Only one change may be queued at a time.

    /// Propose a new standard settlement fee (in basis points, max 10%).
    pub fn propose_fee_bps(env: Env, fee_bps: u32) -> Result<PendingFeeUpdate, BridgeError> {
        let admin = Self::require_admin(&env)?;
        if fee_bps > MAX_FEE_BPS {
            return Err(BridgeError::InvalidFee);
        }

        let now = env.ledger().timestamp();
        let pending = PendingFeeUpdate {
            fee_bps,
            proposed_at: now,
            execute_after: now + FEE_TIMELOCK_DELAY,
        };
        env.storage()
            .instance()
            .set(&DataKey::PendingFeeUpdate, &pending);

        FeeUpdateProposed {
            admin,
            fee_bps,
            execute_after: pending.execute_after,
        }
        .publish(&env);
        Ok(pending)
    }

    /// Cancel the pending fee update.
    pub fn revoke_fee_update(env: Env) -> Result<(), BridgeError> {
        let admin = Self::require_admin(&env)?;
        Self::pending_fee_update(&env)?;
        env.storage().instance().remove(&DataKey::PendingFeeUpdate);

        FeeUpdateRevoked { admin }.publish(&env);
        Ok(())
    }

    /// Apply the pending fee update. Must be at least [`FEE_TIMELOCK_DELAY`]
    /// seconds after it was proposed.
    pub fn execute_fee_update(env: Env) -> Result<(), BridgeError> {
        let admin = Self::require_admin(&env)?;
        let pending = Self::pending_fee_update(&env)?;

        if env.ledger().timestamp() < pending.execute_after {
            return Err(BridgeError::FeeUpdateNotReady);
        }

        env.storage().instance().remove(&DataKey::PendingFeeUpdate);
        env.storage()
            .instance()
            .set(&DataKey::FeeBps, &pending.fee_bps);

        FeeUpdateExecuted {
            admin,
            fee_bps: pending.fee_bps,
        }
        .publish(&env);
        Ok(())
    }

    pub fn get_pending_fee_update(env: Env) -> Option<PendingFeeUpdate> {
        env.storage().instance().get(&DataKey::PendingFeeUpdate)
    }

    // ── Emergency circuit breaker ────────────────────────────────────────────
    //
    // Unlike the fee timelock above, pausing takes effect immediately — it
    // exists precisely so the admin can react in real time to an upstream
    // provider outage or a suspicious transaction spike, without waiting out
    // a 24-hour delay. It halts `deposit` and `settle`; admin/governance
    // calls (including finishing a pending fee update) remain available so
    // the situation can still be resolved while paused.

    /// Immediately halt deposits and settlements.
    pub fn pause(env: Env) -> Result<(), BridgeError> {
        let admin = Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        EmergencyPaused { admin }.publish(&env);
        Ok(())
    }

    /// Resume deposits and settlements.
    pub fn unpause(env: Env) -> Result<(), BridgeError> {
        let admin = Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        EmergencyUnpaused { admin }.publish(&env);
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    pub fn get_blacklist(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Blacklist)
    }

    pub fn get_fee_tier(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::FeeTier)
    }

    pub fn get_fee_bps(env: Env) -> Result<u32, BridgeError> {
        env.storage()
            .instance()
            .get(&DataKey::FeeBps)
            .ok_or(BridgeError::NotInitialised)
    }

    // ── Bridge operations ────────────────────────────────────────────────────

    /// On-ramp: move `amount` tokens from `from` into the bridge.
    pub fn deposit(env: Env, from: Address, amount: i128) -> Result<(), BridgeError> {
        Self::require_not_paused(&env)?;
        from.require_auth();
        if amount <= 0 {
            return Err(BridgeError::InvalidAmount);
        }
        Self::ensure_not_blacklisted(&env, &from)?;

        Self::token(&env)?.transfer(&from, env.current_contract_address(), &amount);

        Deposited { from, amount }.publish(&env);
        Ok(())
    }

    /// Settlement quote for paying `amount` out to `to`.
    pub fn quote_settlement(
        env: Env,
        to: Address,
        amount: i128,
    ) -> Result<Settlement, BridgeError> {
        if amount <= 0 {
            return Err(BridgeError::InvalidAmount);
        }
        let fee_bps = Self::get_fee_bps(env.clone())?;
        let standard_fee = amount * fee_bps as i128 / BPS_DENOMINATOR;
        let fee = match Self::get_fee_tier(env.clone()) {
            Some(fee_tier) => {
                FeeTierClient::new(&env, &fee_tier).discounted_fee(&to, &standard_fee)
            }
            None => standard_fee,
        };
        // Never trust the external contract to raise the fee or go negative.
        let fee = fee.clamp(0, standard_fee);
        Ok(Settlement {
            amount,
            standard_fee,
            fee,
            payout: amount - fee,
        })
    }

    /// Off-ramp settlement: pay `amount` minus the (discounted) fee to `to`
    /// and the fee to the fee recipient. Admin only.
    pub fn settle(env: Env, to: Address, amount: i128) -> Result<Settlement, BridgeError> {
        Self::require_not_paused(&env)?;
        Self::require_admin(&env)?;
        Self::ensure_not_blacklisted(&env, &to)?;

        let settlement = Self::quote_settlement(env.clone(), to.clone(), amount)?;
        let token = Self::token(&env)?;
        let bridge = env.current_contract_address();
        if token.balance(&bridge) < amount {
            return Err(BridgeError::InsufficientBalance);
        }

        token.transfer(&bridge, &to, &settlement.payout);
        if settlement.fee > 0 {
            let fee_recipient: Address = env
                .storage()
                .instance()
                .get(&DataKey::FeeRecipient)
                .ok_or(BridgeError::NotInitialised)?;
            token.transfer(&bridge, &fee_recipient, &settlement.fee);
        }

        Settled {
            to,
            amount,
            fee: settlement.fee,
        }
        .publish(&env);
        Ok(settlement)
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    fn require_admin(env: &Env) -> Result<Address, BridgeError> {
        let admin = Self::get_admin(env.clone())?;
        admin.require_auth();
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(admin)
    }

    fn pending_admin(env: &Env) -> Result<PendingAdmin, BridgeError> {
        Self::get_pending_admin(env.clone()).ok_or(BridgeError::NoPendingAdmin)
    }

    fn pending_fee_update(env: &Env) -> Result<PendingFeeUpdate, BridgeError> {
        Self::get_pending_fee_update(env.clone()).ok_or(BridgeError::NoPendingFeeUpdate)
    }

    fn require_not_paused(env: &Env) -> Result<(), BridgeError> {
        if Self::is_paused(env.clone()) {
            return Err(BridgeError::ContractPaused);
        }
        Ok(())
    }

    fn token(env: &Env) -> Result<token::Client<'_>, BridgeError> {
        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(BridgeError::NotInitialised)?;
        Ok(token::Client::new(env, &token))
    }

    fn ensure_not_blacklisted(env: &Env, address: &Address) -> Result<(), BridgeError> {
        if let Some(blacklist) = Self::get_blacklist(env.clone()) {
            if BlacklistClient::new(env, &blacklist).is_blacklisted(address) {
                return Err(BridgeError::Blacklisted);
            }
        }
        Ok(())
    }

    fn set_optional(env: &Env, key: DataKey, value: Option<Address>) {
        match value {
            Some(address) => env.storage().instance().set(&key, &address),
            None => env.storage().instance().remove(&key),
        }
    }
}
