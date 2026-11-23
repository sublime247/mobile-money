#![no_std]
#![allow(clippy::too_many_arguments)]
#![allow(deprecated)]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env,
    IntoVal, Symbol, Vec,
};

// ── Error types ──────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum RouterError {
    InsufficientLiquidity = 1,
    SlippageExceeded = 2,
    RouteNotFound = 3,
    EmptyPath = 4,
    InvalidAmount = 5,
    DeadlineReached = 6,
    PoolNotFound = 7,
    ContractPaused = 8,
    NotEmergencyAdmin = 9,
}

// ── Liquidity Pool ────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub struct LiquidityPool {
    pub pool_address: Address,
    pub asset_in: Address,
    pub asset_out: Address,
    pub depth: i128,
}

impl LiquidityPool {
    pub fn reserve(&self, asset: &Address) -> i128 {
        if self.asset_in == *asset {
            self.depth
        } else {
            0
        }
    }
}

// ── Router instance state ────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub struct RouterState {
    pub pools: Vec<LiquidityPool>,
    pub owner: Address,
    pub max_slippage_bps: u32,
    pub min_liquidity_depth: i128,
}

const ROUTER_STATE_KEY: &str = "ROUTER_STATE";

// ── Emergency pause state ─────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub struct PauseState {
    pub paused: bool,
    pub emergency_admin: Address,
}

const PAUSE_STATE_KEY: &str = "PAUSE_STATE";

#[contractevent(topics = ["ContractPaused"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractPaused {
    #[topic]
    pub admin: Address,
}

#[contractevent(topics = ["ContractUnpaused"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractUnpaused {
    #[topic]
    pub admin: Address,
}

// ── Router Contract ───────────────────────────────────────────

#[contract]
pub struct Router;

#[contractimpl]
impl Router {
    // ── initialize ────────────────────────────────────────────

    pub fn initialize(env: Env, owner: Address, max_slippage_bps: u32, min_liquidity_depth: i128) {
        owner.require_auth();

        assert!(
            max_slippage_bps > 0 && max_slippage_bps <= 10_000,
            "max_slippage_bps must be in (0, 10000]"
        );
        assert!(
            min_liquidity_depth > 0,
            "min_liquidity_depth must be positive"
        );

        let state = RouterState {
            pools: Vec::new(&env),
            owner: owner.clone(),
            max_slippage_bps,
            min_liquidity_depth,
        };

        env.storage().instance().set(&ROUTER_STATE_KEY, &state);

        // The owner is the initial emergency admin; it can be rotated with
        // `set_emergency_admin`.
        let pause_state = PauseState {
            paused: false,
            emergency_admin: owner,
        };
        env.storage().instance().set(&PAUSE_STATE_KEY, &pause_state);
        env.storage().instance().extend_ttl(1000, 10000);
    }

    // ── Emergency pause control ───────────────────────────────

    /// Replace the emergency admin. Only the router owner may rotate it.
    pub fn set_emergency_admin(env: Env, caller: Address, new_admin: Address) {
        caller.require_auth();

        let state: RouterState = env
            .storage()
            .instance()
            .get(&ROUTER_STATE_KEY)
            .expect("not initialized");
        assert!(caller == state.owner, "only owner can set emergency admin");

        let mut pause_state = Self::load_pause_state(&env);
        pause_state.emergency_admin = new_admin;
        env.storage().instance().set(&PAUSE_STATE_KEY, &pause_state);
        env.storage().instance().extend_ttl(1000, 10000);
    }

    /// Pause all routing and swap execution. Restricted to the emergency admin.
    pub fn pause(env: Env, caller: Address) -> Result<(), RouterError> {
        caller.require_auth();

        let mut pause_state = Self::load_pause_state(&env);
        if caller != pause_state.emergency_admin {
            return Err(RouterError::NotEmergencyAdmin);
        }

        pause_state.paused = true;
        env.storage().instance().set(&PAUSE_STATE_KEY, &pause_state);
        env.storage().instance().extend_ttl(1000, 10000);

        ContractPaused { admin: caller }.publish(&env);
        Ok(())
    }

