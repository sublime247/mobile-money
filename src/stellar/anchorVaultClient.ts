import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

/**
 * Client binding for the Soroban anchor escrow vault in
 * `contracts/anchor_vault` (#2564).
 *
 * The vault freezes `deposit` / `withdraw` while paused. `pause` and `unpause`
 * need an M-of-N admin quorum: every address in `signers` must authorize the
 * invocation, so a pause transaction carries one Soroban auth entry per
 * signer. The flow is:
 *
 *   1. `buildPauseTransaction()` simulates the call and returns the prepared
 *      transaction (footprint, fees and the unsigned auth entries attached);
 *   2. each admin signs their auth entry with `signAuthEntries()` — this can
 *      happen on separate machines since only the entry is signed;
 *   3. the transaction source signs the envelope and `submit()` sends it.
 *
 * Read-only views (`isPaused`, `getConfig`, `balance`) are simulations and
 * never sign or submit anything.
 */

/** Mirrors `VaultError` in contracts/anchor_vault/src/lib.rs. */
export type AnchorVaultErrorCode =
  | "ALREADY_INITIALIZED"
  | "NOT_INITIALIZED"
  | "CONTRACT_PAUSED"
  | "ALREADY_PAUSED"
  | "NOT_PAUSED"
  | "THRESHOLD_NOT_MET"
  | "NOT_ADMIN"
  | "DUPLICATE_SIGNER"
  | "INVALID_THRESHOLD"
  | "INVALID_AMOUNT"
  | "INSUFFICIENT_BALANCE"
  | "OPERATOR_NOT_SIGNER"
  | "UNAVAILABLE"
  | "INVALID_RESPONSE";

const CONTRACT_ERROR_CODES: Record<number, AnchorVaultErrorCode> = {
  1: "ALREADY_INITIALIZED",
  2: "NOT_INITIALIZED",
  3: "CONTRACT_PAUSED",
  4: "ALREADY_PAUSED",
  5: "NOT_PAUSED",
  6: "THRESHOLD_NOT_MET",
  7: "NOT_ADMIN",
  8: "DUPLICATE_SIGNER",
  9: "INVALID_THRESHOLD",
  10: "INVALID_AMOUNT",
  11: "INSUFFICIENT_BALANCE",
  12: "OPERATOR_NOT_SIGNER",
};

export class AnchorVaultError extends Error {
  constructor(
    message: string,
    readonly code: AnchorVaultErrorCode,
  ) {
    super(message);
    this.name = "AnchorVaultError";
  }
}

export interface AnchorVaultConfig {
  admins: string[];
  threshold: number;
  token: string;
}

export interface EmergencyActionRequest {
  /** Account that pays for and signs the transaction envelope. */
  sourceAccount: string;
  /** Admin recorded as `operator` in the ContractPaused/Unpaused event. */
  operator: string;
  /** Distinct admin addresses forming the M-of-N quorum. */
  signers: string[];
}

type VaultRpc = Pick<
  rpc.Server,
  | "simulateTransaction"
  | "prepareTransaction"
  | "getAccount"
  | "sendTransaction"
  | "getLatestLedger"
>;

export interface AnchorVaultClientOptions {
  rpcUrl: string;
  contractId: string;
  networkPassphrase: string;
  simulationAccount?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to a Soroban RPC server for `rpcUrl`. */
  server?: VaultRpc;
}

const DEFAULT_SIMULATION_ACCOUNT =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Auth signatures stay valid for ~5 minutes of ledgers by default. */
const DEFAULT_AUTH_VALIDITY_LEDGERS = 60;

