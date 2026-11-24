/**
 * deployContracts.ts — build, optimise, install, deploy and initialise all
 * Soroban contracts on Stellar Testnet or Mainnet.
 *
 * Pipeline (per network):
 *   1. `stellar contract build --optimize` for every configured contract.
 *   2. `stellar contract upload` each WASM and record its hash.
 *   3. `stellar contract deploy` a new instance (skipped for `installOnly`).
 *   4. `stellar contract invoke` the `init` call, then any `setup` calls,
 *      using the admin key as the source account.
 *
 * Results are written to `contracts.json` (keyed by network) after every
 * step, so a failed run can simply be re-run: contracts that are already
 * deployed / initialised are skipped unless `--force` is passed.
 *
 * Usage:
 *   STELLAR_ADMIN_SOURCE=admin npm run contracts:deploy -- --network testnet
 *   npm run contracts:deploy -- --network mainnet --yes
 *   npm run contracts:deploy -- --network testnet --only blacklist,bridge
 *   npm run contracts:deploy -- --network testnet --dry-run
 *
 * The admin source can be a `stellar keys` identity name or a secret key.
 * It is passed to the CLI through the STELLAR_ACCOUNT environment variable
 * so that secrets never show up in the process list.
 *
 * See config/contracts.example.json for the configuration format.
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface Invocation {
  fn: string;
  /** Argument name → value. Values may contain `{{...}}` placeholders. */
  args?: Record<string, string>;
}

export interface ContractConfig {
  /** Cargo package name (also the WASM file name). */
  name: string;
  /** Upload the WASM only; do not deploy an instance (per-deal contracts). */
  installOnly?: boolean;
  init?: Invocation;
  setup?: Invocation[];
}

export interface NetworkConfig {
  rpcUrl: string;
  networkPassphrase: string;
  /** `stellar keys` identity name or secret key used as the admin/source. */
  source: string;
  /** Admin public key; derived from `source` when omitted. */
  adminAddress?: string;
}

export interface DeployConfig {
  contractsDir: string;
  wasmOutDir: string;
  outputFile: string;
  networks: Record<string, NetworkConfig>;
  contracts: ContractConfig[];
}

export interface DeployedContract {
  wasmHash: string;
  contractId?: string;
  initialized?: boolean;
  deployedAt?: string;
}

export interface NetworkDeployment {
  rpcUrl: string;
  networkPassphrase: string;
  admin: string;
  updatedAt: string;
  contracts: Record<string, DeployedContract>;
}

export type DeploymentFile = Record<string, NetworkDeployment>;

export interface CommandResult {
  stdout: string;
  stderr: string;
}

/** Executes an external command. Injected so tests can mock the CLI. */
export type CommandRunner = (
  command: string,
  args: string[],
  env: Record<string, string>,
) => Promise<CommandResult>;

export interface DeployOptions {
  network: string;
  configPath: string;
  rootDir: string;
  only?: string[];
  force?: boolean;
  dryRun?: boolean;
  skipBuild?: boolean;
  /** Required to deploy to mainnet. */
  yes?: boolean;
  runner?: CommandRunner;
  log?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;
const WASM_HASH_RE = /^[0-9a-f]{64}$/;
const PUBLIC_KEY_RE = /^G[A-Z2-7]{55}$/;
const SECRET_KEY_RE = /^S[A-Z2-7]{55}$/;

export const defaultRunner: CommandRunner = (command, args, env) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${command} ${args.join(" ")} failed: ${stderr.trim() || error.message}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

/** Last non-empty line of CLI output (where stellar-cli prints its result). */
export function lastLine(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

export function loadConfig(configPath: string): DeployConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config not found at ${configPath}. Copy config/contracts.example.json to get started.`,
    );
  }
  const config = JSON.parse(
    fs.readFileSync(configPath, "utf8"),
  ) as DeployConfig;
  if (!Array.isArray(config.contracts) || config.contracts.length === 0) {
    throw new Error("Config must list at least one contract");
  }
  const names = new Set<string>();
  for (const c of config.contracts) {
    if (!c.name) throw new Error("Every contract needs a name");
    if (names.has(c.name)) throw new Error(`Duplicate contract "${c.name}"`);
    names.add(c.name);
  }
  return config;
}

export function loadDeployments(file: string): DeploymentFile {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as DeploymentFile;
}

function saveDeployments(file: string, deployments: DeploymentFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(deployments, null, 2)}\n`);
}