    /// Resume routing and swap execution. Restricted to the emergency admin.
    pub fn unpause(env: Env, caller: Address) -> Result<(), RouterError> {
        caller.require_auth();

        let mut pause_state = Self::load_pause_state(&env);
        if caller != pause_state.emergency_admin {
            return Err(RouterError::NotEmergencyAdmin);
        }

        pause_state.paused = false;
        env.storage().instance().set(&PAUSE_STATE_KEY, &pause_state);
        env.storage().instance().extend_ttl(1000, 10000);

        ContractUnpaused { admin: caller }.publish(&env);
        Ok(())
    }

    /// Returns true while the router is paused.
    pub fn is_paused(env: Env) -> bool {
        Self::load_pause_state(&env).paused
    }

    /// Returns the address allowed to pause/unpause the router.
    pub fn get_emergency_admin(env: Env) -> Address {
        Self::load_pause_state(&env).emergency_admin
    }

    fn load_pause_state(env: &Env) -> PauseState {
        if let Some(pause_state) = env.storage().instance().get(&PAUSE_STATE_KEY) {
            return pause_state;
        }

        // Upgrade compatibility: contracts initialized before pause control was
        // added have no pause state. Default to unpaused with the router owner
        // as the emergency admin.
        let state: RouterState = env
            .storage()
            .instance()
            .get(&ROUTER_STATE_KEY)
            .expect("not initialized");
        PauseState {
            paused: false,
            emergency_admin: state.owner,
        }
    }

    fn ensure_not_paused(env: &Env) -> Result<(), RouterError> {
        if Self::load_pause_state(env).paused {
            return Err(RouterError::ContractPaused);
        }
        Ok(())
    }

    // ── add_pool ─────────────────────────────────────────────

    pub fn add_pool(env: Env, caller: Address, pool: LiquidityPool) {
        caller.require_auth();
        let mut state: RouterState = env
            .storage()
            .instance()
            .get(&ROUTER_STATE_KEY)
            .expect("not initialized");

        assert!(caller == state.owner, "only owner can add pools");
        assert!(
            pool.depth >= state.min_liquidity_depth,
            "pool depth below minimum"
        );

        let mut pools = state.pools.clone();
        pools.push_back(pool);
        state.pools = pools.clone();

        env.storage().instance().set(&ROUTER_STATE_KEY, &state);
        env.storage().instance().extend_ttl(1000, 10000);
    }

    // ── remove_pool ──────────────────────────────────────────

    pub fn remove_pool(
        env: Env,
        caller: Address,
        pool_address: Address,
    ) -> Result<(), RouterError> {
        caller.require_auth();
        let mut state: RouterState = env
            .storage()
            .instance()
            .get(&ROUTER_STATE_KEY)
            .expect("not initialized");

        assert!(caller == state.owner, "only owner can remove pools");

        let original_len = state.pools.len();
        let mut new_pools = Vec::new(&env);
        for p in state.pools.iter() {
            if p.pool_address != pool_address {
                new_pools.push_back(p.clone());
            }
        }

        if new_pools.len() == original_len {
            return Err(RouterError::PoolNotFound);
        }
        state.pools = new_pools;

        env.storage().instance().set(&ROUTER_STATE_KEY, &state);
        env.storage().instance().extend_ttl(1000, 10000);
        Ok(())
    }

    // ── find_optimal_route (recursive) ─────────────────────────

    /// Find the best route from `asset_in` to `asset_out` by recursively
    /// exploring available liquidity pools and their depths.
    /// Returns the ordered list of pool addresses forming the path.
    pub fn find_optimal_route(
        env: Env,
        asset_in: Address,
        asset_out: Address,
        amount_in: i128,
        max_hops: u32,
    ) -> Result<Vec<Address>, RouterError> {
        Self::ensure_not_paused(&env)?;

        soroban_sdk::assert_with_error!(&env, amount_in > 0, RouterError::InvalidAmount);
        soroban_sdk::assert_with_error!(&env, max_hops > 0, RouterError::RouteNotFound);

        let state: RouterState = env
            .storage()
            .instance()
            .get(&ROUTER_STATE_KEY)
            .expect("not initialized");

        let mut path = Vec::new(&env);
        let mut visited = Vec::new(&env);

        Self::find_route_recursive(
            &env,
            &state.pools,
            &asset_in,
            &asset_out,
            amount_in,
            max_hops,
            &mut path,
            &mut visited,
        )
        .ok_or(RouterError::RouteNotFound)
    }

