import * as StellarSdk from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase } from "../../config/stellar";

export interface HtlcLockParams {
  senderAddress: string;
  receiverAddress: string;
  tokenAddress: string;
  amount: string;
  hashlock: string;
  timelock: number;
  contractId: string;
}

export interface HtlcClaimParams {
  claimerAddress: string;
  preimage: string;
  contractId: string;
}

export interface HtlcRefundParams {
  refunderAddress: string;
  contractId: string;
}

export interface HtlcState {
  sender: string;
  receiver: string;
  token: string;
  amount: string;
  hashlock: string;
  timelock: number;
  claimed: boolean;
  refunded: boolean;
}

export class HtlcService {
  private server: StellarSdk.Horizon.Server;
  private networkPassphrase: string;

  constructor() {
    this.server = getStellarServer();
    this.networkPassphrase = getNetworkPassphrase();
  }

  async buildLockTx(params: HtlcLockParams): Promise<StellarSdk.Transaction> {
    const senderAccount = await this.server.loadAccount(params.senderAddress);

    const contract = new StellarSdk.Contract(params.contractId);
    const tx = new StellarSdk.TransactionBuilder(senderAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "initialize",
          StellarSdk.nativeToScVal(params.senderAddress, { type: "address" }),
          StellarSdk.nativeToScVal(params.receiverAddress, { type: "address" }),
          StellarSdk.nativeToScVal(params.tokenAddress, { type: "address" }),
          StellarSdk.nativeToScVal(BigInt(params.amount), { type: "u64" }),
          StellarSdk.nativeToScVal(Buffer.from(params.hashlock, "hex"), { type: "bytesN" }),
          StellarSdk.nativeToScVal(params.timelock, { type: "u32" })
        )
      )
      .setTimeout(30)
      .build();

    return tx;
  }

  async buildClaimTx(params: HtlcClaimParams): Promise<StellarSdk.Transaction> {
    const claimerAccount = await this.server.loadAccount(params.claimerAddress);

    const contract = new StellarSdk.Contract(params.contractId);
    const tx = new StellarSdk.TransactionBuilder(claimerAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "claim",
          StellarSdk.nativeToScVal(Buffer.from(params.preimage, "hex"), { type: "bytesN" })
        )
      )
      .setTimeout(30)
      .build();

    return tx;
  }

  async buildRefundTx(params: HtlcRefundParams): Promise<StellarSdk.Transaction> {
    const refunderAccount = await this.server.loadAccount(params.refunderAddress);

    const contract = new StellarSdk.Contract(params.contractId);
    const tx = new StellarSdk.TransactionBuilder(refunderAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        contract.call("refund")
      )
      .setTimeout(30)
      .build();

    return tx;
  }

  async getHtlcState(contractId: string): Promise<HtlcState> {
    const contract = new StellarSdk.Contract(contractId);
    
    // Query the contract state
    // This would need proper implementation based on your contract's state structure
    // For now, returning a placeholder that matches the interface
    // In a real implementation, you would call contract.call("get_state") or similar
    
    throw new Error("getHtlcState not yet implemented - requires contract state query");
  }
}