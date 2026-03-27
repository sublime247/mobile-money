#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env};

/// Escrow state stored on-chain.
#[contracttype]
#[derive(Clone)]
pub struct EscrowState {
    pub depositor: Address,
    pub beneficiary: Address,
    pub arbiter: Address,
    pub token: Address,
    pub amount: i128,
    pub released: bool,
}

const ESCROW: &str = "ESCROW";

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Initialise the escrow. The depositor must authorise this call and
    /// transfer `amount` tokens into the contract's own account.
    pub fn initialize(
        env: Env,
        depositor: Address,
        beneficiary: Address,
        arbiter: Address,
        token: Address,
        amount: i128,
    ) {
        depositor.require_auth();

        assert!(amount > 0, "amount must be positive");
        assert!(
            !env.storage().instance().has(&ESCROW),
            "already initialised"
        );

        // Pull funds from the depositor into this contract.
        token::Client::new(&env, &token).transfer(&depositor, &env.current_contract_address(), &amount);

        env.storage().instance().set(
            &ESCROW,
            &EscrowState {
                depositor,
                beneficiary,
                arbiter,
                token,
                amount,
                released: false,
            },
        );
    }

    /// Release funds to the beneficiary. Only the arbiter may call this.
    pub fn release(env: Env) {
        let mut state: EscrowState = env.storage().instance().get(&ESCROW).expect("not initialised");

        state.arbiter.require_auth();
        assert!(!state.released, "already released");

        token::Client::new(&env, &state.token)
            .transfer(&env.current_contract_address(), &state.beneficiary, &state.amount);

        state.released = true;
        env.storage().instance().set(&ESCROW, &state);
    }

    /// Refund funds to the depositor. Only the arbiter may call this.
    pub fn refund(env: Env) {
        let mut state: EscrowState = env.storage().instance().get(&ESCROW).expect("not initialised");

        state.arbiter.require_auth();
        assert!(!state.released, "already released");

        token::Client::new(&env, &state.token)
            .transfer(&env.current_contract_address(), &state.depositor, &state.amount);

        state.released = true;
        env.storage().instance().set(&ESCROW, &state);
    }

    /// Return current escrow state (read-only).
    pub fn get_state(env: Env) -> EscrowState {
        env.storage().instance().get(&ESCROW).expect("not initialised")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::Address as _,
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env,
    };

    fn setup() -> (Env, Address, Address, Address, Address, EscrowContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();

        let depositor = Address::generate(&env);
        let beneficiary = Address::generate(&env);
        let arbiter = Address::generate(&env);

        // Deploy a test SAC token.
        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_sac = StellarAssetClient::new(&env, &token_id.address());
        token_sac.mint(&depositor, &1_000_000);

        let contract_id = env.register(EscrowContract, ());
        let client = EscrowContractClient::new(&env, &contract_id);

        (env, depositor, beneficiary, arbiter, token_id.address(), client)
    }

    #[test]
    fn test_initialize_and_release() {
        let (env, depositor, beneficiary, arbiter, token, client) = setup();
        let amount: i128 = 500_000;

        client.initialize(&depositor, &beneficiary, &arbiter, &token, &amount);

        let state = client.get_state();
        assert_eq!(state.amount, amount);
        assert!(!state.released);

        client.release();

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&beneficiary), amount);
        assert!(client.get_state().released);
    }

    #[test]
    fn test_refund() {
        let (env, depositor, beneficiary, arbiter, token, client) = setup();
        let amount: i128 = 200_000;

        client.initialize(&depositor, &beneficiary, &arbiter, &token, &amount);
        client.refund();

        let token_client = TokenClient::new(&env, &token);
        assert_eq!(token_client.balance(&depositor), 1_000_000); // full balance back
        assert!(client.get_state().released);
    }
}