export function toAnchorVaultError(message: string): AnchorVaultError {
  const match = /Error\(Contract, #(\d+)\)/.exec(message);
  const code = match ? CONTRACT_ERROR_CODES[Number(match[1])] : undefined;
  return new AnchorVaultError(
    `Anchor vault call failed: ${message}`,
    code ?? "UNAVAILABLE",
  );
}

export class AnchorVaultClient {
  private readonly contract: Contract;
  private readonly server: VaultRpc;
  private readonly networkPassphrase: string;
  private readonly simulationAccount: string;
  private readonly timeoutMs: number;

  constructor(options: AnchorVaultClientOptions) {
    this.contract = new Contract(options.contractId);
    this.networkPassphrase = options.networkPassphrase;
    this.simulationAccount =
      options.simulationAccount || DEFAULT_SIMULATION_ACCOUNT;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.server =
      options.server ??
      new rpc.Server(options.rpcUrl, {
        allowHttp: options.rpcUrl.startsWith("http://"),
      });
  }

  get contractId(): string {
    return this.contract.contractId();
  }

  // ── Read-only views ───────────────────────────────────────────────────────

  async isPaused(): Promise<boolean> {
    const value = await this.view("is_paused");
    if (typeof value !== "boolean") {
      throw new AnchorVaultError(
        `is_paused returned ${String(value)}`,
        "INVALID_RESPONSE",
      );
    }
    return value;
  }

  async getConfig(): Promise<AnchorVaultConfig> {
    const value = (await this.view("get_config")) as {
      admins?: string[];
      threshold?: number;
      token?: string;
    };
    if (!value || !Array.isArray(value.admins) || !value.token) {
      throw new AnchorVaultError(
        "get_config returned an unexpected shape",
        "INVALID_RESPONSE",
      );
    }
    return {
      admins: value.admins,
      threshold: Number(value.threshold),
      token: value.token,
    };
  }

  async balance(user: string): Promise<bigint> {
    const value = await this.view("balance", new Address(user).toScVal());
    return BigInt(value as bigint | number);
  }

  /** Throws `CONTRACT_PAUSED` when the vault is frozen — off-chain mirror of `assert_not_paused`. */
  async assertNotPaused(): Promise<void> {
    if (await this.isPaused()) {
      throw new AnchorVaultError(
        "Anchor vault is paused; deposits and withdrawals are frozen",
        "CONTRACT_PAUSED",
      );
    }
  }

  // ── Multi-sig emergency controls ──────────────────────────────────────────

  buildPauseTransaction(req: EmergencyActionRequest): Promise<Transaction> {
    return this.buildEmergencyTransaction("pause", req);
  }

  buildUnpauseTransaction(req: EmergencyActionRequest): Promise<Transaction> {
    return this.buildEmergencyTransaction("unpause", req);
  }

  /**
   * Sign every auth entry in `tx` whose address belongs to one of `signers`.
   * Entries for other admins are left untouched so co-signers can add theirs
   * independently. Returns a new transaction; the envelope is not signed.
   */
  async signAuthEntries(
    tx: Transaction,
    signers: Keypair[],
    validUntilLedgerSeq?: number,
  ): Promise<Transaction> {
    const expiry =
      validUntilLedgerSeq ??
      (await this.server.getLatestLedger()).sequence +
        DEFAULT_AUTH_VALIDITY_LEDGERS;
    const byAddress = new Map(signers.map((kp) => [kp.publicKey(), kp]));

    const [op] = tx.operations;
    if (!op || op.type !== "invokeHostFunction") {
      throw new AnchorVaultError(
        "expected a single invokeHostFunction operation",
        "INVALID_RESPONSE",
      );
    }

    const signed = await Promise.all(
      (op.auth ?? []).map(async (entry) => {
        const creds = entry.credentials;
        if (creds.type !== "sorobanCredentialsAddress") return entry;
        const kp = byAddress.get(
          Address.fromScAddress(creds.address.address).toString(),
        );
        return kp
          ? authorizeEntry(entry, kp, expiry, this.networkPassphrase)
          : entry;
      }),
    );

    // Rebuild with the signed entries; footprint and resource fee are kept.
    const builder = TransactionBuilder.cloneFrom(tx, { fee: tx.fee });
    builder.clearOperations();
    builder.addOperation(
      Operation.invokeHostFunction({
        func: op.func,
        auth: signed,
        source: op.source,
      }),
    );
    return builder.build();
  }

  /** Submit a fully signed transaction. */
  async submit(tx: Transaction): Promise<rpc.Api.SendTransactionResponse> {
    const response = await this.withTimeout(this.server.sendTransaction(tx));
    if (response.status === "ERROR") {
      throw new AnchorVaultError(
        `Transaction ${response.hash} rejected by RPC`,
        "UNAVAILABLE",
      );
    }
    return response;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async buildEmergencyTransaction(
    method: "pause" | "unpause",
    req: EmergencyActionRequest,
  ): Promise<Transaction> {
    const unique = new Set(req.signers);
    if (unique.size !== req.signers.length) {
      throw new AnchorVaultError(
        "signers must be distinct",
        "DUPLICATE_SIGNER",
      );
    }
    if (!unique.has(req.operator)) {
      throw new AnchorVaultError(
        "operator must be one of the signers",
        "OPERATOR_NOT_SIGNER",
      );
    }

    const source = await this.withTimeout(
      this.server.getAccount(req.sourceAccount),
    );
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          method,
          new Address(req.operator).toScVal(),
          xdr.ScVal.scvVec(req.signers.map((s) => new Address(s).toScVal())),
        ),
      )
      .setTimeout(300)
      .build();

    try {
      return (await this.withTimeout(
        this.server.prepareTransaction(tx),
      )) as Transaction;
    } catch (err) {
      throw toAnchorVaultError(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async view(method: string, ...args: xdr.ScVal[]): Promise<unknown> {
    const tx = new TransactionBuilder(
      new Account(this.simulationAccount, "0"),
      { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
    )
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();

    let simulation: rpc.Api.SimulateTransactionResponse;
    try {
      simulation = await this.withTimeout(this.server.simulateTransaction(tx));
    } catch (err) {
      throw new AnchorVaultError(
        `Anchor vault RPC request failed: ${err instanceof Error ? err.message : String(err)}`,
        "UNAVAILABLE",
      );
    }
    if (rpc.Api.isSimulationError(simulation)) {
      throw toAnchorVaultError(simulation.error);
    }
    const retval = simulation.result?.retval;
    if (!retval) {
      throw new AnchorVaultError(
        `${method} simulation returned no value`,
        "INVALID_RESPONSE",
      );
    }
    return scValToNative(retval);
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}

/** Build a client from ANCHOR_VAULT_* / SOROBAN_* env vars, or null when unconfigured. */
export function createAnchorVaultClientFromEnv(): AnchorVaultClient | null {
  const contractId = process.env.ANCHOR_VAULT_CONTRACT_ID;
  const rpcUrl = process.env.SOROBAN_RPC_URL;
  if (!contractId || !rpcUrl) return null;
  return new AnchorVaultClient({
    contractId,
    rpcUrl,
    networkPassphrase:
      process.env.STELLAR_NETWORK_PASSPHRASE ??
      "Test SDF Network ; September 2015",
  });
}
