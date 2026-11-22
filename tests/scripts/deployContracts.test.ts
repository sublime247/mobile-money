import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  CommandRunner,
  DeployConfig,
  deployContracts,
  lastLine,
  parseArgs,
} from "../../scripts/deployContracts";

const ADMIN = `G${"A".repeat(55)}`;
const NATIVE_SAC = `C${"N".repeat(55)}`;

interface Call {
  args: string[];
  env: Record<string, string>;
}

/** Fake stellar-cli: returns deterministic hashes / IDs per contract. */
function mockStellar(overrides: Partial<Record<string, string>> = {}) {
  const calls: Call[] = [];
  let deployed = 0;
  const runner: CommandRunner = jest.fn(async (command, args, env) => {
    expect(command).toBe("stellar");
    calls.push({ args, env });
    const sub = args.slice(0, 2).join(" ");
    if (overrides[sub] !== undefined) {
      return { stdout: overrides[sub]!, stderr: "" };
    }
    switch (sub) {
      case "keys address":
        return { stdout: `${ADMIN}\n`, stderr: "" };
      case "contract build":
        return { stdout: "", stderr: "✅ Build Complete" };
      case "contract upload": {
        const wasm = path.basename(args[args.indexOf("--wasm") + 1], ".wasm");
        const hash = Buffer.from(wasm).toString("hex").padEnd(64, "0");
        return { stdout: `ℹ️ Uploading…\n${hash}\n`, stderr: "" };
      }
      case "contract deploy": {
        deployed += 1;
        return {
          stdout: `C${String.fromCharCode(64 + deployed).repeat(55)}\n`,
          stderr: "",
        };
      }
      case "contract id":
        return { stdout: `${NATIVE_SAC}\n`, stderr: "" };
      case "contract invoke":
        return { stdout: "null\n", stderr: "" };
      default:
        throw new Error(`unexpected command: ${args.join(" ")}`);
    }
  });
  return { runner, calls };
}

const baseConfig: DeployConfig = {
  contractsDir: "contracts",
  wasmOutDir: "wasm",
  outputFile: "contracts.json",
  networks: {
    testnet: {
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      source: "{{env.STELLAR_ADMIN_SOURCE}}",
    },
    mainnet: {
      rpcUrl: "https://mainnet.example",
      networkPassphrase: "Public Global Stellar Network ; September 2015",
      source: "admin",
    },
  },
  contracts: [
    {
      name: "blacklist",
      init: { fn: "initialize", args: { admin: "{{admin}}" } },
    },
    {
      name: "bridge",
      init: {
        fn: "initialize",
        args: {
          admin: "{{admin}}",
          token: "{{asset:native}}",
          fee_recipient: "{{admin}}",
          fee_bps: "100",
        },
      },
      setup: [
        { fn: "set_blacklist", args: { blacklist: "{{contracts.blacklist}}" } },
      ],
    },
    { name: "escrow", installOnly: true },
  ],
};

