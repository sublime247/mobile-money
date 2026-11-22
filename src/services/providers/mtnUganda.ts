import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { configSchema } from '../../config/appConfig';
import { BaseProvider } from './baseProvider';
import { pool } from '../../config/database'; 

export class MtnUgandaProvider extends BaseProvider {
  private token: string | null = null;
  private tokenExpiry: number | null = null;

  private getMtnConfig() {
    const config = configSchema.getProperties() as any;
    return config.mtnUganda ?? {
      apiUser: process.env.MTN_UGANDA_API_USER ?? "",
      apiKey: process.env.MTN_UGANDA_API_KEY ?? "",
      baseUrl: process.env.MTN_UGANDA_BASE_URL ?? "https://sandbox.momodeveloper.mtn.com",
      subscriptionKey: process.env.MTN_UGANDA_SUBSCRIPTION_KEY ?? "",
      currency: process.env.MTN_UGANDA_CURRENCY ?? "UGX",
      environment: process.env.MTN_UGANDA_ENV ?? "sandbox",
    };
  }

  /**
   * Acceptance Criteria 1: Build MTN auth handshake logic.
   * Uses Basic Auth with apiUser and apiKey to fetch a Bearer token.
   */
  public async getAccessToken(): Promise<string> {
    // Return cached token if valid (leaving a 5-minute buffer)
    if (this.token && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.token;
    }

    const mtnConfig = this.getMtnConfig();
    const { apiUser, apiKey, baseUrl, subscriptionKey } = mtnConfig;
    const authString = Buffer.from(`${apiUser}:${apiKey}`).toString('base64');

    try {
      const response = await axios.post(
        `${baseUrl}/disbursement/token/`,
        {},
        {
          headers: {
            'Authorization': `Basic ${authString}`,
            'Ocp-Apim-Subscription-Key': subscriptionKey,
          },
        }
      );

      this.token = response.data.access_token;
      this.tokenExpiry = Date.now() + (response.data.expires_in - 300) * 1000;
      return this.token as string;
    } catch (error) {
      console.error('MTN Uganda Auth Failed:', error);
      throw new Error('Failed to authenticate with MTN Uganda API');
    }
  }

  /**
   * Validation Check: Supports MTN UGX MSISDN formats.
   */
  public validatePhoneNumber(phoneNumber: string): boolean {
    // Standard UGX prefix: 256 followed by 9 digits (e.g., 25677, 25678, 25676)
    const regex = /^256(77|78|76|39)\d{7}$/;
    return regex.test(phoneNumber);
  }

  /**
   * Acceptance Criteria 2: Execute Payout
   */
  public async executePayout(transactionId: string, amount: number, phoneNumber: string, message: string = 'Payout'): Promise<any> {
    if (!this.validatePhoneNumber(phoneNumber)) {
      throw new Error('Invalid MTN UGX Phone Number format.');
    }

    const token = await this.getAccessToken();
    const referenceId = uuidv4(); // MTN requires a UUID v4 in the X-Reference-Id header
    const mtnConfig = this.getMtnConfig();

    const payload = {
      amount: amount.toString(),
      currency: mtnConfig.currency,
      externalId: transactionId,
      payee: {
        partyIdType: 'MSISDN',
        partyId: phoneNumber,
      },
      payerMessage: message,
      payeeNote: message,
    };

    try {
      await axios.post(
        `${mtnConfig.baseUrl}/disbursement/v1_0/transfer`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Reference-Id': referenceId,
            'X-Target-Environment': mtnConfig.environment,
            'Ocp-Apim-Subscription-Key': mtnConfig.subscriptionKey,
            'Content-Type': 'application/json',
          },
        }
      );

      // Save initial PENDING state to DB
      await this.syncPayoutStatus(transactionId, referenceId, 'PENDING');

      return { success: true, referenceId, status: 'PENDING' };
    } catch (error) {
      console.error('MTN UGX Payout Initiation Failed:', error);
      await this.syncPayoutStatus(transactionId, referenceId, 'FAILED');
      throw new Error('Failed to initiate MTN Uganda payout');
    }
  }

  /**
   * Acceptance Criteria 2: Sync payout statuses cleanly with database records.
   * Polls the MTN API and updates the local DB.
   */
  public async checkAndSyncStatus(transactionId: string, referenceId: string): Promise<string> {
    const token = await this.getAccessToken();
    const mtnConfig = this.getMtnConfig();

    try {
      const response = await axios.get(
        `${mtnConfig.baseUrl}/disbursement/v1_0/transfer/${referenceId}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Target-Environment': mtnConfig.environment,
            'Ocp-Apim-Subscription-Key': mtnConfig.subscriptionKey,
          },
        }
      );

      // MTN API returns statuses like SUCCESSFUL, PENDING, or FAILED
      const status = response.data.status; 
      await this.syncPayoutStatus(transactionId, referenceId, status);
      return status;
    } catch (error) {
      console.error(`Failed to check status for Reference: ${referenceId}`, error);
      throw new Error('Failed to fetch transaction status from MTN');
    }
  }

  /**
   * Database Sync Wrapper
   */
  private async syncPayoutStatus(transactionId: string, providerReference: string, status: string): Promise<void> {
    await pool.query(
      'UPDATE transactions SET status = $1, provider_reference = $2, updated_at = NOW() WHERE id = $3',
      [status, providerReference, transactionId]
    );
  }
}