/** Replace `{{env.VAR}}` placeholders; used for network config values. */
function resolveEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\{\{\s*env\.([A-Za-z0-9_]+)\s*\}\}/g, (_, name) => {
    const v = env[name];
    if (v === undefined || v === "") {
      throw new Error(`Environment variable ${name} is not set`);
    }
    return v;
  });
}

// ── Deployer ─────────────────────────────────────────────────────────────────

export class ContractDeployer {
  private readonly runner: CommandRunner;
  private readonly log: (message: string) => void;
  private readonly env: NodeJS.ProcessEnv;
  private readonly config: DeployConfig;
  private readonly network: NetworkConfig;
  private readonly outputPath: string;
  private readonly deployments: DeploymentFile;
  private readonly assetIds = new Map<string, string>();
  private admin = "";

  constructor(private readonly options: DeployOptions) {
    this.runner = options.runner ?? defaultRunner;
    this.log = options.log ?? ((m) => console.log(m));
    this.env = options.env ?? process.env;
    this.config = loadConfig(options.configPath);

    const network = this.config.networks?.[options.network];
    if (!network) {
      throw new Error(
        `Unknown network "${options.network}". Configured: ${Object.keys(this.config.networks ?? {}).join(", ")}`,
      );
    }
    this.network = {
      ...network,
      rpcUrl: resolveEnv(network.rpcUrl, this.env),
      networkPassphrase: resolveEnv(network.networkPassphrase, this.env),
      source: resolveEnv(network.source, this.env),
      adminAddress: network.adminAddress
        ? resolveEnv(network.adminAddress, this.env)
        : undefined,
    };

    if (options.network === "mainnet" && !options.yes && !options.dryRun) {
      throw new Error("Refusing to deploy to mainnet without --yes");
    }
    for (const name of options.only ?? []) {
      if (!this.config.contracts.some((c) => c.name === name)) {
        throw new Error(`--only: unknown contract "${name}"`);
      }
    }

    this.outputPath = path.resolve(
      options.rootDir,
      this.config.outputFile ?? "contracts.json",
    );
    this.deployments = loadDeployments(this.outputPath);
  }

  /** Runs the full pipeline and returns this network's deployment record. */
  async run(): Promise<NetworkDeployment> {
    const selected = this.config.contracts.filter(
      (c) => !this.options.only?.length || this.options.only.includes(c.name),
    );

    this.admin = await this.resolveAdmin();
    this.log(`Network: ${this.options.network} (${this.network.rpcUrl})`);
    this.log(`Admin:   ${this.admin}`);

    const record = this.networkRecord();

    if (!this.options.skipBuild) {
      await this.build(selected.map((c) => c.name));
    }

    for (const contract of selected) {
      await this.deployContract(contract, record);
    }

    this.log(`\nDeployment summary (${this.options.network}):`);
    for (const contract of selected) {
      const entry = record.contracts[contract.name];
      this.log(
        `  ${contract.name.padEnd(22)} ${entry?.contractId ?? "(wasm only)"}  wasm=${entry?.wasmHash?.slice(0, 12)}…`,
      );
    }
    if (!this.options.dryRun) {
      this.log(
        `\nSaved to ${path.relative(this.options.rootDir, this.outputPath)}`,
      );
    }
    return record;
  }

  // ── Steps ──────────────────────────────────────────────────────────────────

  private async build(packages: string[]): Promise<void> {
    this.log("\n▸ Building and optimising WASM");
    const manifest = path.resolve(
      this.options.rootDir,
      this.config.contractsDir ?? "contracts",
      "Cargo.toml",
    );
    const outDir = this.wasmOutDir();
    const all = packages.length === this.config.contracts.length;
    const targets = all ? [undefined] : packages;
    for (const pkg of targets) {
      await this.exec("stellar", [
        "contract",
        "build",
        "--manifest-path",
        manifest,
        ...(pkg ? ["--package", pkg] : []),
        "--optimize",
        "--out-dir",
        outDir,
      ]);
    }
  }