describe("deployContracts", () => {
  let root: string;
  const env = { STELLAR_ADMIN_SOURCE: "deployer" };
  const quiet = () => undefined;

  const writeConfig = (config: DeployConfig = baseConfig) => {
    const configPath = path.join(root, "config", "contracts.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config));
    fs.mkdirSync(path.join(root, "wasm"), { recursive: true });
    for (const c of config.contracts) {
      fs.writeFileSync(path.join(root, "wasm", `${c.name}.wasm`), "\0asm");
    }
    return configPath;
  };

  const readOutput = () =>
    JSON.parse(fs.readFileSync(path.join(root, "contracts.json"), "utf8"));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-contracts-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("builds, uploads, deploys and initialises every contract", async () => {
    const { runner, calls } = mockStellar();
    const configPath = writeConfig();

    await deployContracts({
      network: "testnet",
      configPath,
      rootDir: root,
      runner,
      env,
      log: quiet,
    });

    const commands = calls.map((c) => c.args.slice(0, 2).join(" "));
    expect(commands).toEqual([
      "keys address",
      "contract build",
      "contract upload",
      "contract deploy",
      "contract invoke",
      "contract upload",
      "contract deploy",
      "contract id",
      "contract invoke",
      "contract invoke",
      "contract upload",
    ]);

    const build = calls[1].args;
    expect(build).toContain("--optimize");
    expect(build).toContain(path.join(root, "contracts", "Cargo.toml"));

    const output = readOutput();
    expect(output.testnet.admin).toBe(ADMIN);
    const { blacklist, bridge, escrow } = output.testnet.contracts;
    expect(blacklist).toMatchObject({
      contractId: `C${"A".repeat(55)}`,
      initialized: true,
    });
    expect(bridge).toMatchObject({
      contractId: `C${"B".repeat(55)}`,
      initialized: true,
    });
    expect(escrow.contractId).toBeUndefined();
    expect(escrow.wasmHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("resolves placeholders in init and setup invocations", async () => {
    const { runner, calls } = mockStellar();
    const configPath = writeConfig();

    await deployContracts({
      network: "testnet",
      configPath,
      rootDir: root,
      runner,
      env,
      log: quiet,
    });

    const invokes = calls
      .filter((c) => c.args[1] === "invoke")
      .map((c) => c.args);
    const fnArgs = (args: string[]) => args.slice(args.indexOf("--") + 1);

    expect(fnArgs(invokes[0])).toEqual(["initialize", "--admin", ADMIN]);
    expect(fnArgs(invokes[1])).toEqual([
      "initialize",
      "--admin",
      ADMIN,
      "--token",
      NATIVE_SAC,
      "--fee_recipient",
      ADMIN,
      "--fee_bps",
      "100",
    ]);
    expect(fnArgs(invokes[2])).toEqual([
      "set_blacklist",
      "--blacklist",
      `C${"A".repeat(55)}`,
    ]);
    // Invoke targets the freshly deployed bridge.
    expect(invokes[1]).toContain(`C${"B".repeat(55)}`);
  });

  it("passes the admin source via STELLAR_ACCOUNT, never argv", async () => {
    const { runner, calls } = mockStellar();
    const configPath = writeConfig();

    await deployContracts({
      network: "testnet",
      configPath,
      rootDir: root,
      runner,
      env,
      log: quiet,
    });

    for (const call of calls.filter((c) => c.args[0] === "contract")) {
      expect(call.env.STELLAR_ACCOUNT).toBe("deployer");
      expect(call.args).not.toContain("--source-account");
      if (call.args[1] !== "build")
        expect(call.args).toContain("--network-passphrase");
    }
  });

  it("skips contracts that are already deployed and initialised", async () => {
    const configPath = writeConfig();
    await deployContracts({
      network: "testnet",
      configPath,
      rootDir: root,
      runner: mockStellar().runner,
      env,
      log: quiet,
    });

    const { runner, calls } = mockStellar();
    await deployContracts({
      network: "testnet",
      configPath,
      rootDir: root,
      runner,
      env,
      log: quiet,
    });

    const commands = calls.map((c) => c.args.slice(0, 2).join(" "));
    expect(commands).not.toContain("contract deploy");
    expect(commands).not.toContain("contract invoke");
    // Install-only contracts are re-uploaded (idempotent, same hash).
    expect(commands.filter((c) => c === "contract upload")).toHaveLength(1);
    expect(readOutput().testnet.contracts.blacklist.contractId).toBe(
      `C${"A".repeat(55)}`,
    );
  });

  it("redeploys with --force", async () => {
    const configPath = writeConfig();
    await deployContracts({
      network: "testnet",
      configPath,
      rootDir: root,
      runner: mockStellar().runner,
      env,
      log: quiet,
    });

    const { runner, calls } = mockStellar();
    await deployContracts({
      network: "testnet",
      configPath,
      rootDir: root,
      runner,
      env,
      force: true,
      only: ["blacklist"],
      log: quiet,
    });

    expect(calls.filter((c) => c.args[1] === "deploy")).toHaveLength(1);
    const build = calls.find((c) => c.args[1] === "build")!;
    expect(build.args).toEqual(
      expect.arrayContaining(["--package", "blacklist"]),
    );
  });

  it("resumes initialisation after a failed invoke", async () => {
    const configPath = writeConfig({
      ...baseConfig,
      contracts: [baseConfig.contracts[0]],
    });
    const failing = mockStellar({ "contract invoke": "" });
    (failing.runner as jest.Mock).mockImplementation(async (_cmd, args) => {
      if (args[1] === "invoke") throw new Error("tx failed");
      if (args[0] === "keys") return { stdout: ADMIN, stderr: "" };
      if (args[1] === "upload") return { stdout: "a".repeat(64), stderr: "" };
      if (args[1] === "deploy")
        return { stdout: `C${"7".repeat(55)}`, stderr: "" };
      return { stdout: "", stderr: "" };
    });

    await expect(
      deployContracts({
        network: "testnet",
        configPath,
        rootDir: root,
        runner: failing.runner,
        env,
        log: quiet,
      }),
    ).rejects.toThrow("tx failed");
    expect(readOutput().testnet.contracts.blacklist).toMatchObject({
      contractId: `C${"7".repeat(55)}`,
      initialized: false,
    });

    const { runner, calls } = mockStellar();
    await deployContracts({
      network: "testnet",
      configPath,
      rootDir: root,
      runner,
      env,
      log: quiet,
    });

    const commands = calls.map((c) => c.args.slice(0, 2).join(" "));
    expect(commands).not.toContain("contract deploy");
    expect(commands).toContain("contract invoke");
    expect(readOutput().testnet.contracts.blacklist.initialized).toBe(true);
  });

  it("keeps other networks' deployments in contracts.json", async () => {
    fs.writeFileSync(
      path.join(root, "contracts.json"),
      JSON.stringify({
        mainnet: {
          contracts: { blacklist: { wasmHash: "x", contractId: "CMAIN" } },
        },
      }),
    );
    const configPath = writeConfig();
    await deployContracts({
      network: "testnet",
      configPath,
      rootDir: root,
      runner: mockStellar().runner,
      env,
      log: quiet,
    });

    const output = readOutput();
    expect(output.mainnet.contracts.blacklist.contractId).toBe("CMAIN");
    expect(output.testnet.contracts.blacklist.contractId).toBeDefined();
  });

  it("dry-run executes nothing and writes nothing", async () => {
    const { runner, calls } = mockStellar();
    const configPath = writeConfig();
    const log = jest.fn();

    await deployContracts({
      network: "testnet",
      configPath,
      rootDir: root,
      runner,
      env,
      dryRun: true,
      log,
    });

    expect(calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual([
      "keys address",
    ]);
    expect(fs.existsSync(path.join(root, "contracts.json"))).toBe(false);
    const printed = log.mock.calls.map((c) => c[0]).join("\n");
    expect(printed).toContain("$ stellar contract deploy");
    expect(printed).toContain("<blacklist-contract-id>");
  });

  it("refuses mainnet without --yes", async () => {
    const configPath = writeConfig();
    await expect(
      deployContracts({
        network: "mainnet",
        configPath,
        rootDir: root,
        runner: mockStellar().runner,
        env,
        log: quiet,
      }),
    ).rejects.toThrow("--yes");
  });

  it("rejects unknown networks, contracts and placeholders", async () => {
    const configPath = writeConfig();
    const opts = {
      configPath,
      rootDir: root,
      runner: mockStellar().runner,
      env,
      log: quiet,
    };

    await expect(
      deployContracts({ ...opts, network: "futurenet" }),
    ).rejects.toThrow('Unknown network "futurenet"');
    await expect(
      deployContracts({ ...opts, network: "testnet", only: ["nope"] }),
    ).rejects.toThrow('unknown contract "nope"');

    const badPath = writeConfig({
      ...baseConfig,
      contracts: [
        {
          name: "vault",
          init: { fn: "initialize", args: { token: "{{contracts.missing}}" } },
        },
      ],
    });
    await expect(
      deployContracts({ ...opts, configPath: badPath, network: "testnet" }),
    ).rejects.toThrow("{{contracts.missing}} is not deployed");
  });

  it("fails on missing environment variables", async () => {
    const configPath = writeConfig();
    await expect(
      deployContracts({
        network: "testnet",
        configPath,
        rootDir: root,
        runner: mockStellar().runner,
        env: {},
        log: quiet,
      }),
    ).rejects.toThrow("STELLAR_ADMIN_SOURCE is not set");
  });

  it("rejects malformed CLI output", async () => {
    const { runner } = mockStellar({ "contract deploy": "error: something\n" });
    const configPath = writeConfig();
    await expect(
      deployContracts({
        network: "testnet",
        configPath,
        rootDir: root,
        runner,
        env,
        log: quiet,
      }),
    ).rejects.toThrow("Unexpected deploy output for blacklist");
  });

  it("derives the admin address from a secret key source", async () => {
    const { Keypair } = jest.requireActual("@stellar/stellar-sdk");
    const keypair = Keypair.random();
    const { runner, calls } = mockStellar();
    const configPath = writeConfig();

    await deployContracts({
      network: "testnet",
      configPath,
      rootDir: root,
      runner,
      env: { STELLAR_ADMIN_SOURCE: keypair.secret() },
      log: quiet,
    });

    expect(calls.map((c) => c.args[0])).not.toContain("keys");
    expect(readOutput().testnet.admin).toBe(keypair.publicKey());
  });
});

describe("parseArgs", () => {
  it("parses flags", () => {
    const opts = parseArgs(
      [
        "--network",
        "mainnet",
        "--only",
        "blacklist, bridge",
        "--force",
        "--dry-run",
        "--skip-build",
        "--yes",
      ],
      "/repo",
    );
    expect(opts).toMatchObject({
      network: "mainnet",
      configPath: path.join("/repo", "config", "contracts.json"),
      only: ["blacklist", "bridge"],
      force: true,
      dryRun: true,
      skipBuild: true,
      yes: true,
    });
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--bogus"], "/repo")).toThrow("Unknown argument");
  });
});

describe("lastLine", () => {
  it("returns the last non-empty line", () => {
    expect(lastLine("a\nb\n\n")).toBe("b");
    expect(lastLine("")).toBe("");
  });
});
