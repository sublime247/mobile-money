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
  approvedSigners?: string[];
  requiredSignatures?: number;
}

export interface HtlcClaimParams {
  claimerAddress: string;
  preimage: string;
  contractId: string;
  signers?: string[];
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

  private addressToScVal(address: string) {
    return StellarSdk.nativeToScVal(address, { type: "address" });
  }

  private bytesNToScVal(hex: string) {
    return StellarSdk.nativeToScVal(Buffer.from(hex, "hex"), { type: "bytesN" });
  }

  private u64ToScVal(value: bigint | number) {
    return StellarSdk.nativeToScVal(BigInt(value), { type: "u64" });
  }

  private u32ToScVal(value: number) {
    return StellarSdk.nativeToScVal(value, { type: "u32" });
  }

  private addressArrayToScVal(addresses: string[]) {
    const converted = addresses.map((address) => this.addressToScVal(address));
    return StellarSdk.nativeToScVal(converted, { type: "vec" });
  }

  async buildLockTx(params: HtlcLockParams): Promise<StellarSdk.Transaction> {
    const senderAccount = await this.server.loadAccount(params.senderAddress);

    const approvedSigners = params.approvedSigners ?? [];
    const requiredSignatures = params.requiredSignatures ?? 0;

    const contract = new StellarSdk.Contract(params.contractId);
    const tx = new StellarSdk.TransactionBuilder(senderAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "initialize",
          this.addressToScVal(params.senderAddress),
          this.addressToScVal(params.receiverAddress),
          this.addressToScVal(params.tokenAddress),
          this.u64ToScVal(BigInt(params.amount)),
          this.bytesNToScVal(params.hashlock),
          this.u64ToScVal(params.timelock),
          this.addressArrayToScVal(approvedSigners),
          this.u32ToScVal(requiredSignatures),
        )
      )
      .setTimeout(30)
      .build();

    return tx;
  }

  async buildClaimTx(params: HtlcClaimParams): Promise<StellarSdk.Transaction> {
    const claimerAccount = await this.server.loadAccount(params.claimerAddress);

    const signers = params.signers ?? [];
    const contract = new StellarSdk.Contract(params.contractId);
    const tx = new StellarSdk.TransactionBuilder(claimerAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "claim",
          this.bytesNToScVal(params.preimage),
          this.addressArrayToScVal(signers),
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
    const response = await contract.call("get_state");

    if (!response || typeof response !== "object") {
      throw new Error("Unable to fetch HTLC state from contract");
    }

    const state = response as {
      sender: string;
      receiver: string;
      token: string;
      amount: string | number;
      hashlock: string;
      timelock: number;
      claimed: boolean;
      refunded: boolean;
    };

    return {
      sender: state.sender,
      receiver: state.receiver,
      token: state.token,
      amount: String(state.amount),
      hashlock: state.hashlock,
      timelock: Number(state.timelock),
      claimed: Boolean(state.claimed),
      refunded: Boolean(state.refunded),
    };
  }
}