  private async deployContract(
    contract: ContractConfig,
    record: NetworkDeployment,
  ): Promise<void> {
    this.log(`\n▸ ${contract.name}`);
    const existing = record.contracts[contract.name];
    const alreadyDeployed =
      !this.options.force && existing?.contractId && !contract.installOnly;

    if (alreadyDeployed) {
      this.log(
        `  already deployed at ${existing.contractId} (use --force to redeploy)`,
      );
    } else {
      const wasmHash = await this.upload(contract.name);
      const entry: DeployedContract = { wasmHash };
      record.contracts[contract.name] = entry;
      this.persist(record);

      if (contract.installOnly) {
        this.log(`  installed wasm ${wasmHash}`);
        return;
      }

      entry.contractId = await this.deploy(contract.name, wasmHash);
      entry.initialized = false;
      entry.deployedAt = new Date().toISOString();
      this.persist(record);
      this.log(`  deployed ${entry.contractId}`);
    }

    const entry = record.contracts[contract.name];
    if (entry.initialized) {
      this.log("  already initialised");
      return;
    }

    const calls = [
      ...(contract.init ? [contract.init] : []),
      ...(contract.setup ?? []),
    ];
    for (const call of calls) {
      await this.invoke(entry.contractId!, call, record);
      this.log(`  invoked ${call.fn}`);
    }
    entry.initialized = true;
    this.persist(record);
  }

  private async upload(name: string): Promise<string> {
    const wasm = path.join(this.wasmOutDir(), `${name}.wasm`);
    if (
      !this.options.dryRun &&
      !this.options.skipBuild &&
      !fs.existsSync(wasm)
    ) {
      throw new Error(`WASM not found: ${wasm}`);
    }
    const out = await this.exec("stellar", [
      "contract",
      "upload",
      "--wasm",
      wasm,
      ...this.networkArgs(),
    ]);
    if (this.options.dryRun) return `<${name}-wasm-hash>`;
    const hash = lastLine(out.stdout);
    if (!WASM_HASH_RE.test(hash)) {
      throw new Error(`Unexpected upload output for ${name}: "${hash}"`);
    }
    return hash;
  }

  private async deploy(name: string, wasmHash: string): Promise<string> {
    const out = await this.exec("stellar", [
      "contract",
      "deploy",
      "--wasm-hash",
      wasmHash,
      ...this.networkArgs(),
    ]);
    if (this.options.dryRun) return `<${name}-contract-id>`;
    const id = lastLine(out.stdout);
    if (!CONTRACT_ID_RE.test(id)) {
      throw new Error(`Unexpected deploy output for ${name}: "${id}"`);
    }
    return id;
  }

  private async invoke(
    contractId: string,
    call: Invocation,
    record: NetworkDeployment,
  ): Promise<void> {
    const fnArgs: string[] = [];
    for (const [key, raw] of Object.entries(call.args ?? {})) {
      fnArgs.push(`--${key}`, await this.resolveValue(raw, record));
    }
    await this.exec("stellar", [
      "contract",
      "invoke",
      "--id",
      contractId,
      "--send",
      "yes",
      ...this.networkArgs(),
      "--",
      call.fn,
      ...fnArgs,
    ]);
  }

  // ── Placeholder resolution ───────────────────────────────────────────────

