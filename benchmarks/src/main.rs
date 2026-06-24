use std::collections::BTreeMap;
use std::fs;
use serde::Serialize;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, Env, BytesN,
};

use escrow::{EscrowContract, EscrowContractClient};
use htlc::{HtlcContract, HtlcContractClient};

#[derive(Serialize)]
struct GasMetrics {
    cpu_instructions: u64,
    memory_bytes: u64,
}

#[derive(Serialize)]
struct BenchmarkReport {
    escrow: BTreeMap<String, GasMetrics>,
    htlc: BTreeMap<String, GasMetrics>,
}

fn main() {
    println!("🚀 Running Soroban smart contracts gas benchmark...");

    let mut report = BenchmarkReport {
        escrow: BTreeMap::new(),
        htlc: BTreeMap::new(),
    };

    // --- ESCROW CONTRACT BENCHMARKS ---
    {
        // 1. initialize
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup_escrow();
        let cpu_start = env.budget().cpu_instruction_cost();
        let mem_start = env.budget().memory_byte_cost();
        client.initialize(
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            &500_000,
            &1_000, // emergency_unlock_timestamp
            &100, // lock_until_ledger
            &250, // fee_bps
            &fee_recipient,
        );
        let cpu_end = env.budget().cpu_instruction_cost();
        let mem_end = env.budget().memory_byte_cost();
        report.escrow.insert(
            "initialize".to_string(),
            GasMetrics {
                cpu_instructions: cpu_end - cpu_start,
                memory_bytes: mem_end - mem_start,
            },
        );

        // 2. release
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup_escrow();
        client.initialize(
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            &500_000,
            &1_000,
            &100,
            &250,
            &fee_recipient,
        );
        let cpu_start = env.budget().cpu_instruction_cost();
        let mem_start = env.budget().memory_byte_cost();
        client.release();
        let cpu_end = env.budget().cpu_instruction_cost();
        let mem_end = env.budget().memory_byte_cost();
        report.escrow.insert(
            "release".to_string(),
            GasMetrics {
                cpu_instructions: cpu_end - cpu_start,
                memory_bytes: mem_end - mem_start,
            },
        );

        // 3. refund
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup_escrow();
        client.initialize(
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            &500_000,
            &1_000,
            &100,
            &250,
            &fee_recipient,
        );
        let cpu_start = env.budget().cpu_instruction_cost();
        let mem_start = env.budget().memory_byte_cost();
        client.refund();
        let cpu_end = env.budget().cpu_instruction_cost();
        let mem_end = env.budget().memory_byte_cost();
        report.escrow.insert(
            "refund".to_string(),
            GasMetrics {
                cpu_instructions: cpu_end - cpu_start,
                memory_bytes: mem_end - mem_start,
            },
        );

        // 4. emergency_refund
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup_escrow();
        client.initialize(
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            &500_000,
            &1_000,
            &100,
            &250,
            &fee_recipient,
        );
        env.ledger().set_timestamp(1_000);
        let cpu_start = env.budget().cpu_instruction_cost();
        let mem_start = env.budget().memory_byte_cost();
        client.emergency_refund();
        let cpu_end = env.budget().cpu_instruction_cost();
        let mem_end = env.budget().memory_byte_cost();
        report.escrow.insert(
            "emergency_refund".to_string(),
            GasMetrics {
                cpu_instructions: cpu_end - cpu_start,
                memory_bytes: mem_end - mem_start,
            },
        );

        // 5. self_refund
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup_escrow();
        client.initialize(
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            &500_000,
            &1_000,
            &100,
            &250,
            &fee_recipient,
        );
        env.ledger().update(|info| {
            info.sequence = 101;
        });
        let cpu_start = env.budget().cpu_instruction_cost();
        let mem_start = env.budget().memory_byte_cost();
        client.self_refund();
        let cpu_end = env.budget().cpu_instruction_cost();
        let mem_end = env.budget().memory_byte_cost();
        report.escrow.insert(
            "self_refund".to_string(),
            GasMetrics {
                cpu_instructions: cpu_end - cpu_start,
                memory_bytes: mem_end - mem_start,
            },
        );

        // 6. get_state
        let (env, depositor, beneficiary, arbiter, fee_recipient, token, client) = setup_escrow();
        client.initialize(
            &depositor,
            &beneficiary,
            &arbiter,
            &token,
            &500_000,
            &1_000,
            &100,
            &250,
            &fee_recipient,
        );
        let cpu_start = env.budget().cpu_instruction_cost();
        let mem_start = env.budget().memory_byte_cost();
        client.get_state();
        let cpu_end = env.budget().cpu_instruction_cost();
        let mem_end = env.budget().memory_byte_cost();
        report.escrow.insert(
            "get_state".to_string(),
            GasMetrics {
                cpu_instructions: cpu_end - cpu_start,
                memory_bytes: mem_end - mem_start,
            },
        );
    }

    // --- HTLC CONTRACT BENCHMARKS ---
    {
        // 1. initialize
        let (env, sender, receiver, token, client) = setup_htlc();
        let preimage = BytesN::from_array(&env, &[1; 32]);
        let hashlock = env.crypto().sha256(&preimage.into()).into();
        let cpu_start = env.budget().cpu_instruction_cost();
        let mem_start = env.budget().memory_byte_cost();
        client.initialize(&sender, &receiver, &token, &500_000, &hashlock, &1_000);
        let cpu_end = env.budget().cpu_instruction_cost();
        let mem_end = env.budget().memory_byte_cost();
        report.htlc.insert(
            "initialize".to_string(),
            GasMetrics {
                cpu_instructions: cpu_end - cpu_start,
                memory_bytes: mem_end - mem_start,
            },
        );

        // 2. claim
        let (env, sender, receiver, token, client) = setup_htlc();
        let preimage = BytesN::from_array(&env, &[1; 32]);
        let hashlock = env.crypto().sha256(&preimage.clone().into()).into();
        client.initialize(&sender, &receiver, &token, &500_000, &hashlock, &1_000);
        let cpu_start = env.budget().cpu_instruction_cost();
        let mem_start = env.budget().memory_byte_cost();
        client.claim(&preimage);
        let cpu_end = env.budget().cpu_instruction_cost();
        let mem_end = env.budget().memory_byte_cost();
        report.htlc.insert(
            "claim".to_string(),
            GasMetrics {
                cpu_instructions: cpu_end - cpu_start,
                memory_bytes: mem_end - mem_start,
            },
        );

        // 3. refund
        let (env, sender, receiver, token, client) = setup_htlc();
        let preimage = BytesN::from_array(&env, &[1; 32]);
        let hashlock = env.crypto().sha256(&preimage.into()).into();
        client.initialize(&sender, &receiver, &token, &500_000, &hashlock, &1_000);
        env.ledger().set_timestamp(1_000);
        let cpu_start = env.budget().cpu_instruction_cost();
        let mem_start = env.budget().memory_byte_cost();
        client.refund();
        let cpu_end = env.budget().cpu_instruction_cost();
        let mem_end = env.budget().memory_byte_cost();
        report.htlc.insert(
            "refund".to_string(),
            GasMetrics {
                cpu_instructions: cpu_end - cpu_start,
                memory_bytes: mem_end - mem_start,
            },
        );

        // 4. get_state
        let (env, sender, receiver, token, client) = setup_htlc();
        let preimage = BytesN::from_array(&env, &[1; 32]);
        let hashlock = env.crypto().sha256(&preimage.into()).into();
        client.initialize(&sender, &receiver, &token, &500_000, &hashlock, &1_000);
        let cpu_start = env.budget().cpu_instruction_cost();
        let mem_start = env.budget().memory_byte_cost();
        client.get_state();
        let cpu_end = env.budget().cpu_instruction_cost();
        let mem_end = env.budget().memory_byte_cost();
        report.htlc.insert(
            "get_state".to_string(),
            GasMetrics {
                cpu_instructions: cpu_end - cpu_start,
                memory_bytes: mem_end - mem_start,
            },
        );
    }

    // Print tables to stdout
    print_table("Escrow Contract", &report.escrow);
    print_table("HTLC Contract", &report.htlc);

    // Save report to file
    let results_dir = "benchmarks/results";
    fs::create_dir_all(results_dir).unwrap();
    let file_path = format!("{}/soroban-gas-report.json", results_dir);
    let json_content = serde_json::to_string_pretty(&report).unwrap();
    fs::write(&file_path, json_content).unwrap();
    println!("\n💾 Saved clean gas figures to {}", file_path);
}

