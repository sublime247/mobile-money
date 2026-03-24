import * as StellarSdk from 'stellar-sdk';
import { getStellarServer, getNetworkPassphrase } from '../../config/stellar';
import dotenv from 'dotenv';
dotenv.config();


 console.log(process.env.STELLAR_ISSUER_SECRET);
export class StellarService {
  private server: StellarSdk.Horizon.Server;
  private issuerKeypair: StellarSdk.Keypair;

 
  
  constructor() {
    this.server = getStellarServer();
    const secret = process.env.STELLAR_ISSUER_SECRET;
    if (!secret) throw new Error('STELLAR_ISSUER_SECRET not configured');
    this.issuerKeypair = StellarSdk.Keypair.fromSecret(secret);
  }

  async sendPayment(destinationAddress: string, amount: string): Promise<void> {
    const account = await this.server.loadAccount(this.issuerKeypair.publicKey());
    
    const transaction = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: getNetworkPassphrase()
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: destinationAddress,
          asset: StellarSdk.Asset.native(),
          amount: amount
        })
      )
      .setTimeout(30)
      .build();

    transaction.sign(this.issuerKeypair);
    await this.server.submitTransaction(transaction);
  }

  async getBalance(address: string): Promise<string> {
    const account = await this.server.loadAccount(address);
    const balance = account.balances.find(b => b.asset_type === 'native');
    return balance ? balance.balance : '0';
  }
}
