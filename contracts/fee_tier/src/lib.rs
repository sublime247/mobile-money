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
//!
//! Merchants can also earn a volume discount. The admin records each user's
//! trailing 30-day volume with [`FeeTierContract::record_volume`], which maps it
//! through a piecewise-linear curve ([`CurvePoint`]) and tracks the result in a
//! [`TierState`]. A demotion is held back for [`GRACE_PERIOD_SECS`] so a
//! temporary dip in volume does not raise the user's fees immediately.

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, vec,
    Address, Env, Vec,
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
/// Ceiling on the combined discount, whether it comes from staking or volume.
pub const MAX_TOTAL_DISCOUNT_BPS: u32 = 6_000;
/// Upper bound on volume curve points.
pub const MAX_CURVE_POINTS: u32 = 10;
/// How long a demoted volume tier keeps its preferential rate (7 days).
pub const GRACE_PERIOD_SECS: u64 = 7 * 24 * 60 * 60;

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
    /// Volume curve is empty, too long, not strictly increasing by volume,
    /// non-monotonic in discount, or exceeds [`MAX_TOTAL_DISCOUNT_BPS`].
    InvalidCurve = 6,
    /// Volume must not be negative.
    InvalidVolume = 7,
    /// Arithmetic overflow while interpolating the volume curve.
    Overflow = 8,
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

/// A breakpoint on the volume discount curve. The curve is anchored at
/// `(0, 0)` and linearly interpolated between breakpoints. Above the last
/// breakpoint the discount stays flat.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CurvePoint {
    /// Trailing 30-day volume at which this discount applies.
    pub volume: i128,
    pub discount_bps: u32,
}

/// Per-user volume tier state. Updated by every evaluation.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TierState {
    /// 1-based volume tier currently held (0 for none).
    pub held_tier: u32,
    /// Discount in basis points granted by the held tier.
    pub held_discount_bps: u32,
    /// Ledger timestamp of the most recent evaluation.
    pub tier_evaluated_at: u64,
    /// When a pending demotion takes effect. 0 when no grace period is running.
    pub grace_period_expires_at: u64,
}

