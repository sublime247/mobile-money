
// SPDX-License-Identifier: Apache-2.0
use soroban_sdk::{contract, contractimpl, contractinterface, symbol, vec, Env, Symbol, Address, Bytes, BytesN, String, I32, U32, U64, U128, Vec, Map, Error, panic, panic_with_error};
use soroban_sdk::token::TokenClient;
use soroban_sdk::storage::{Value, Persistent, Temporary};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EscrowError {
    ReentrancyGuardError,
    InsufficientBalance,
    InvalidOperationId,
    AlreadyLocked,
    NotLocked,
    InvalidAmount,
    // ... existing error variants
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Escrow {
    pub balances: Map<Address, U128>,
    pub reentrancy_lock: bool,
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    pub fn new(env: Env) -> Escrow {
        let balances = Map::new(&env);
        Escrow {
            balances,
            reentrancy_lock: false,
        }
    }

    pub fn lock_funds(env: Env, contract_id: Address, amount: U128, operation_id: U32) -> Result<(), EscrowError> {
        let contract = Self::contract(&env);
        if contract.reentrancy_lock {
            return Err(EscrowError::ReentrancyGuardError);
        }

        // Mark reentrancy lock before state changes
        contract.reentrancy_lock = true;

        // Use temporary storage for transient operation_id
        let temp_storage = Temporary::new(&env, &operation_id);
        if temp_storage.load::<U32>().is_some() {
            contract.reentrancy_lock = false;
            return Err(EscrowError::InvalidOperationId);
        }
        temp_storage.store(&operation_id);

        // Persistent storage for balances
        contract.balances.set(&contract_id, &amount);

        // Release lock after all state changes
        contract.reentrancy_lock = false;
        Ok(())
    }

    pub fn release_funds(env: Env, contract_id: Address, amount: U128, operation_id: U32) -> Result<(), EscrowError> {
        let contract = Self::contract(&env);
        if contract.reentrancy_lock {
            return Err(EscrowError::ReentrancyGuardError);
        }

        contract.reentrancy_lock = true;

        // Verify operation_id from temporary storage
        let temp_storage = Temporary::new(&env, &operation_id);
        if temp_storage.load::<U32>().unwrap() != operation_id {
            contract.reentrancy_lock = false;
            return Err(EscrowError::InvalidOperationId);
        }

        // Check balance from persistent storage
        let balance = contract.balances.get(&contract_id).unwrap_or(U128::zero());
        if balance < amount {
            contract.reentrancy_lock = false;
            return Err(EscrowError::InsufficientBalance);
        }

        // Update balance
        contract.balances.set(&contract_id, &(balance - amount));
        temp_storage.clear();

        contract.reentrancy_lock = false;
        Ok(())
    }

    // ... existing methods remain unchanged
}
