import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  AnchorVaultClient,
  AnchorVaultError,
  toAnchorVaultError,
} from "../anchorVaultClient";

const CONTRACT_ID = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

function makeServer(overrides: Record<string, jest.Mock> = {}) {
  return {
    simulateTransaction: jest.fn(),
    prepareTransaction: jest.fn(async (tx: Transaction) => tx),
    getAccount: jest.fn(async (id: string) => new Account(id, "1")),
    sendTransaction: jest.fn(),
    getLatestLedger: jest.fn(async () => ({ sequence: 1000 })),
    ...overrides,
  };
}

function simSuccess(retval: xdr.ScVal) {
  return {
    id: "1",
    latestLedger: 1,
    events: [],
    _parsed: true,
    transactionData: undefined,
    minResourceFee: "100",
    result: { auth: [], retval },
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

function client(server = makeServer()) {
  return {
    server,
    vault: new AnchorVaultClient({
      rpcUrl: "http://localhost:8000",
      contractId: CONTRACT_ID,
      networkPassphrase: Networks.TESTNET,
      server: server as any,
    }),
  };
}

describe("AnchorVaultClient views", () => {
  it("reads the pause flag", async () => {
    const { server, vault } = client();
    server.simulateTransaction.mockResolvedValueOnce(
      simSuccess(xdr.ScVal.scvBool(true)),
    );
    await expect(vault.isPaused()).resolves.toBe(true);

    server.simulateTransaction.mockResolvedValueOnce(
      simSuccess(xdr.ScVal.scvBool(true)),
    );
    await expect(vault.assertNotPaused()).rejects.toMatchObject({
      code: "CONTRACT_PAUSED",
    });
  });

  it("maps contract errors to typed codes", async () => {
    const { server, vault } = client();
    server.simulateTransaction.mockResolvedValueOnce({
      id: "1",
      latestLedger: 1,
      events: [],
      _parsed: true,
      error: "HostError: Error(Contract, #2)",
    });
    await expect(vault.isPaused()).rejects.toMatchObject({
      code: "NOT_INITIALIZED",
    });
    expect(toAnchorVaultError("Error(Contract, #6)").code).toBe(
      "THRESHOLD_NOT_MET",
    );
    expect(toAnchorVaultError("Error(Contract, #3)").code).toBe(
      "CONTRACT_PAUSED",
    );
  });

  it("reads a user balance", async () => {
    const { server, vault } = client();
    server.simulateTransaction.mockResolvedValueOnce(
      simSuccess(nativeToScVal(250n, { type: "i128" })),
    );
    await expect(vault.balance(Keypair.random().publicKey())).resolves.toBe(
      250n,
    );
  });
});

describe("AnchorVaultClient multi-sig pause", () => {
  const admins = [Keypair.random(), Keypair.random(), Keypair.random()];
  const source = Keypair.random();

  it("rejects duplicate signers and operators outside the quorum locally", async () => {
    const { vault, server } = client();
    await expect(
      vault.buildPauseTransaction({
        sourceAccount: source.publicKey(),
        operator: admins[0].publicKey(),
        signers: [admins[0].publicKey(), admins[0].publicKey()],
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_SIGNER" });
    await expect(
      vault.buildUnpauseTransaction({
        sourceAccount: source.publicKey(),
        operator: admins[2].publicKey(),
        signers: [admins[0].publicKey(), admins[1].publicKey()],
      }),
    ).rejects.toMatchObject({ code: "OPERATOR_NOT_SIGNER" });
    expect(server.prepareTransaction).not.toHaveBeenCalled();
  });

  it("surfaces on-chain quorum failures from preparation", async () => {
    const { vault } = client(
      makeServer({
        prepareTransaction: jest
          .fn()
          .mockRejectedValue(new Error("HostError: Error(Contract, #6)")),
      }),
    );
    const err = await vault
      .buildPauseTransaction({
        sourceAccount: source.publicKey(),
        operator: admins[0].publicKey(),
        signers: [admins[0].publicKey()],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AnchorVaultError);
    expect(err.code).toBe("THRESHOLD_NOT_MET");
  });

  it("signs only the auth entries belonging to the provided admins", async () => {
    const { vault } = client();
    const signers = [admins[0].publicKey(), admins[1].publicKey()];
    const tx = await vault.buildPauseTransaction({
      sourceAccount: source.publicKey(),
      operator: signers[0],
      signers,
    });

    // Attach one unsigned address-credential entry per signer, as simulation would.
    const [op] = tx.operations as any[];
    const entries = signers.map(
      (pk, i) =>
        new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
            new xdr.SorobanAddressCredentials({
              address: new Address(pk).toScAddress(),
              nonce: xdr.Int64.fromString(String(i + 1)),
              signatureExpirationLedger: 0,
              signature: xdr.ScVal.scvVoid(),
            }),
          ),
          rootInvocation: new xdr.SorobanAuthorizedInvocation({
            function:
              xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
                new xdr.InvokeContractArgs({
                  contractAddress: new Address(CONTRACT_ID).toScAddress(),
                  functionName: "pause",
                  args: [],
                }),
              ),
            subInvocations: [],
          }),
        }),
    );
    const unsigned = new TransactionBuilder(
      new Account(source.publicKey(), "1"),
      { fee: "100", networkPassphrase: Networks.TESTNET },
    )
      .addOperation(Operation.invokeHostFunction({ func: op.func, auth: entries }))
      .setTimeout(30)
      .build();

    // admins[0] signs on their machine; admins[1]'s entry is left for them.
    const partiallySigned = await vault.signAuthEntries(unsigned, [admins[0]]);
    const [first, second] = (partiallySigned.operations[0] as any).auth;

    expect(first.credentials.address.signature.type).toBe("scvVec");
    expect(first.credentials.address.signatureExpirationLedger).toBe(1060);
    expect(second.credentials.address.signature.type).toBe("scvVoid");
    expect(partiallySigned.fee).toBe(unsigned.fee);
  });
});
