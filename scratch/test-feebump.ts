import * as StellarSdk from "stellar-sdk";
import { StellarService } from "../src/services/stellar/stellarService";
import dotenv from "dotenv";

dotenv.config();

async function testFeeBump() {
  const stellarService = new StellarService();

  // Create a random account to be the source of the inner transaction
  const sourceKeypair = StellarSdk.Keypair.random();
  console.log("Source Public Key:", sourceKeypair.publicKey());

  // We need the account to exist on-chain if we want to build a real transaction
  // But we can mock it for building.
  const sourceAccount = new StellarSdk.Account(sourceKeypair.publicKey(), "1");

  const innerTx = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: StellarSdk.Keypair.random().publicKey(),
        asset: StellarSdk.Asset.native(),
        amount: "1",
      }),
    )
    .setTimeout(30)
    .build();

  innerTx.sign(sourceKeypair);

  console.log("Inner Transaction Fee:", innerTx.fee);

  try {
    const response = await stellarService.submitFeeBumpTransaction(innerTx);
    console.log("Fee Bump Response:", response);
  } catch (error) {
    console.error("Fee Bump Error:", error);
  }
}

testFeeBump();
