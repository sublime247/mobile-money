import * as StellarSdk from "@stellar/stellar-sdk";
import { Sep10Service } from "../../../src/services/stellar/sep10";
import { Networks } from "@stellar/stellar-sdk";

describe("SEP-10: Webauth challenge signing validation for non-custodial custodial split & multisig (Issue #2266)", () => {
  const serverKeypair = StellarSdk.Keypair.random();
  const masterKeypair = StellarSdk.Keypair.random();
  const userSignerKeypair = StellarSdk.Keypair.random();
  const custodianSignerKeypair = StellarSdk.Keypair.random();
  const unauthorizedKeypair = StellarSdk.Keypair.random();

  const config = {
    signingKey: serverKeypair.secret(),
    webAuthDomain: "https://auth.example.com",
    networkPassphrase: Networks.TESTNET,
    jwtSecret: "test-jwt-secret-multisig",
    challengeExpiresIn: 900,
    jwtExpiresIn: "1h",
    homeDomain: "auth.example.com",
  };

  describe("Non-custodial / Custodial Split Accounts (e.g. SEP-30 with master weight 0)", () => {
    it("should reject challenge transactions when master key weight is 0 and only master signs", async () => {
      // Non-custodial split account: master key has weight 0, signers are user + custodian (threshold = 20)
      const mockHorizonAccount = {
        id: masterKeypair.publicKey(),
        account_id: masterKeypair.publicKey(),
        thresholds: {
          master_weight: 0,
          low_threshold: 10,
          med_threshold: 20,
          high_threshold: 30,
        },
        signers: [
          { key: masterKeypair.publicKey(), type: "ed25519_public_key", weight: 0 },
          { key: userSignerKeypair.publicKey(), type: "ed25519_public_key", weight: 10 },
          { key: custodianSignerKeypair.publicKey(), type: "ed25519_public_key", weight: 10 },
        ],
      };

      const mockServer = {
        loadAccount: jest.fn().mockResolvedValue(mockHorizonAccount),
      };

      const service = new Sep10Service(config, mockServer as any);
      const challenge = await service.generateChallenge(masterKeypair.publicKey());

      const tx = StellarSdk.TransactionBuilder.fromXDR(
        challenge.transaction,
        Networks.TESTNET,
      ) as StellarSdk.Transaction;

      // Sign ONLY with master key (which has weight 0)
      tx.sign(masterKeypair);

      await expect(
        service.verifyChallenge(tx.toXDR(), masterKeypair.publicKey()),
      ).rejects.toThrow("Signing threshold not met");
    });

    it("should reject challenge signed only by user key when threshold requires co-signing", async () => {
      const mockHorizonAccount = {
        id: masterKeypair.publicKey(),
        thresholds: {
          master_weight: 0,
          low_threshold: 10,
          med_threshold: 20,
          high_threshold: 30,
        },
        signers: [
          { key: masterKeypair.publicKey(), type: "ed25519_public_key", weight: 0 },
          { key: userSignerKeypair.publicKey(), type: "ed25519_public_key", weight: 10 },
          { key: custodianSignerKeypair.publicKey(), type: "ed25519_public_key", weight: 10 },
        ],
      };

      const mockServer = {
        loadAccount: jest.fn().mockResolvedValue(mockHorizonAccount),
      };

      const service = new Sep10Service(config, mockServer as any);
      const challenge = await service.generateChallenge(masterKeypair.publicKey());

      const tx = StellarSdk.TransactionBuilder.fromXDR(
        challenge.transaction,
        Networks.TESTNET,
      ) as StellarSdk.Transaction;

      // Sign with user key only (weight 10 < 20)
      tx.sign(userSignerKeypair);

      await expect(
        service.verifyChallenge(tx.toXDR(), masterKeypair.publicKey()),
      ).rejects.toThrow("Signing threshold not met");
    });

    it("should reject challenge signed by unauthorized signer not present in Horizon ledger state", async () => {
      const mockHorizonAccount = {
        id: masterKeypair.publicKey(),
        thresholds: {
          master_weight: 0,
          low_threshold: 10,
          med_threshold: 20,
          high_threshold: 30,
        },
        signers: [
          { key: masterKeypair.publicKey(), type: "ed25519_public_key", weight: 0 },
          { key: userSignerKeypair.publicKey(), type: "ed25519_public_key", weight: 10 },
          { key: custodianSignerKeypair.publicKey(), type: "ed25519_public_key", weight: 10 },
        ],
      };

      const mockServer = {
        loadAccount: jest.fn().mockResolvedValue(mockHorizonAccount),
      };

      const service = new Sep10Service(config, mockServer as any);
      const challenge = await service.generateChallenge(masterKeypair.publicKey());

      const tx = StellarSdk.TransactionBuilder.fromXDR(
        challenge.transaction,
        Networks.TESTNET,
      ) as StellarSdk.Transaction;

      // Sign with an unauthorized signer
      tx.sign(unauthorizedKeypair);

      await expect(
        service.verifyChallenge(tx.toXDR(), masterKeypair.publicKey()),
      ).rejects.toThrow("Signing threshold not met");
    });

    it("should successfully authenticate when both user and custodian sign to satisfy the multisig threshold", async () => {
      const mockHorizonAccount = {
        id: masterKeypair.publicKey(),
        thresholds: {
          master_weight: 0,
          low_threshold: 10,
          med_threshold: 20,
          high_threshold: 30,
        },
        signers: [
          { key: masterKeypair.publicKey(), type: "ed25519_public_key", weight: 0 },
          { key: userSignerKeypair.publicKey(), type: "ed25519_public_key", weight: 10 },
          { key: custodianSignerKeypair.publicKey(), type: "ed25519_public_key", weight: 10 },
        ],
      };

      const mockServer = {
        loadAccount: jest.fn().mockResolvedValue(mockHorizonAccount),
      };

      const service = new Sep10Service(config, mockServer as any);
      const challenge = await service.generateChallenge(masterKeypair.publicKey());

      const tx = StellarSdk.TransactionBuilder.fromXDR(
        challenge.transaction,
        Networks.TESTNET,
      ) as StellarSdk.Transaction;

      // Both user signer (10) and custodian signer (10) sign = 20 >= 20
      tx.sign(userSignerKeypair);
      tx.sign(custodianSignerKeypair);

      const response = await service.verifyChallenge(tx.toXDR(), masterKeypair.publicKey());
      expect(response.token).toBeDefined();
    });
  });

  describe("Backwards Compatibility with Standard Single-Key Ed25519 Accounts", () => {
    it("should successfully authenticate standard single-key account with master weight = 1", async () => {
      const singleKeypair = StellarSdk.Keypair.random();
      const mockHorizonAccount = {
        id: singleKeypair.publicKey(),
        account_id: singleKeypair.publicKey(),
        thresholds: {
          master_weight: 1,
          low_threshold: 0,
          med_threshold: 1,
          high_threshold: 1,
        },
        signers: [
          { key: singleKeypair.publicKey(), type: "ed25519_public_key", weight: 1 },
        ],
      };

      const mockServer = {
        loadAccount: jest.fn().mockResolvedValue(mockHorizonAccount),
      };

      const service = new Sep10Service(config, mockServer as any);
      const challenge = await service.generateChallenge(singleKeypair.publicKey());

      const tx = StellarSdk.TransactionBuilder.fromXDR(
        challenge.transaction,
        Networks.TESTNET,
      ) as StellarSdk.Transaction;

      tx.sign(singleKeypair);

      const response = await service.verifyChallenge(tx.toXDR(), singleKeypair.publicKey());
      expect(response.token).toBeDefined();
    });
  });
});