fn setup_escrow() -> (
    Env,
    Address,
    Address,
    Address,
    Address,
    Address,
    EscrowContractClient<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let arbiter = Address::generate(&env);
    let fee_recipient = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    StellarAssetClient::new(&env, &token_id.address()).mint(&depositor, &1_000_000);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    (
        env,
        depositor,
        beneficiary,
        arbiter,
        fee_recipient,
        token_id.address(),
        client,
    )
}

fn setup_htlc() -> (Env, Address, Address, Address, HtlcContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let sender = Address::generate(&env);
    let receiver = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    StellarAssetClient::new(&env, &token_id.address()).mint(&sender, &1_000_000);

    let contract_id = env.register(HtlcContract, ());
    let client = HtlcContractClient::new(&env, &contract_id);

    (env, sender, receiver, token_id.address(), client)
}

fn print_table(title: &str, metrics: &BTreeMap<String, GasMetrics>) {
    println!("\n📊 {} Gas consumption:", title);
    println!("+----------------------+--------------------+--------------------+");
    println!("| {:<20} | {:<18} | {:<18} |", "Method", "CPU Instructions", "Memory Bytes");
    println!("+----------------------+--------------------+--------------------+");
    for (method, metric) in metrics {
        println!(
            "| {:<20} | {:>18} | {:>18} |",
            method,
            metric.cpu_instructions,
            metric.memory_bytes
        );
    }
    println!("+----------------------+--------------------+--------------------+");
}
