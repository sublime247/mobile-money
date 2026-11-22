#![no_std]

//! Staking-based bridge fee discounts.
//!
//! Looks up a user's staked token balance on the staking contract and maps it
//! to a discount tier. The bridge passes its standard fee through
//! [`FeeTierContract::quote`] / [`FeeTierContract::discounted_fee`] and charges
//! the returned amount at settlement.
//!
//! Default tiers (thresholds scaled by the staking token's decimals):
//!
//! | Tier | Min stake | Discount |
//! |------|-----------|----------|
//! | 1    | 1,000     | 10%      |
//! | 2    | 5,000     | 25%      |
//! | 3    | 10,000    | 50%      |

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, vec, Address, Env, Vec,
};

// ── Constants ────────────────────────────────────────────────────────────────

/// Basis-point denominator (100%).
pub const BPS_DENOMINATOR: i128 = 10_000;
/// Discounts can never exceed 50% of the standard fee.
pub const MAX_DISCOUNT_BPS: u32 = 5_000;
/// Upper bound on configured tiers, keeps lookups cheap.
pub const MAX_TIERS: u32 = 10;
/// Largest supported token decimals (10^18 fits comfortably in i128).
const MAX_DECIMALS: u32 = 18;

const TTL_THRESHOLD: u32 = 518_400;
const TTL_EXTEND_TO: u32 = 1_036_800;

// ── Staking interface ────────────────────────────────────────────────────────

/// Interface the staking contract must expose.
#[contractclient(name = "StakingClient")]
pub trait StakingInterface {
    /// Returns the amount of tokens `user` currently has staked.
    fn staked_balance(env: Env, user: Address) -> i128;
}

// ── Error types ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum FeeTierError {
    /// Contract is already initialised.
    AlreadyInitialised = 1,
    /// Contract has not been initialised yet.
    NotInitialised = 2,
    /// Tier list is empty, too long, unordered or exceeds the max discount.
    InvalidTiers = 3,
    /// Standard fee must not be negative.
    InvalidFee = 4,
    /// Token decimals out of supported range.
    InvalidDecimals = 5,
}

// ── Types & storage ──────────────────────────────────────────────────────────

/// A discount tier: holders with at least `min_stake` staked get
/// `discount_bps` off the standard fee.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Tier {
    pub min_stake: i128,
    pub discount_bps: u32,
}

/// Result of applying a user's tier to a standard fee.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeQuote {
    /// 1-based tier number; 0 when the user qualifies for no tier.
    pub tier: u32,
    pub discount_bps: u32,
    pub standard_fee: i128,
    pub discount: i128,
    /// Fee to charge: `standard_fee - discount`.
    pub fee: i128,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Staking,
    Tiers,
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct FeeTierContract;

