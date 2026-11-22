# Contracts

## Snapshot Testing

This workspace uses Soroban SDK's built-in test snapshots to prevent unintentional regressions in emitted events and ledger storage keys. 

When you run tests, the SDK automatically records the state of the `Env` and saves it to JSON files in the `test_snapshots/` directory of each contract.

### Updating Snapshots

If you intentionally change a contract's emitted events or storage schema, the test snapshots will change. To update the snapshots, simply run the tests locally:

```bash
cargo test --workspace
```

Then, commit the updated `.json` files in the `test_snapshots/` directories to your branch.

```bash
git add "*/test_snapshots/*"
git commit -m "Update test snapshots"
```

The CI workflow will automatically verify that the snapshots match the committed schemas and will fail if there are uncommitted changes.

## Contracts

| Crate       | Purpose |
|-------------|---------|
| `blacklist` | Admin-managed registry of flagged wallets. Emits `["blacklist", "added", address]` with the reason. Other contracts call `is_blacklisted` / `ensure_not_blacklisted` before deposits and withdrawals. |
| `fee_tier`  | Staking-based fee discounts. Reads `staked_balance(user)` from the staking contract. Default tiers: 1k tokens = 10% off, 5k = 25%, 10k = 50%. Admins can change them with `set_tiers`, capped at 50%. |
| `bridge`    | Deposits and admin-settled off-ramps. Checks the optional blacklist in both directions and applies the optional fee-tier discount at settlement. Admin rights move in two steps: `propose_admin`, then `accept_admin` by the new admin after a 24h delay. The current admin can cancel before acceptance with `revoke_admin_proposal`. |

## Deployment

`scripts/deployContracts.ts` builds and optimises every contract with `stellar contract build --optimize`. It then uploads each WASM, deploys the contracts, and runs their `init` and `setup` invocations with the admin key.

```bash
cp config/contracts.example.json config/contracts.json   # adjust as needed
export STELLAR_ADMIN_SOURCE=admin          # stellar keys identity or secret key
export STAKING_CONTRACT_ID=C...            # used by fee_tier's initialize

npm run contracts:deploy -- --network testnet --dry-run   # print the commands only
npm run contracts:deploy -- --network testnet
npm run contracts:deploy -- --network mainnet --yes       # mainnet requires --yes
```

Contract IDs and WASM hashes are written to `contracts.json`, keyed by network. The file is saved after every step. If a run fails partway through, re-run the same command: deployed and initialised contracts are skipped. Use `--force` to redeploy and `--only a,b` to limit the run to specific contracts.
