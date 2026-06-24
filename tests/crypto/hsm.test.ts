import { KMSClient } from "@aws-sdk/client-kms";
import { Keypair, TransactionBuilder, Networks, Asset, Operation, Account } from "stellar-sdk";
import hsm, {
  LocalSigner,
  KmsAsymmetricSigner,
  KmsEnvelopeSigner,
  Pkcs11Signer,
  createSigner,
  createSignerFromEnv,
  HsmConfigurationError,
  HsmSigningError,
} from "../../src/crypto/hsm";

// Mock AWS KMS Client
jest.mock("@aws-sdk/client-kms", () => {
  const actual = jest.requireActual("@aws-sdk/client-kms");
  return {
    ...actual,
    KMSClient: jest.fn().mockImplementation(() => ({
      send: jest.fn(),
      destroy: jest.fn(),
    })),
  };
});

describe("HSM Client Wrapper Interfaces", () => {
  let mockKmsClient: any;
  const testKeypair = Keypair.random();
  const testNetwork = Networks.TESTNET;

  // Build a dummy transaction for signing tests
  const buildTestTransaction = () => {
    const destinationAccount = Keypair.random();
    const sourceAccount = new Account(Keypair.random().publicKey(), "123");
    return new TransactionBuilder(
      sourceAccount,
      {
        fee: "100",
        networkPassphrase: testNetwork,
      }
    )
      .addOperation(
        Operation.payment({
          destination: destinationAccount.publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(30)
      .build();
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockKmsClient = {
      send: jest.fn(),
      destroy: jest.fn(),
    };
    (KMSClient as jest.Mock).mockImplementation(() => mockKmsClient);
  });

  describe("LocalSigner", () => {
    it("initializes and signs transactions correctly using local secret key", async () => {
      const signer = new LocalSigner({ secretKey: testKeypair.secret() });
      expect(signer.publicKey).toBe(testKeypair.publicKey());

      const tx = buildTestTransaction();
      const result = await signer.signTransaction(tx);

      expect(result.hash).toBe(tx.hash().toString("hex"));
      expect(tx.signatures.length).toBe(1);

      // Verify the signature on the transaction
      const parsedTx = TransactionBuilder.fromXDR(result.envelopeXdr, testNetwork);
      expect(parsedTx.signatures.length).toBe(1);
    });

    it("throws HsmConfigurationError if secret key is missing", () => {
      expect(() => new LocalSigner({ secretKey: "" })).toThrow(
        HsmConfigurationError
      );
    });
  });

  describe("KmsAsymmetricSigner", () => {
    it("initializes by retrieving and parsing Ed25519 SPKI DER public key from KMS", async () => {
      const rawPublicKey = testKeypair.rawPublicKey();
      const derHeader = Buffer.alloc(12); // Mock 12-byte SPKI header
      const mockSPKIDer = Buffer.concat([derHeader, rawPublicKey]);

      mockKmsClient.send.mockResolvedValueOnce({
        PublicKey: mockSPKIDer,
      });

      const signer = new KmsAsymmetricSigner({ kmsKeyId: "mock-arn" });
      const pubKey = await signer.initialize();

      expect(pubKey).toBe(testKeypair.publicKey());
      expect(signer.publicKey).toBe(testKeypair.publicKey());
      expect(mockKmsClient.send).toHaveBeenCalledTimes(1);
    });

    it("signs transaction hash inside HSM using correct ED25519 algorithm", async () => {
      const rawPublicKey = testKeypair.rawPublicKey();
      const derHeader = Buffer.alloc(12);
      const mockSPKIDer = Buffer.concat([derHeader, rawPublicKey]);

      // Mock KMS getPublicKey
      mockKmsClient.send.mockResolvedValueOnce({
        PublicKey: mockSPKIDer,
      });

      const tx = buildTestTransaction();
      const txHash = tx.hash();
      const mockSignature = testKeypair.sign(txHash);

      // Mock KMS sign
      mockKmsClient.send.mockResolvedValueOnce({
        Signature: mockSignature,
      });

      const signer = new KmsAsymmetricSigner({ kmsKeyId: "mock-arn" });
      const result = await signer.signTransaction(tx);

      expect(result.hash).toBe(txHash.toString("hex"));
      expect(tx.signatures.length).toBe(1);

      // Verify sign call parameters
      const signCall = mockKmsClient.send.mock.calls[1][0];
      expect(signCall.input.SigningAlgorithm).toBe("ED25519");
      expect(signCall.input.MessageType).toBe("RAW");
      expect(signCall.input.Message).toEqual(txHash);
    });

    it("throws HsmConfigurationError if initialized with invalid public key format", async () => {
      mockKmsClient.send.mockResolvedValueOnce({
        PublicKey: Buffer.alloc(10), // Too short
      });

      const signer = new KmsAsymmetricSigner({ kmsKeyId: "mock-arn" });
      await expect(signer.initialize()).rejects.toThrow(HsmConfigurationError);
    });

    it("throws HsmSigningError if KMS sign fails", async () => {
      const rawPublicKey = testKeypair.rawPublicKey();
      const derHeader = Buffer.alloc(12);
      const mockSPKIDer = Buffer.concat([derHeader, rawPublicKey]);

      mockKmsClient.send.mockResolvedValueOnce({ PublicKey: mockSPKIDer });
      mockKmsClient.send.mockRejectedValueOnce(new Error("KMS Error"));

      const signer = new KmsAsymmetricSigner({ kmsKeyId: "mock-arn" });
      const tx = buildTestTransaction();

      await expect(signer.signTransaction(tx)).rejects.toThrow(HsmSigningError);
    });
  });

  describe("KmsEnvelopeSigner", () => {
    it("decrypts envelope seed and signs transaction locally", async () => {
      const seed = testKeypair.rawSecretKey();
      mockKmsClient.send.mockResolvedValueOnce({
        Plaintext: seed,
      });

      const signer = new KmsEnvelopeSigner({
        kmsKeyId: "mock-arn",
        encryptedSeed: "mock-base64-blob",
      });

      const pubKey = await signer.initialize();
      expect(pubKey).toBe(testKeypair.publicKey());

      const tx = buildTestTransaction();
      const txHash = tx.hash();
      const mockSignature = testKeypair.sign(txHash);

      mockKmsClient.send.mockResolvedValueOnce({
        Plaintext: seed,
      });

      const result = await signer.signTransaction(tx);
      expect(result.hash).toBe(txHash.toString("hex"));
      expect(tx.signatures.length).toBe(1);
    });

    it("generates and wraps a fresh Ed25519 seed using KMS", async () => {
      const seed = testKeypair.rawSecretKey();
      mockKmsClient.send.mockResolvedValueOnce({
        Plaintext: seed,
      });
      mockKmsClient.send.mockResolvedValueOnce({
        CiphertextBlob: Buffer.from("new-mock-encrypted-seed"),
      });

      const result = await KmsEnvelopeSigner.generateAndWrapSeed("mock-arn");
      expect(result.publicKey).toBe(testKeypair.publicKey());
      expect(result.encryptedSeed).toBe(
        Buffer.from("new-mock-encrypted-seed").toString("base64")
      );
    });
  });

  describe("Pkcs11Signer", () => {
    it("holds public key but throws HsmSigningError on sign since native binding is missing", async () => {
      const signer = new Pkcs11Signer(
        {
          modulePath: "/usr/lib/libykcs11.so",
          slotId: 1,
          keyId: "key-1",
        },
        testKeypair.publicKey()
      );

      expect(signer.publicKey).toBe(testKeypair.publicKey());
      await expect(signer.sign(Buffer.alloc(32))).rejects.toThrow(
        HsmSigningError
      );
    });
  });

  describe("Factory Helpers", () => {
    it("creates signer cleanly using createSigner configurations", async () => {
      const localSignerConfig = { provider: "local" as const, secretKey: testKeypair.secret() };
      const signer = await createSigner(localSignerConfig);
      expect(signer).toBeInstanceOf(LocalSigner);
    });

    it("creates correct signer from environment variables", async () => {
      process.env.HSM_PROVIDER = "local";
      process.env.STELLAR_ISSUER_SECRET = testKeypair.secret();

      const signer = await createSignerFromEnv();
      expect(signer).toBeInstanceOf(LocalSigner);
      expect(signer.publicKey).toBe(testKeypair.publicKey());
    });
  });
});