#[contractimpl]
impl FeeTierContract {
    /// Initialise with the default 10% / 25% / 50% tiers at 1k / 5k / 10k
    /// whole tokens, scaled by the staking token's `decimals`.
    pub fn initialize(
        env: Env,
        admin: Address,
        staking_contract: Address,
        decimals: u32,
    ) -> Result<(), FeeTierError> {
        admin.require_auth();

        if env.storage().instance().has(&DataKey::Admin) {
            return Err(FeeTierError::AlreadyInitialised);
        }
        if decimals > MAX_DECIMALS {
            return Err(FeeTierError::InvalidDecimals);
        }

        let unit = 10i128.pow(decimals);
        let tiers = vec![
            &env,
            Tier {
                min_stake: 1_000 * unit,
                discount_bps: 1_000,
            },
            Tier {
                min_stake: 5_000 * unit,
                discount_bps: 2_500,
            },
            Tier {
                min_stake: 10_000 * unit,
                discount_bps: 5_000,
            },
        ];

        let storage = env.storage().instance();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Staking, &staking_contract);
        storage.set(&DataKey::Tiers, &tiers);
        storage.extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }

    /// Replace the tier table. Tiers must be sorted by strictly increasing
    /// `min_stake` and `discount_bps`, with discounts capped at 50%.
    pub fn set_tiers(env: Env, tiers: Vec<Tier>) -> Result<(), FeeTierError> {
        Self::require_admin(&env)?;
        validate_tiers(&tiers)?;
        env.storage().instance().set(&DataKey::Tiers, &tiers);
        Ok(())
    }

    /// Point the contract at a different staking contract.
    pub fn set_staking_contract(env: Env, staking_contract: Address) -> Result<(), FeeTierError> {
        Self::require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::Staking, &staking_contract);
        Ok(())
    }

    /// Current tier table.
    pub fn get_tiers(env: Env) -> Result<Vec<Tier>, FeeTierError> {
        Self::tiers(&env)
    }

    /// Staking contract queried for balances.
    pub fn get_staking_contract(env: Env) -> Result<Address, FeeTierError> {
        env.storage()
            .instance()
            .get(&DataKey::Staking)
            .ok_or(FeeTierError::NotInitialised)
    }

    /// `user`'s staked balance as reported by the staking contract.
    pub fn get_staked_balance(env: Env, user: Address) -> Result<i128, FeeTierError> {
        let staking = Self::get_staking_contract(env.clone())?;
        Ok(StakingClient::new(&env, &staking).staked_balance(&user))
    }

    /// 1-based tier `user` qualifies for, or 0 for none.
    pub fn get_tier(env: Env, user: Address) -> Result<u32, FeeTierError> {
        let (tier, _) = Self::resolve(&env, &user)?;
        Ok(tier)
    }

    /// Discount in basis points `user` qualifies for.
    pub fn get_discount_bps(env: Env, user: Address) -> Result<u32, FeeTierError> {
        let (_, bps) = Self::resolve(&env, &user)?;
        Ok(bps)
    }

    /// Apply `user`'s discount to `standard_fee` and return the breakdown.
    pub fn quote(env: Env, user: Address, standard_fee: i128) -> Result<FeeQuote, FeeTierError> {
        if standard_fee < 0 {
            return Err(FeeTierError::InvalidFee);
        }
        let (tier, discount_bps) = Self::resolve(&env, &user)?;
        // Floor the discount so rounding never undercharges the protocol.
        let discount = standard_fee * discount_bps as i128 / BPS_DENOMINATOR;
        Ok(FeeQuote {
            tier,
            discount_bps,
            standard_fee,
            discount,
            fee: standard_fee - discount,
        })
    }

    /// Discounted fee to charge `user` in place of `standard_fee`.
    pub fn discounted_fee(
        env: Env,
        user: Address,
        standard_fee: i128,
    ) -> Result<i128, FeeTierError> {
        Ok(Self::quote(env, user, standard_fee)?.fee)
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    fn require_admin(env: &Env) -> Result<(), FeeTierError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(FeeTierError::NotInitialised)?;
        admin.require_auth();
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(())
    }

    fn tiers(env: &Env) -> Result<Vec<Tier>, FeeTierError> {
        env.storage()
            .instance()
            .get(&DataKey::Tiers)
            .ok_or(FeeTierError::NotInitialised)
    }

    /// Returns `(tier_number, discount_bps)` for `user`.
    fn resolve(env: &Env, user: &Address) -> Result<(u32, u32), FeeTierError> {
        let tiers = Self::tiers(env)?;
        let staked = Self::get_staked_balance(env.clone(), user.clone())?;
        Ok(tier_for_stake(&tiers, staked))
    }
}

/// Highest tier whose threshold `staked` meets. Tiers are sorted ascending.
fn tier_for_stake(tiers: &Vec<Tier>, staked: i128) -> (u32, u32) {
    let mut result = (0, 0);
    for (i, tier) in tiers.iter().enumerate() {
        if staked >= tier.min_stake {
            result = (i as u32 + 1, tier.discount_bps);
        } else {
            break;
        }
    }
    result
}

fn validate_tiers(tiers: &Vec<Tier>) -> Result<(), FeeTierError> {
    if tiers.is_empty() || tiers.len() > MAX_TIERS {
        return Err(FeeTierError::InvalidTiers);
    }
    let mut prev: Option<Tier> = None;
    for tier in tiers.iter() {
        if tier.min_stake <= 0 || tier.discount_bps == 0 || tier.discount_bps > MAX_DISCOUNT_BPS {
            return Err(FeeTierError::InvalidTiers);
        }
        if let Some(p) = prev {
            if tier.min_stake <= p.min_stake || tier.discount_bps <= p.discount_bps {
                return Err(FeeTierError::InvalidTiers);
            }
        }
        prev = Some(tier);
    }
    Ok(())
}