/// Emitted each time a user's volume tier is evaluated.
#[contractevent(topics = ["fee_tier_updated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeTierUpdated {
    /// Account whose tier was evaluated.
    #[topic]
    pub user: Address,
    /// Held volume tier index (0 for none).
    pub tier: u32,
    /// Fee charged in basis points of the standard fee (10,000 = no discount).
    pub effective_fee_bps: u32,
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
    VolumeCurve,
    Volume(Address),
    TierState(Address),
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

        let curve = vec![
            &env,
            CurvePoint {
                volume: 1_000 * unit,
                discount_bps: 500,
            },
            CurvePoint {
                volume: 10_000 * unit,
                discount_bps: 2_000,
            },
            CurvePoint {
                volume: 50_000 * unit,
                discount_bps: 4_000,
            },
            CurvePoint {
                volume: 100_000 * unit,
                discount_bps: 6_000,
            },
        ];

        let storage = env.storage().instance();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Staking, &staking_contract);
        storage.set(&DataKey::Tiers, &tiers);
        storage.set(&DataKey::VolumeCurve, &curve);
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

    /// Replace the volume discount curve. Breakpoints must have strictly
    /// increasing volume, a positive non-decreasing discount, and no discount
    /// above [`MAX_TOTAL_DISCOUNT_BPS`].
    pub fn set_volume_curve(env: Env, points: Vec<CurvePoint>) -> Result<(), FeeTierError> {
        Self::require_admin(&env)?;
        validate_curve(&points)?;
        env.storage().instance().set(&DataKey::VolumeCurve, &points);
        Ok(())
    }

    /// Current volume discount curve.
    pub fn get_volume_curve(env: Env) -> Result<Vec<CurvePoint>, FeeTierError> {
        Self::curve(&env)
    }

    /// Record `user`'s trailing 30-day volume and re-evaluate their tier.
    ///
    /// The contract stores the value as given; the caller is responsible for
    /// computing the 30-day window. Emits [`FeeTierUpdated`].
    pub fn record_volume(env: Env, user: Address, volume: i128) -> Result<(), FeeTierError> {
        Self::require_admin(&env)?;
        if volume < 0 {
            return Err(FeeTierError::InvalidVolume);
        }
        env.storage()
            .instance()
            .set(&DataKey::Volume(user.clone()), &volume);
        Self::evaluate_tier(env, user)?;
        Ok(())
    }

    /// Last recorded trailing volume for `user` (0 when never recorded).
    pub fn get_volume(env: Env, user: Address) -> i128 {
        Self::volume_of(&env, &user)
    }

    /// Stored volume tier state for `user`, if they have been evaluated.
    pub fn get_tier_state(env: Env, user: Address) -> Option<TierState> {
        Self::state_of(&env, &user)
    }

    /// Re-evaluate `user`'s volume tier at the current ledger time.
    ///
    /// Anyone may call this, for example a keeper that wants a lapsed grace
    /// period to be recorded. Returns the held volume tier and emits
    /// [`FeeTierUpdated`].
    pub fn evaluate_tier(env: Env, user: Address) -> Result<u32, FeeTierError> {
        let now = env.ledger().timestamp();
        let curve = Self::curve(&env)?;
        let volume = Self::volume_of(&env, &user);
        let (volume_tier, volume_bps) = tier_for_volume(&curve, volume)?;

        let prev = Self::state_of(&env, &user).unwrap_or(TierState {
            held_tier: 0,
            held_discount_bps: 0,
            tier_evaluated_at: now,
            grace_period_expires_at: 0,
        });
        let next = next_state(prev, volume_tier, volume_bps, now);
        env.storage()
            .instance()
            .set(&DataKey::TierState(user.clone()), &next);

        let effective = Self::effective_volume_bps(&env, &user)?;
        env.events().publish_event(&FeeTierUpdated {
            user,
            tier: next.held_tier,
            effective_fee_bps: BPS_DENOMINATOR as u32 - effective,
        });
        Ok(next.held_tier)
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
    ///
    /// The discount is the larger of the staking tier discount and the volume
    /// discount, capped at [`MAX_TOTAL_DISCOUNT_BPS`].
    pub fn quote(env: Env, user: Address, standard_fee: i128) -> Result<FeeQuote, FeeTierError> {
        if standard_fee < 0 {
            return Err(FeeTierError::InvalidFee);
        }
        let (tier, stake_bps) = Self::resolve(&env, &user)?;
        let volume_bps = Self::effective_volume_bps(&env, &user)?;
        let discount_bps = stake_bps.max(volume_bps).min(MAX_TOTAL_DISCOUNT_BPS);
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

    fn curve(env: &Env) -> Result<Vec<CurvePoint>, FeeTierError> {
        env.storage()
            .instance()
            .get(&DataKey::VolumeCurve)
            .ok_or(FeeTierError::NotInitialised)
    }

    fn volume_of(env: &Env, user: &Address) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::Volume(user.clone()))
            .unwrap_or(0)
    }

    fn state_of(env: &Env, user: &Address) -> Option<TierState> {
        env.storage()
            .instance()
            .get(&DataKey::TierState(user.clone()))
    }

    /// Volume discount in effect for `user` right now. While a grace period is
    /// running the held discount is kept. Once it lapses, the discount comes
    /// from the current volume alone.
    fn effective_volume_bps(env: &Env, user: &Address) -> Result<u32, FeeTierError> {
        if let Some(state) = Self::state_of(env, user) {
            let now = env.ledger().timestamp();
            if state.grace_period_expires_at != 0 && now < state.grace_period_expires_at {
                return Ok(state.held_discount_bps);
            }
        }
        let curve = Self::curve(env)?;
        curve_discount_bps(&curve, Self::volume_of(env, user))
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

/// Piecewise-linear discount for `volume`, interpolated over `curve` with an
/// implicit `(0, 0)` anchor. Rounds down so the protocol never undercharges.
fn curve_discount_bps(curve: &Vec<CurvePoint>, volume: i128) -> Result<u32, FeeTierError> {
    let (mut x0, mut y0): (i128, i128) = (0, 0);
    for point in curve.iter() {
        let (x1, y1) = (point.volume, point.discount_bps as i128);
        if volume < x1 {
            let span = (y1 - y0)
                .checked_mul(volume - x0)
                .ok_or(FeeTierError::Overflow)?;
            return Ok((y0 + span / (x1 - x0)) as u32);
        }
        x0 = x1;
        y0 = y1;
    }
    Ok(y0 as u32)
}

/// Volume tier index (count of breakpoints `volume` has reached) and the
/// discount at that volume.
fn tier_for_volume(curve: &Vec<CurvePoint>, volume: i128) -> Result<(u32, u32), FeeTierError> {
    let tier = curve.iter().filter(|p| volume >= p.volume).count() as u32;
    Ok((tier, curve_discount_bps(curve, volume)?))
}

/// Advance a volume tier state. Upgrades and same-tier evaluations apply at
/// once and cancel any running grace period. A drop starts a grace period,
/// keeps the held rate during it, and demotes once it has lapsed.
fn next_state(prev: TierState, volume_tier: u32, volume_bps: u32, now: u64) -> TierState {
    if volume_tier >= prev.held_tier {
        return TierState {
            held_tier: volume_tier,
            held_discount_bps: volume_bps,
            tier_evaluated_at: now,
            grace_period_expires_at: 0,
        };
    }
    if prev.grace_period_expires_at == 0 {
        return TierState {
            held_tier: prev.held_tier,
            held_discount_bps: prev.held_discount_bps,
            tier_evaluated_at: now,
            grace_period_expires_at: now + GRACE_PERIOD_SECS,
        };
    }
    if now < prev.grace_period_expires_at {
        return TierState {
            tier_evaluated_at: now,
            ..prev
        };
    }
    TierState {
        held_tier: volume_tier,
        held_discount_bps: volume_bps,
        tier_evaluated_at: now,
        grace_period_expires_at: 0,
    }
}

fn validate_curve(points: &Vec<CurvePoint>) -> Result<(), FeeTierError> {
    if points.is_empty() || points.len() > MAX_CURVE_POINTS {
        return Err(FeeTierError::InvalidCurve);
    }
    let (mut prev_volume, mut prev_bps): (i128, u32) = (0, 0);
    for point in points.iter() {
        if point.volume <= prev_volume
            || point.discount_bps == 0
            || point.discount_bps < prev_bps
            || point.discount_bps > MAX_TOTAL_DISCOUNT_BPS
        {
            return Err(FeeTierError::InvalidCurve);
        }
        prev_volume = point.volume;
        prev_bps = point.discount_bps;
    }
    Ok(())
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

#[cfg(test)]
mod test;

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