    fn find_route_recursive(
        _env: &Env,
        pools: &Vec<LiquidityPool>,
        asset_in: &Address,
        asset_out: &Address,
        amount_in: i128,
        remaining_hops: u32,
        path: &mut Vec<Address>,
        visited: &mut Vec<Address>,
    ) -> Option<Vec<Address>> {
        // Base case: check for a direct pool that can cover the full amount
        for pool in pools.iter() {
            if pool.asset_in == *asset_in && pool.asset_out == *asset_out && pool.depth >= amount_in
            {
                let mut result_path = path.clone();
                result_path.push_back(pool.pool_address.clone());
                return Some(result_path);
            }
        }

        // No more hops available — route cannot be reached
        if remaining_hops <= 1 {
            return None;
        }

        // Recursive case: try each pool whose input matches the current asset,
        // then recurse on the pool's output asset.
        for pool in pools.iter() {
            if pool.asset_in == *asset_in && pool.depth >= amount_in {
                // Avoid cycles — skip pools already in the current path
                let mut cycle = false;
                for v in visited.iter() {
                    if v == pool.pool_address {
                        cycle = true;
                        break;
                    }
                }
                if cycle {
                    continue;
                }

                let intermediate_asset = pool.asset_out.clone();

                visited.push_back(pool.pool_address.clone());
                path.push_back(pool.pool_address.clone());

                let sub_result = Self::find_route_recursive(
                    _env,
                    pools,
                    &intermediate_asset,
                    asset_out,
                    amount_in,
                    remaining_hops - 1,
                    path,
                    visited,
                );

                if sub_result.is_some() {
                    return sub_result;
                }

                // Backtrack if this branch did not lead to a valid route
                let _ = path.pop_back();
                let _ = visited.pop_back();
            }
        }

        None
    }

    // ── execute_swap (atomic) ─────────────────────────────────

    /// Execute a multi-hop swap atomically along the resolved path.
    /// All swaps succeed or the entire transaction reverts.
    pub fn execute_swap(
        env: Env,
        caller: Address,
        path: Vec<Address>,
        asset_in: Address,
        asset_out: Address,
        amount_in: i128,
        min_amount_out: i128,
        deadline: u32,
    ) -> Result<i128, RouterError> {
        caller.require_auth();
        Self::ensure_not_paused(&env)?;

        soroban_sdk::assert_with_error!(&env, amount_in > 0, RouterError::InvalidAmount);
        soroban_sdk::assert_with_error!(&env, min_amount_out > 0, RouterError::InvalidAmount);
        soroban_sdk::assert_with_error!(
            &env,
            env.ledger().sequence() < deadline,
            RouterError::DeadlineReached
        );

        let state: RouterState = env
            .storage()
            .instance()
            .get(&ROUTER_STATE_KEY)
            .expect("not initialized");

        if path.is_empty() {
            return Err(RouterError::EmptyPath);
        }

        // Resolve each hop to its concrete pool, verifying continuity
        let mut resolved_pools = Vec::new(&env);
        let mut current_asset = asset_in.clone();

        for pool_addr in path.iter() {
            let mut found = false;
            for p in state.pools.iter() {
                if p.pool_address == pool_addr && p.asset_in == current_asset {
                    resolved_pools.push_back(p.clone());
                    current_asset = p.asset_out.clone();
                    found = true;
                    break;
                }
            }
            if !found {
                return Err(RouterError::PoolNotFound);
            }
        }

        if current_asset != asset_out {
            return Err(RouterError::RouteNotFound);
        }

        // Transfer input tokens from caller to this contract
        let input_token = token::Client::new(&env, &asset_in);
        input_token.transfer(&caller, env.current_contract_address(), &amount_in);

        // Execute each hop atomically through the pool contracts
        let mut current_amount = amount_in;

        for pool in resolved_pools.iter() {
            let output_amount = Self::check_slippage(&env, &pool, current_amount, &state)?;
            current_amount = output_amount;
        }

        // Final slippage guard against min_amount_out
        if current_amount < min_amount_out {
            return Err(RouterError::SlippageExceeded);
        }

        // Transfer output tokens to the caller (recipient)
        let output_token = token::Client::new(&env, &asset_out);
        output_token.transfer(&env.current_contract_address(), &caller, &current_amount);

        env.events().publish(
            (Symbol::new(&env, "SwapExecuted"), caller),
            (amount_in, current_amount),
        );

        Ok(current_amount)
    }