// ── Test utilities ───────────────────────────────────────────────────────────

/// Mock staking contract for local testing (also used by the bridge tests).
#[cfg(any(test, feature = "testutils"))]
pub mod mock {
    use soroban_sdk::{contract, contractimpl, Address, Env};

    #[contract]
    pub struct MockStaking;

    #[contractimpl]
    impl MockStaking {
        pub fn set_stake(env: Env, user: Address, amount: i128) {
            env.storage().persistent().set(&user, &amount);
        }

        pub fn staked_balance(env: Env, user: Address) -> i128 {
            env.storage().persistent().get(&user).unwrap_or(0)
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::mock::{MockStaking, MockStakingClient};
    use super::*;
    use soroban_sdk::testutils::Address as _;

    const DECIMALS: u32 = 7;
    const UNIT: i128 = 10_000_000;

    struct Setup {
        env: Env,
        staking: MockStakingClient<'static>,
        client: FeeTierContractClient<'static>,
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let staking_id = env.register(MockStaking, ());
        let staking = MockStakingClient::new(&env, &staking_id);

        let contract_id = env.register(FeeTierContract, ());
        let client = FeeTierContractClient::new(&env, &contract_id);
        client.initialize(&admin, &staking_id, &DECIMALS);

        Setup {
            env,
            staking,
            client,
        }
    }

    fn user_with_stake(s: &Setup, amount: i128) -> Address {
        let user = Address::generate(&s.env);
        s.staking.set_stake(&user, &amount);
        user
    }

    #[test]
    fn test_default_tiers() {
        let s = setup();
        let tiers = s.client.get_tiers();
        assert_eq!(tiers.len(), 3);
        assert_eq!(
            tiers.get(0).unwrap(),
            Tier {
                min_stake: 1_000 * UNIT,
                discount_bps: 1_000
            }
        );
        assert_eq!(
            tiers.get(2).unwrap(),
            Tier {
                min_stake: 10_000 * UNIT,
                discount_bps: 5_000
            }
        );
    }

    #[test]
    fn test_initialize_twice_fails() {
        let s = setup();
        let result =
            s.client
                .try_initialize(&Address::generate(&s.env), &s.staking.address, &DECIMALS);
        assert_eq!(result, Err(Ok(FeeTierError::AlreadyInitialised)));
    }

    #[test]
    fn test_initialize_rejects_excessive_decimals() {
        let env = Env::default();
        env.mock_all_auths();
        let client = FeeTierContractClient::new(&env, &env.register(FeeTierContract, ()));
        let result = client.try_initialize(&Address::generate(&env), &Address::generate(&env), &19);
        assert_eq!(result, Err(Ok(FeeTierError::InvalidDecimals)));
    }

    #[test]
    fn test_queries_staking_contract() {
        let s = setup();
        let user = user_with_stake(&s, 1_234 * UNIT);
        assert_eq!(s.client.get_staked_balance(&user), 1_234 * UNIT);
    }

    #[test]
    fn test_tier_thresholds() {
        let s = setup();
        let cases: [(i128, u32, u32); 9] = [
            (0, 0, 0),
            (1_000 * UNIT - 1, 0, 0),
            (1_000 * UNIT, 1, 1_000),
            (5_000 * UNIT - 1, 1, 1_000),
            (5_000 * UNIT, 2, 2_500),
            (10_000 * UNIT - 1, 2, 2_500),
            (10_000 * UNIT, 3, 5_000),
            (1_000_000 * UNIT, 3, 5_000),
            (-5, 0, 0),
        ];
        for (stake, tier, bps) in cases {
            let user = user_with_stake(&s, stake);
            assert_eq!(s.client.get_tier(&user), tier, "stake {stake}");
            assert_eq!(s.client.get_discount_bps(&user), bps, "stake {stake}");
        }
    }

    #[test]
    fn test_quote_applies_discount() {
        let s = setup();
        let standard_fee = 1_000_000;

        let none = user_with_stake(&s, 0);
        assert_eq!(s.client.discounted_fee(&none, &standard_fee), 1_000_000);

        let tier1 = user_with_stake(&s, 1_000 * UNIT);
        assert_eq!(
            s.client.quote(&tier1, &standard_fee),
            FeeQuote {
                tier: 1,
                discount_bps: 1_000,
                standard_fee,
                discount: 100_000,
                fee: 900_000,
            }
        );

        let tier2 = user_with_stake(&s, 5_000 * UNIT);
        assert_eq!(s.client.discounted_fee(&tier2, &standard_fee), 750_000);

        let tier3 = user_with_stake(&s, 10_000 * UNIT);
        assert_eq!(s.client.discounted_fee(&tier3, &standard_fee), 500_000);
    }

    #[test]
    fn test_quote_rounds_in_protocol_favour() {
        let s = setup();
        let tier1 = user_with_stake(&s, 1_000 * UNIT);
        // 10% of 19 = 1.9 → discount floored to 1, fee 18.
        let q = s.client.quote(&tier1, &19);
        assert_eq!((q.discount, q.fee), (1, 18));
    }

    #[test]
    fn test_quote_rejects_negative_fee() {
        let s = setup();
        let user = user_with_stake(&s, 0);
        assert_eq!(
            s.client.try_quote(&user, &-1),
            Err(Ok(FeeTierError::InvalidFee))
        );
    }

    #[test]
    fn test_set_tiers() {
        let s = setup();
        let tiers = vec![
            &s.env,
            Tier {
                min_stake: 100,
                discount_bps: 500,
            },
            Tier {
                min_stake: 200,
                discount_bps: 4_000,
            },
        ];
        s.client.set_tiers(&tiers);
        assert_eq!(s.client.get_tiers(), tiers);

        let user = user_with_stake(&s, 150);
        assert_eq!(s.client.get_tier(&user), 1);
        assert_eq!(s.client.discounted_fee(&user, &1_000), 950);
    }

    #[test]
    fn test_set_tiers_rejects_invalid_tables() {
        let s = setup();
        let t = |min_stake: i128, discount_bps: u32| Tier {
            min_stake,
            discount_bps,
        };
        let invalid = [
            Vec::new(&s.env),
            // discount above 50%
            vec![&s.env, t(100, 5_001)],
            // zero discount
            vec![&s.env, t(100, 0)],
            // non-positive threshold
            vec![&s.env, t(0, 1_000)],
            // thresholds not ascending
            vec![&s.env, t(200, 1_000), t(100, 2_000)],
            // discounts not ascending
            vec![&s.env, t(100, 2_000), t(200, 1_000)],
        ];
        for tiers in invalid {
            assert_eq!(
                s.client.try_set_tiers(&tiers),
                Err(Ok(FeeTierError::InvalidTiers))
            );
        }

        let mut too_many = Vec::new(&s.env);
        for i in 1..=(MAX_TIERS + 1) {
            too_many.push_back(t(i as i128, i * 100));
        }
        assert_eq!(
            s.client.try_set_tiers(&too_many),
            Err(Ok(FeeTierError::InvalidTiers))
        );
    }

    #[test]
    #[should_panic]
    fn test_set_tiers_requires_admin_auth() {
        let s = setup();
        s.env.set_auths(&[]);
        s.client.set_tiers(&vec![
            &s.env,
            Tier {
                min_stake: 1,
                discount_bps: 1,
            },
        ]);
    }

    #[test]
    fn test_set_staking_contract() {
        let s = setup();
        let other_id = s.env.register(MockStaking, ());
        let other = MockStakingClient::new(&s.env, &other_id);
        let user = user_with_stake(&s, 0);
        other.set_stake(&user, &(10_000 * UNIT));

        assert_eq!(s.client.get_tier(&user), 0);
        s.client.set_staking_contract(&other_id);
        assert_eq!(s.client.get_staking_contract(), other_id);
        assert_eq!(s.client.get_tier(&user), 3);
    }

    #[test]
    fn test_uninitialised_queries_fail() {
        let env = Env::default();
        let client = FeeTierContractClient::new(&env, &env.register(FeeTierContract, ()));
        let user = Address::generate(&env);
        assert_eq!(
            client.try_get_tier(&user),
            Err(Ok(FeeTierError::NotInitialised))
        );
    }
}