  private async resolveValue(
    value: string,
    record: NetworkDeployment,
  ): Promise<string> {
    const pattern = /\{\{\s*([^}]+?)\s*\}\}/g;
    let result = "";
    let last = 0;
    for (const match of value.matchAll(pattern)) {
      result +=
        value.slice(last, match.index) +
        (await this.placeholder(match[1], record));
      last = match.index! + match[0].length;
    }
    return result + value.slice(last);
  }

  private async placeholder(
    key: string,
    record: NetworkDeployment,
  ): Promise<string> {
    if (key === "admin") return this.admin;
    if (key.startsWith("env.")) return resolveEnv(`{{${key}}}`, this.env);
    if (key.startsWith("contracts.")) {
      const name = key.slice("contracts.".length);
      const id = record.contracts[name]?.contractId;
      if (!id) {
        if (this.options.dryRun) return `<${name}-contract-id>`;
        throw new Error(
          `{{${key}}} is not deployed on ${this.options.network}; list it before its dependants`,
        );
      }
      return id;
    }
    if (key.startsWith("asset:"))
      return this.assetId(key.slice("asset:".length));
    throw new Error(`Unknown placeholder {{${key}}}`);
  }

  private async assetId(asset: string): Promise<string> {
    const cached = this.assetIds.get(asset);
    if (cached) return cached;
    const out = await this.exec("stellar", [
      "contract",
      "id",
      "asset",
      "--asset",
      asset,
      "--network-passphrase",
      this.network.networkPassphrase,
    ]);
    const id = this.options.dryRun ? `<asset:${asset}>` : lastLine(out.stdout);
    if (!this.options.dryRun && !CONTRACT_ID_RE.test(id)) {
      throw new Error(`Unexpected asset id output for ${asset}: "${id}"`);
    }
    this.assetIds.set(asset, id);
    return id;
  }

  private async resolveAdmin(): Promise<string> {
    const { adminAddress, source } = this.network;
    if (adminAddress) {
      if (!PUBLIC_KEY_RE.test(adminAddress)) {
        throw new Error(
          `adminAddress is not a valid public key: ${adminAddress}`,
        );
      }
      return adminAddress;
    }
    if (SECRET_KEY_RE.test(source)) {
      // Lazy-load so the script and its tests don't need the SDK otherwise.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Keypair } = require("@stellar/stellar-sdk");
      return Keypair.fromSecret(source).publicKey();
    }
    // `keys address` is read-only, so it runs even in dry-run mode.
    const out = await this.runner("stellar", ["keys", "address", source], {});
    const address = lastLine(out.stdout);
    if (!PUBLIC_KEY_RE.test(address)) {
      throw new Error(
        `Could not resolve admin address for identity "${source}"`,
      );
    }
    return address;
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────

  private networkArgs(): string[] {
    return [
      "--rpc-url",
      this.network.rpcUrl,
      "--network-passphrase",
      this.network.networkPassphrase,
    ];
  }

  /** Env passed to every stellar-cli call: the source never hits argv. */
  private cliEnv(): Record<string, string> {
    return { STELLAR_ACCOUNT: this.network.source };
  }

  private async exec(command: string, args: string[]): Promise<CommandResult> {
    const shown = args.map((a) => (/[\s;]/.test(a) ? JSON.stringify(a) : a));
    this.log(`  $ ${command} ${shown.join(" ")}`);
    if (this.options.dryRun) return { stdout: "", stderr: "" };
    return this.runner(command, args, this.cliEnv());
  }

  private wasmOutDir(): string {
    return path.resolve(
      this.options.rootDir,
      this.config.wasmOutDir ?? "contracts/target/deploy",
    );
  }

  private networkRecord(): NetworkDeployment {
    const existing = this.deployments[this.options.network];
    const record: NetworkDeployment = {
      rpcUrl: this.network.rpcUrl,
      networkPassphrase: this.network.networkPassphrase,
      admin: this.admin,
      updatedAt: new Date().toISOString(),
      contracts: existing?.contracts ?? {},
    };
    this.deployments[this.options.network] = record;
    return record;
  }

  private persist(record: NetworkDeployment): void {
    if (this.options.dryRun) return;
    record.updatedAt = new Date().toISOString();
    saveDeployments(this.outputPath, this.deployments);
  }
}

export async function deployContracts(
  options: DeployOptions,
): Promise<NetworkDeployment> {
  return new ContractDeployer(options).run();
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[], rootDir: string): DeployOptions {
  const options: DeployOptions = {
    network: "testnet",
    configPath: path.join(rootDir, "config", "contracts.json"),
    rootDir,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--network":
      case "-n":
        options.network = next();
        break;
      case "--config":
        options.configPath = path.resolve(next());
        break;
      case "--only":
        options.only = next()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--force":
        options.force = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--skip-build":
        options.skipBuild = true;
        break;
      case "--yes":
      case "-y":
        options.yes = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: tsx scripts/deployContracts.ts [--network testnet|mainnet] [--config path] " +
            "[--only a,b] [--force] [--dry-run] [--skip-build] [--yes]",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

if (require.main === module) {
  const rootDir = path.resolve(__dirname, "..");
  Promise.resolve()
    .then(() => deployContracts(parseArgs(process.argv.slice(2), rootDir)))
    .catch((err: Error) => {
      console.error(`\n✖ ${err.message}`);
      process.exit(1);
    });
}