    // ── check_slippage ────────────────────────────────────────

    /// Validate that a pool swap will not exceed the configured slippage limit,
    /// then invoke the pool contract atomically. Reverts if slippage is breached.
    fn check_slippage(
        env: &Env,
        pool: &LiquidityPool,
        amount_in: i128,
        state: &RouterState,
    ) -> Result<i128, RouterError> {
        if pool.depth <= 0 {
            return Err(RouterError::InvalidAmount);
        }

        // Pre-check: pool must have enough depth for the input amount
        if pool.depth < amount_in {
            return Err(RouterError::InsufficientLiquidity);
        }

        // Compute expected output using constant-product formula with 0.30% fee
        let fee_bps: i128 = 30;
        let fee_multiplier = 10_000i128
            .checked_sub(fee_bps)
            .ok_or(RouterError::InvalidAmount)?;
        let amount_with_fee = amount_in
            .checked_mul(fee_multiplier)
            .and_then(|value| value.checked_div(10_000))
            .ok_or(RouterError::InvalidAmount)?;

        if amount_with_fee <= 0 {
            return Err(RouterError::InvalidAmount);
        }

        let denominator = pool
            .depth
            .checked_add(amount_with_fee)
            .ok_or(RouterError::InvalidAmount)?;
        if denominator <= 0 {
            return Err(RouterError::InvalidAmount);
        }

        let expected_out = amount_with_fee
            .checked_mul(pool.depth)
            .and_then(|value| value.checked_div(denominator))
            .ok_or(RouterError::InvalidAmount)?;
        if expected_out <= 0 {
            return Err(RouterError::InvalidAmount);
        }

        // Apply max slippage tolerance relative to expected output
        let slippage_multiplier = 10_000i128
            .checked_sub(state.max_slippage_bps as i128)
            .ok_or(RouterError::InvalidAmount)?;
        let min_expected = expected_out
            .checked_mul(slippage_multiplier)
            .and_then(|value| value.checked_div(10_000))
            .ok_or(RouterError::InvalidAmount)?;

        // Atomic invocation of the pool's swap function
        let amount_out = env.invoke_contract::<i128>(
            &pool.pool_address,
            &Symbol::new(env, "swap"),
            soroban_sdk::vec![
                env,
                pool.asset_in.clone().into_val(env),
                pool.asset_out.clone().into_val(env),
                amount_in.into_val(env),
                1i128.into_val(env),
                env.current_contract_address().into_val(env),
            ],
        );

        if amount_out < min_expected {
            return Err(RouterError::SlippageExceeded);
        }

        Ok(amount_out)
    }

    // ── query_pool_depth ──────────────────────────────────────

    pub fn query_pool_depth(
        env: Env,
        pool_address: Address,
        asset: Address,
    ) -> Result<i128, RouterError> {
        let state: RouterState = env
            .storage()
            .instance()
            .get(&ROUTER_STATE_KEY)
            .expect("not initialized");

        let mut found = false;
        for p in state.pools.iter() {
            if p.pool_address == pool_address {
                found = true;
                break;
            }
        }

        if !found {
            return Err(RouterError::PoolNotFound);
        }

        let reserves: i128 = env.invoke_contract(
            &pool_address,
            &Symbol::new(&env, "get_reserve"),
            soroban_sdk::vec![&env, asset.into_val(&env)],
        );
        Ok(reserves)
    }

