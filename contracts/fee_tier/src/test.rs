extern crate std;

use super::mock::{MockStaking, MockStakingClient};
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    xdr::{ContractEventBody, ScMap, ScVal},
    Address, Env, Vec,
};

const DECIMALS: u32 = 7;
const UNIT: i128 = 10_000_000;
const DAY: u64 = 24 * 60 * 60;
const T0: u64 = 1_000_000;

struct Setup {
    env: Env,
    staking: MockStakingClient<'static>,
    client: FeeTierContractClient<'static>,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);

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

fn user(s: &Setup) -> Address {
    Address::generate(&s.env)
}

fn point(volume: i128, discount_bps: u32) -> CurvePoint {
    CurvePoint {
        volume,
        discount_bps,
    }
}

/// Extract the `effective_fee_bps` field from a `fee_tier_updated` event.
fn effective_fee_bps_in_last_event(env: &Env) -> Option<u32> {
    let events = env.events().all();
    let event = events.events().last()?;
    let ContractEventBody::V0(body) = &event.body;
    let ScVal::Map(Some(ScMap(entries))) = &body.data else {
        return None;
    };
    entries
        .iter()
        .find_map(|entry| match (&entry.key, &entry.val) {
            (ScVal::Symbol(key), ScVal::U32(value)) if key.0.as_slice() == b"effective_fee_bps" => {
                Some(*value)
            }
            _ => None,
        })
}

// ── Volume curve ─────────────────────────────────────────────────────────────

#[test]
fn test_default_curve_interpolates_linearly() {
    let s = setup();
    let user = user(&s);
    let cases: [(i128, u32); 5] = [
        (0, 0),
        (500 * UNIT, 250),
        (1_000 * UNIT, 500),
        // Halfway between 1k (5%) and 10k (20%) is 12.5%.
        (5_500 * UNIT, 1_250),
        (10_000 * UNIT, 2_000),
    ];
    for (volume, expected) in cases {
        s.client.record_volume(&user, &volume);
        assert_eq!(s.client.get_volume(&user), volume);
        let quote = s.client.quote(&user, &10_000);
        assert_eq!(
            quote.discount_bps, expected,
            "volume {volume} should give {expected} bps"
        );
    }
}

#[test]
fn test_volume_discount_flat_past_last_breakpoint_and_capped() {
    let s = setup();
    let user = user(&s);
    s.client.record_volume(&user, &(100_000 * UNIT));
    assert_eq!(s.client.get_discount_bps(&user), 0);
    assert_eq!(s.client.quote(&user, &1_000_000).discount_bps, 6_000);

    // Enormous volume must not overflow and stays at the cap.
    s.client.record_volume(&user, &i128::MAX);
    assert_eq!(s.client.quote(&user, &1_000_000).discount_bps, 6_000);
}

#[test]
fn test_zero_volume_gives_no_discount() {
    let s = setup();
    let user = user(&s);
    s.client.record_volume(&user, &0);
    let quote = s.client.quote(&user, &1_000_000);
    assert_eq!(quote.discount_bps, 0);
    assert_eq!(quote.fee, 1_000_000);
}

#[test]
fn test_set_volume_curve_is_used_for_quotes() {
    let s = setup();
    let user = user(&s);
    s.client.set_volume_curve(&vec![&s.env, point(100, 3_000)]);
    assert_eq!(s.client.get_volume_curve().len(), 1);

    s.client.record_volume(&user, &50);
    // Halfway along a 0 -> 100 volume segment ending at 30%.
    assert_eq!(s.client.quote(&user, &10_000).discount_bps, 1_500);
}

#[test]
fn test_set_volume_curve_rejects_invalid_points() {
    let s = setup();
    let invalid: [Vec<CurvePoint>; 6] = [
        Vec::new(&s.env),
        // volume must be strictly positive and increasing
        vec![&s.env, point(0, 500)],
        vec![&s.env, point(200, 500), point(100, 1_000)],
        // discount may not decrease
        vec![&s.env, point(100, 2_000), point(200, 1_000)],
        // zero discount
        vec![&s.env, point(100, 0)],
        // above the global cap
        vec![&s.env, point(100, MAX_TOTAL_DISCOUNT_BPS + 1)],
    ];
    for points in invalid {
        assert_eq!(
            s.client.try_set_volume_curve(&points),
            Err(Ok(FeeTierError::InvalidCurve))
        );
    }

    let mut too_many = Vec::new(&s.env);
    for i in 1..=(MAX_CURVE_POINTS + 1) {
        too_many.push_back(point(i as i128 * 10, 100));
    }
    assert_eq!(
        s.client.try_set_volume_curve(&too_many),
        Err(Ok(FeeTierError::InvalidCurve))
    );
}

#[test]
#[should_panic]
fn test_set_volume_curve_requires_admin_auth() {
    let s = setup();
    s.env.set_auths(&[]);
    s.client.set_volume_curve(&vec![&s.env, point(100, 1_000)]);
}

// ── Recording volume ─────────────────────────────────────────────────────────

#[test]
fn test_record_volume_rejects_negative() {
    let s = setup();
    let user = user(&s);
    assert_eq!(
        s.client.try_record_volume(&user, &-1),
        Err(Ok(FeeTierError::InvalidVolume))
    );
    assert_eq!(s.client.get_volume(&user), 0);
}

#[test]
#[should_panic]
fn test_record_volume_requires_admin_auth() {
    let s = setup();
    let user = user(&s);
    s.env.set_auths(&[]);
    s.client.record_volume(&user, &1_000);
}

#[test]
fn test_record_volume_emits_fee_tier_updated() {
    let s = setup();
    let user = user(&s);
    s.client.record_volume(&user, &(10_000 * UNIT));

    let events = s.env.events().all();
    assert_eq!(events.events().len(), 1);
    // Held discount is 20%, so the fee is 80% of standard (8_000 bps).
    assert_eq!(effective_fee_bps_in_last_event(&s.env), Some(8_000));
}

#[test]
fn test_upgrade_applies_immediately_without_grace() {
    let s = setup();
    let user = user(&s);
    s.client.record_volume(&user, &(1_000 * UNIT));
    assert_eq!(s.client.get_tier_state(&user).unwrap().held_tier, 1);

    s.client.record_volume(&user, &(100_000 * UNIT));
    let state = s.client.get_tier_state(&user).unwrap();
    assert_eq!(state.held_tier, 4);
    assert_eq!(state.held_discount_bps, 6_000);
    assert_eq!(state.grace_period_expires_at, 0);
    assert_eq!(state.tier_evaluated_at, T0);
}

#[test]
fn test_quote_uses_larger_of_stake_and_volume_discounts() {
    let s = setup();
    let staked_only = user(&s);
    s.staking.set_stake(&staked_only, &(10_000 * UNIT));
    // Stake gives tier 3 (50%); no volume recorded.
    assert_eq!(s.client.quote(&staked_only, &1_000_000).discount_bps, 5_000);

    let volume_only = user(&s);
    s.client.record_volume(&volume_only, &(50_000 * UNIT));
    // No stake; volume gives 40%.
    assert_eq!(s.client.quote(&volume_only, &1_000_000).discount_bps, 4_000);

    let both = user(&s);
    s.staking.set_stake(&both, &(10_000 * UNIT));
    s.client.record_volume(&both, &(100_000 * UNIT));
    // Volume (60%) beats stake (50%); the combined discount is capped at 60%.
    let quote = s.client.quote(&both, &1_000_000);
    assert_eq!(quote.discount_bps, 6_000);
    assert_eq!(quote.fee, 400_000);
}

// ── Grace period ─────────────────────────────────────────────────────────────

#[test]
fn test_drop_starts_grace_and_keeps_held_rate() {
    let s = setup();
    let user = user(&s);
    s.client.record_volume(&user, &(100_000 * UNIT));

    s.client.record_volume(&user, &0);
    let state = s.client.get_tier_state(&user).unwrap();
    assert_eq!(state.held_tier, 4);
    assert_eq!(state.grace_period_expires_at, T0 + GRACE_PERIOD_SECS);
    assert_eq!(state.tier_evaluated_at, T0);

    // Still inside the grace period: preferential 60% rate applies.
    s.env.ledger().set_timestamp(T0 + 6 * DAY);
    assert_eq!(s.client.quote(&user, &1_000_000).discount_bps, 6_000);
}

#[test]
fn test_grace_lapse_demotes_on_next_evaluation() {
    let s = setup();
    let user = user(&s);
    s.client.record_volume(&user, &(100_000 * UNIT));
    s.client.record_volume(&user, &0);

    s.env.ledger().set_timestamp(T0 + GRACE_PERIOD_SECS + DAY);
    // Demotion is visible to quotes as soon as the grace period has passed.
    assert_eq!(s.client.quote(&user, &1_000_000).discount_bps, 0);

    assert_eq!(s.client.evaluate_tier(&user), 0);
    let state = s.client.get_tier_state(&user).unwrap();
    assert_eq!(state.held_tier, 0);
    assert_eq!(state.held_discount_bps, 0);
    assert_eq!(state.grace_period_expires_at, 0);
    assert_eq!(state.tier_evaluated_at, T0 + GRACE_PERIOD_SECS + DAY);
}

#[test]
fn test_grace_expiry_boundary_is_exclusive() {
    let s = setup();
    let user = user(&s);
    s.client.record_volume(&user, &(100_000 * UNIT));
    s.client.record_volume(&user, &0);

    s.env.ledger().set_timestamp(T0 + GRACE_PERIOD_SECS - 1);
    assert_eq!(s.client.quote(&user, &1_000_000).discount_bps, 6_000);

    s.env.ledger().set_timestamp(T0 + GRACE_PERIOD_SECS);
    assert_eq!(s.client.quote(&user, &1_000_000).discount_bps, 0);
}

#[test]
fn test_repeated_drops_do_not_extend_grace() {
    let s = setup();
    let user = user(&s);
    s.client.record_volume(&user, &(100_000 * UNIT));
    s.client.record_volume(&user, &0);

    s.env.ledger().set_timestamp(T0 + 3 * DAY);
    s.client.record_volume(&user, &0);
    let state = s.client.get_tier_state(&user).unwrap();
    assert_eq!(state.grace_period_expires_at, T0 + GRACE_PERIOD_SECS);
    assert_eq!(state.tier_evaluated_at, T0 + 3 * DAY);
}

#[test]
fn test_recovery_during_grace_cancels_it() {
    let s = setup();
    let user = user(&s);
    s.client.record_volume(&user, &(100_000 * UNIT));
    s.client.record_volume(&user, &0);

    s.env.ledger().set_timestamp(T0 + DAY);
    s.client.record_volume(&user, &(100_000 * UNIT));
    let state = s.client.get_tier_state(&user).unwrap();
    assert_eq!(state.held_tier, 4);
    assert_eq!(state.grace_period_expires_at, 0);

    // Later drops start a fresh grace period from the new evaluation time.
    s.env.ledger().set_timestamp(T0 + 2 * DAY);
    s.client.record_volume(&user, &0);
    let state = s.client.get_tier_state(&user).unwrap();
    assert_eq!(
        state.grace_period_expires_at,
        T0 + 2 * DAY + GRACE_PERIOD_SECS
    );
}

#[test]
fn test_partial_drop_holds_higher_rate_then_settles_lower() {
    let s = setup();
    let user = user(&s);
    s.client.record_volume(&user, &(100_000 * UNIT));

    // Fall from tier 4 (60%) to tier 2 (20%).
    s.client.record_volume(&user, &(10_000 * UNIT));
    let state = s.client.get_tier_state(&user).unwrap();
    assert_eq!(state.held_tier, 4);
    assert_eq!(s.client.quote(&user, &1_000_000).discount_bps, 6_000);

    s.env.ledger().set_timestamp(T0 + GRACE_PERIOD_SECS);
    assert_eq!(s.client.evaluate_tier(&user), 2);
    assert_eq!(s.client.quote(&user, &1_000_000).discount_bps, 2_000);
}

#[test]
fn test_grace_does_not_outlive_staking_only_discount() {
    let s = setup();
    let user = user(&s);
    s.staking.set_stake(&user, &(5_000 * UNIT));
    s.client.record_volume(&user, &(100_000 * UNIT));
    s.client.record_volume(&user, &0);

    // Staking tier (25%) still applies after grace lapses.
    s.env.ledger().set_timestamp(T0 + GRACE_PERIOD_SECS + 1);
    assert_eq!(s.client.quote(&user, &1_000_000).discount_bps, 2_500);
}
