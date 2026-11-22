#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, IntoVal,
    Symbol, Vec,
};

const ORACLE_POOLS: Symbol = symbol_short!("orc_pools");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleError {
    Unauthorized = 1,
    InvalidAmount = 2,
    NoRegisteredPools = 3,
    PoolQueryFailed = 4,
    SpreadTooHigh = 5,
}

#[contracttype]
#[derive(Clone)]
pub struct OraclePool {
    pub contract: Address,
    pub asset_in: Address,
    pub asset_out: Address,
    pub max_spread_bps: u32,
}

#[contract]
pub struct OracleContract;

#[contractimpl]
impl OracleContract {
    pub fn register_pool(env: Env, admin: Address, pool: OraclePool) {
        admin.require_auth();

        assert!(
            pool.max_spread_bps > 0,
            "Oracle: max_spread_bps must be positive"
        );

        let mut pools: Vec<OraclePool> = env
            .storage()
            .persistent()
            .get(&ORACLE_POOLS)
            .unwrap_or_else(|| Vec::new(&env));

        pools.push_back(pool);
        env.storage().persistent().set(&ORACLE_POOLS, &pools);
    }

    pub fn get_rate(env: Env, asset_in: Address, asset_out: Address, amount_in: i128) -> i128 {
        let (best, _worst) = Self::fetch_rate_range(&env, asset_in, asset_out, amount_in);

        best
    }

    pub fn get_rate_with_spread(
        env: Env,
        asset_in: Address,
        asset_out: Address,
        amount_in: i128,
        max_spread_bps: u32,
    ) -> Result<i128, OracleError> {
        assert!(
            max_spread_bps > 0,
            "Oracle: max_spread_bps must be positive"
        );
        let (best, worst) = Self::fetch_rate_range(&env, asset_in, asset_out, amount_in);

        let spread_bps = Self::compute_spread_bps(best, worst)?;

        if spread_bps > max_spread_bps as i128 {
            return Err(OracleError::SpreadTooHigh);
        }

        Ok(best)
    }

    pub fn validate_spread(
        env: Env,
        asset_in: Address,
        asset_out: Address,
        amount_in: i128,
        max_spread_bps: u32,
    ) -> bool {
        let (best, worst) = Self::fetch_rate_range(&env, asset_in, asset_out, amount_in);
        let spread_bps = Self::compute_spread_bps(best, worst).unwrap_or(0);
        spread_bps <= max_spread_bps as i128
    }

    pub fn list_pools(env: Env, asset_in: Address, asset_out: Address) -> Vec<OraclePool> {
        let pools: Vec<OraclePool> = env
            .storage()
            .persistent()
            .get(&ORACLE_POOLS)
            .unwrap_or_else(|| Vec::new(&env));

        let mut filtered = Vec::new(&env);
        for pool in pools.iter() {
            if pool.asset_in == asset_in && pool.asset_out == asset_out {
                filtered.push_back(pool.clone());
            }
        }

        filtered
    }
}

impl OracleContract {
    fn fetch_rate_range(
        env: &Env,
        asset_in: Address,
        asset_out: Address,
        amount_in: i128,
    ) -> (i128, i128) {
        assert!(amount_in > 0, "Oracle: amount_in must be positive");
        let pools: Vec<OraclePool> = env
            .storage()
            .persistent()
            .get(&ORACLE_POOLS)
            .unwrap_or_else(|| Vec::new(env));

        let mut best = i128::MIN;
        let mut worst = i128::MAX;
        let mut found = false;

        for pool in pools.iter() {
            if pool.asset_in != asset_in || pool.asset_out != asset_out {
                continue;
            }

            let quote: i128 = env.invoke_contract(
                &pool.contract,
                &Symbol::new(env, "get_quote"),
                soroban_sdk::vec![
                    env,
                    pool.asset_in.into_val(env),
                    pool.asset_out.into_val(env),
                    amount_in.into_val(env)
                ],
            );

            assert!(quote > 0, "Oracle: pool quote must be positive");

            if quote > best {
                best = quote;
            }
            if quote < worst {
                worst = quote;
            }
            found = true;
        }

        assert!(
            found,
            "Oracle: no registered pools for requested asset pair"
        );

        (best, worst)
    }

    fn compute_spread_bps(best: i128, worst: i128) -> Result<i128, OracleError> {
        if best <= 0 || worst <= 0 || best < worst {
            return Err(OracleError::PoolQueryFailed);
        }
        let spread = best - worst;
        Ok(spread.saturating_mul(10_000) / best)
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::{testutils::Address as _, testutils::Ledger, Address, Env};

    #[contract]
    pub struct DummyPool;

    #[contractimpl]
    impl DummyPool {
        pub fn get_quote(
            _env: Env,
            _asset_in: Address,
            _asset_out: Address,
            amount_in: i128,
        ) -> i128 {
            amount_in * 100
        }
    }

    #[contract]
    pub struct SlippagePool;

    #[contractimpl]
    impl SlippagePool {
        pub fn get_quote(
            _env: Env,
            _asset_in: Address,
            _asset_out: Address,
            amount_in: i128,
        ) -> i128 {
            amount_in * 85
        }
    }

    #[test]
    fn get_rate_returns_best_available_quote() {
        let env = Env::default();
        env.ledger().with_mut(|li| li.timestamp = 1_717_171_717);
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let asset_in = Address::generate(&env);
        let asset_out = Address::generate(&env);

        let pool_id = env.register(DummyPool, ());
        let oracle_id = env.register(OracleContract, ());

        let pool = OraclePool {
            contract: pool_id,
            asset_in: asset_in.clone(),
            asset_out: asset_out.clone(),
            max_spread_bps: 500,
        };

        OracleContractClient::new(&env, &oracle_id).register_pool(&admin, &pool);

        let output =
            OracleContractClient::new(&env, &oracle_id).get_rate(&asset_in, &asset_out, &1_000);
        assert_eq!(output, 100_000);
    }

    #[test]
    fn get_rate_with_spread_reverts_when_spread_exceeds_limit() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let asset_in = Address::generate(&env);
        let asset_out = Address::generate(&env);

        let good_pool_id = env.register(DummyPool, ());
        let bad_pool_id = env.register(SlippagePool, ());
        let oracle_id = env.register(OracleContract, ());

        let good_pool = OraclePool {
            contract: good_pool_id,
            asset_in: asset_in.clone(),
            asset_out: asset_out.clone(),
            max_spread_bps: 500,
        };
        let bad_pool = OraclePool {
            contract: bad_pool_id,
            asset_in: asset_in.clone(),
            asset_out: asset_out.clone(),
            max_spread_bps: 500,
        };

        let client = OracleContractClient::new(&env, &oracle_id);
        client.register_pool(&admin, &good_pool);
        client.register_pool(&admin, &bad_pool);

        let result = client.try_get_rate_with_spread(&asset_in, &asset_out, &1_000, &200);
        assert!(result.is_err());
    }
}