    // ── get_state ─────────────────────────────────────────────

    pub fn get_state(env: Env) -> RouterState {
        let state = env
            .storage()
            .instance()
            .get(&ROUTER_STATE_KEY)
            .expect("not initialized");
        env.storage().instance().extend_ttl(1000, 10000);
        state
    }

    // ── get_pools ─────────────────────────────────────────────

    pub fn get_pools(env: Env) -> Vec<LiquidityPool> {
        let state: RouterState = env
            .storage()
            .instance()
            .get(&ROUTER_STATE_KEY)
            .expect("not initialized");
        env.storage().instance().extend_ttl(1000, 10000);
        state.pools
    }
}

// ── Tests ─────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Address as _, Ledger},
        Address, Env,
    };

    #[contract]
    struct MockPool;

    #[contractimpl]
    impl MockPool {
        pub fn swap(
            _env: Env,
            _asset_in: Address,
            _asset_out: Address,
            amount_in: i128,
            _min_amount_out: i128,
            _recipient: Address,
        ) -> i128 {
            amount_in * 95 / 100
        }
    }

    #[contract]
    struct BadSlippagePool;

    #[contractimpl]
    impl BadSlippagePool {
        pub fn swap(
            _env: Env,
            _asset_in: Address,
            _asset_out: Address,
            amount_in: i128,
            _min_amount_out: i128,
            _recipient: Address,
        ) -> i128 {
            amount_in / 2
        }
    }

    fn setup() -> (
        Env,
        Address,
        Address,
        Address,
        Address,
        Address,
        Address,
        RouterClient<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let owner = Address::generate(&env);
        let caller = Address::generate(&env);
        let asset_in = Address::generate(&env);
        let asset_mid = Address::generate(&env);
        let asset_out = Address::generate(&env);
        let pool1_addr = Address::generate(&env);

        let contract_id = env.register(Router, ());
        let client = RouterClient::new(&env, &contract_id);

        (
            env, owner, caller, asset_in, asset_mid, asset_out, pool1_addr, client,
        )
    }

    fn router_state(env: &Env, max_slippage_bps: u32) -> RouterState {
        RouterState {
            pools: soroban_sdk::Vec::new(env),
            owner: Address::generate(env),
            max_slippage_bps,
            min_liquidity_depth: 1,
        }
    }

    #[test]
    fn test_initialize() {
        let (env, owner, _caller, _, _, _, _, client) = setup();
        env.ledger().set_timestamp(100);

        client.initialize(&owner, &500, &1000);

        let state = client.get_state();
        assert_eq!(state.owner, owner);
        assert_eq!(state.max_slippage_bps, 500);
        assert_eq!(state.min_liquidity_depth, 1000);
    }

    #[test]
    fn test_add_and_get_pools() {
        let (env, owner, _caller, asset_in, asset_out, _, pool1_addr, client) = setup();
        env.ledger().set_timestamp(100);

        client.initialize(&owner, &500, &1000);

        let pool = LiquidityPool {
            pool_address: pool1_addr.clone(),
            asset_in: asset_in.clone(),
            asset_out: asset_out.clone(),
            depth: 5000,
        };

        client.add_pool(&owner, &pool);

        let pools = client.get_pools();
        assert_eq!(pools.len(), 1);
        assert_eq!(pools.get(0).unwrap().pool_address, pool1_addr);
    }

    #[test]
    fn test_remove_pool() {
        let (env, owner, _caller, asset_in, asset_out, _, pool1_addr, client) = setup();
        env.ledger().set_timestamp(100);

        client.initialize(&owner, &500, &1000);

        let pool = LiquidityPool {
            pool_address: pool1_addr.clone(),
            asset_in: asset_in.clone(),
            asset_out: asset_out.clone(),
            depth: 5000,
        };

        client.add_pool(&owner, &pool);
        assert_eq!(client.get_pools().len(), 1);

        client.remove_pool(&owner, &pool1_addr);
        assert_eq!(client.get_pools().len(), 0);
    }

    #[test]
    fn test_remove_pool_not_found() {
        let (env, owner, _caller, _asset_in, _asset_out, _, _pool1_addr, client) = setup();
        env.ledger().set_timestamp(100);

        client.initialize(&owner, &500, &1000);

        let non_existent = Address::generate(&env);
        let result = client.try_remove_pool(&owner, &non_existent);
        assert!(result.is_err());
    }

    #[test]
    fn test_find_optimal_route_direct() {
        let (env, owner, _caller, asset_in, asset_out, _, pool1_addr, client) = setup();
        env.ledger().set_timestamp(100);

        client.initialize(&owner, &500, &1000);

        let pool = LiquidityPool {
            pool_address: pool1_addr.clone(),
            asset_in: asset_in.clone(),
            asset_out: asset_out.clone(),
            depth: 5000,
        };
        client.add_pool(&owner, &pool);

        let path = client.find_optimal_route(&asset_in, &asset_out, &1000, &3);
        assert_eq!(path.len(), 1);
        assert_eq!(path.get(0).unwrap(), pool1_addr);
    }

    #[test]
    fn test_find_optimal_route_no_route() {
        let (env, owner, _caller, asset_in, asset_out, _, _pool1_addr, client) = setup();
        env.ledger().set_timestamp(100);

        client.initialize(&owner, &500, &1000);

        let result = client.try_find_optimal_route(&asset_in, &asset_out, &1000, &3);
        assert!(result.is_err());
    }

    #[test]
    fn test_check_slippage_rejects_dust_amounts() {
        let env = Env::default();
        let pool_contract = env.register(MockPool, ());
        let pool = LiquidityPool {
            pool_address: pool_contract,
            asset_in: Address::generate(&env),
            asset_out: Address::generate(&env),
            depth: 5_000,
        };
        let state = router_state(&env, 500);

        let result = Router::check_slippage(&env, &pool, 1, &state);
        assert_eq!(result, Err(RouterError::InvalidAmount));
    }

    #[test]
    fn test_check_slippage_passes_for_valid_small_input() {
        let env = Env::default();
        let router_contract = env.register(Router, ());
        let pool_contract = env.register(MockPool, ());
        let pool = LiquidityPool {
            pool_address: pool_contract,
            asset_in: Address::generate(&env),
            asset_out: Address::generate(&env),
            depth: 5_000,
        };
        let state = router_state(&env, 500);

        let result = env.as_contract(&router_contract, || {
            Router::check_slippage(&env, &pool, 200, &state)
        });
        assert_eq!(result, Ok(190));
    }

    #[test]
    fn test_check_slippage_exceeds_for_bad_quote() {
        let env = Env::default();
        let router_contract = env.register(Router, ());
        let pool_contract = env.register(BadSlippagePool, ());
        let pool = LiquidityPool {
            pool_address: pool_contract,
            asset_in: Address::generate(&env),
            asset_out: Address::generate(&env),
            depth: 5_000,
        };
        let state = router_state(&env, 500);

        let result = env.as_contract(&router_contract, || {
            Router::check_slippage(&env, &pool, 1_000, &state)
        });
        assert_eq!(result, Err(RouterError::SlippageExceeded));
    }

    #[test]
    fn test_check_slippage_rejects_zero_depth_pool() {
        let env = Env::default();
        let pool_contract = env.register(MockPool, ());
        let pool = LiquidityPool {
            pool_address: pool_contract,
            asset_in: Address::generate(&env),
            asset_out: Address::generate(&env),
            depth: 0,
        };
        let state = router_state(&env, 500);

        let result = Router::check_slippage(&env, &pool, 100, &state);
        assert_eq!(result, Err(RouterError::InvalidAmount));
    }

    #[test]
    fn test_validate_pool_depth() {
        let env = Env::default();
        let asset = Address::generate(&env);
        let pool = LiquidityPool {
            pool_address: Address::generate(&env),
            asset_in: asset.clone(),
            asset_out: Address::generate(&env),
            depth: 5000,
        };

        assert_eq!(pool.reserve(&asset), 5000);

        let other_asset = Address::generate(&env);
        assert_eq!(pool.reserve(&other_asset), 0);
    }
}

#[cfg(test)]
mod test;
