import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

/**
 * Client for the Soroban oracle contract in `contracts/oracle`.
 *
 * The contract aggregates quotes from registered liquidity pools and exposes
 * `get_rate_with_spread(asset_in, asset_out, amount_in, max_spread_bps)`, which
 * returns the best `amount_out` and reverts when the spread between the best
 * and worst pool quote exceeds `max_spread_bps`. This client only performs
 * read-only simulations, so it never signs or submits a transaction.
 */

/** Mirrors `OracleError` in contracts/oracle/src/lib.rs. */
export type OracleErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_AMOUNT"
  | "NO_REGISTERED_POOLS"
  | "POOL_QUERY_FAILED"
  | "SPREAD_TOO_HIGH"
  | "UNAVAILABLE"
  | "INVALID_RESPONSE";

const CONTRACT_ERROR_CODES: Record<number, OracleErrorCode> = {
  1: "UNAUTHORIZED",
  2: "INVALID_AMOUNT",
  3: "NO_REGISTERED_POOLS",
  4: "POOL_QUERY_FAILED",
  5: "SPREAD_TOO_HIGH",
};

export class OracleError extends Error {
  constructor(
    message: string,
    readonly code: OracleErrorCode,
  ) {
    super(message);
    this.name = "OracleError";
  }
}

export interface OracleQuoteRequest {
  /** Address (contract id) of the asset being sold. */
  assetIn: string;
  /** Address (contract id) of the asset being bought. */
  assetOut: string;
  /** Amount of `assetIn` in base units. */
  amountIn: bigint;
  /** Maximum tolerated spread between the pools' quotes, in basis points. */
  maxSpreadBps: number;
}

export interface IOracleClient {
  /**
   * Best pool quote for `amountIn`, as an amount of `assetOut` in base units.
   * Rejects with an `OracleError` (`SPREAD_TOO_HIGH` when the pools disagree by
   * more than `maxSpreadBps`).
   */
  getRateWithSpread(request: OracleQuoteRequest): Promise<bigint>;
}

/**
 * Well-known all-zero account. Read-only simulation does not need the source
 * account to exist on the network, only to be a valid address.
 */
const DEFAULT_SIMULATION_ACCOUNT =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export interface SorobanOracleClientOptions {
  rpcUrl: string;
  contractId: string;
  networkPassphrase: string;
  simulationAccount?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to a Soroban RPC server for `rpcUrl`. */
  server?: Pick<rpc.Server, "simulateTransaction">;
}

export class SorobanOracleClient implements IOracleClient {
  private readonly contract: Contract;
  private readonly server: Pick<rpc.Server, "simulateTransaction">;
  private readonly networkPassphrase: string;
  private readonly simulationAccount: string;
  private readonly timeoutMs: number;

  constructor(options: SorobanOracleClientOptions) {
    this.contract = new Contract(options.contractId);
    this.networkPassphrase = options.networkPassphrase;
    this.simulationAccount =
      options.simulationAccount || DEFAULT_SIMULATION_ACCOUNT;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.server =
      options.server ??
      new rpc.Server(options.rpcUrl, {
        allowHttp: options.rpcUrl.startsWith("http://"),
      });
  }

  async getRateWithSpread(request: OracleQuoteRequest): Promise<bigint> {
    const tx = new TransactionBuilder(
      new Account(this.simulationAccount, "0"),
      {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      },
    )
      .addOperation(
        this.contract.call(
          "get_rate_with_spread",
          new Address(request.assetIn).toScVal(),
          new Address(request.assetOut).toScVal(),
          nativeToScVal(request.amountIn, { type: "i128" }),
          nativeToScVal(request.maxSpreadBps, { type: "u32" }),
        ),
      )
      .setTimeout(30)
      .build();

    let simulation: rpc.Api.SimulateTransactionResponse;
    try {
      simulation = await this.withTimeout(this.server.simulateTransaction(tx));
    } catch (err) {
      throw new OracleError(
        `Oracle RPC request failed: ${err instanceof Error ? err.message : String(err)}`,
        "UNAVAILABLE",
      );
    }

    if (rpc.Api.isSimulationError(simulation)) {
      throw this.toOracleError(simulation.error);
    }

    const retval = simulation.result?.retval;
    if (!retval) {
      throw new OracleError(
        "Oracle simulation returned no value",
        "INVALID_RESPONSE",
      );
    }

    const amountOut = scValToNative(retval);
    if (typeof amountOut !== "bigint" || amountOut <= 0n) {
      throw new OracleError(
        `Oracle returned an invalid quote: ${String(amountOut)}`,
        "INVALID_RESPONSE",
      );
    }
    return amountOut;
  }

  /** Map a simulation error such as `Error(Contract, #5)` to an OracleError. */
  private toOracleError(message: string): OracleError {
    const match = /Error\(Contract, #(\d+)\)/.exec(message);
    const code = match ? CONTRACT_ERROR_CODES[Number(match[1])] : undefined;
    return new OracleError(
      `Oracle contract rejected the quote: ${message}`,
      code ?? "UNAVAILABLE",
    );
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
