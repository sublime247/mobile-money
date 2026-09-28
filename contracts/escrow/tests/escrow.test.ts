
import { EscrowContractClient } from "../client";
import { Ledger, Invariant, Address, U32, U128 } from "@soroban/sdk";
import { TestContext } from "@soroban/sdk/test";

describe("Escrow Reentrancy Protection", () => {
    let ctx: TestContext;
    let contract: EscrowContractClient;
    let alice: Address;
    let bob: Address;

    beforeAll(async () => {
        ctx = new TestContext();
        await ctx.run("Deploy contract", async ctx => {
            contract = new EscrowContractClient(ctx, ctx.contractId("escrow"));
            alice = ctx.accounts.get("alice").address;
            bob = ctx.accounts.get("bob").address;
        });
    });

    it("should prevent reentrant lock_funds calls", async () => {
        const operationId = U32.fromI32(1);
        await expect(
            contract.lock_funds(ctx, alice, U128.fromI32(100), operationId)
        ).resolves.not.toThrow();

        await expect(
            contract.lock_funds(ctx, alice, U128.fromI32(50), operationId)
        ).rejects.toThrow("ReentrancyGuardError");
    });

    it("should prevent reentrant release_funds calls", async () => {
        const operationId = U32.fromI32(2);
        await contract.lock_funds(ctx, alice, U128.fromI32(200), operationId);

        await expect(
            contract.release_funds(ctx, alice, U128.fromI32(100), operationId)
        ).resolves.not.toThrow();

        await expect(
            contract.release_funds(ctx, alice, U128.fromI32(50), operationId)
        ).rejects.toThrow("ReentrancyGuardError");
    });

    it("should clear temporary storage after successful release", async () => {
        const operationId = U32.fromI32(3);
        await contract.lock_funds(ctx, alice, U128.fromI32(300), operationId);

        // Simulate reentrancy attack by calling release twice
        await contract.release_funds(ctx, alice, U128.fromI32(200), operationId);

        // Second call should fail
        await expect(
            contract.release_funds(ctx, alice, U128.fromI32(100), operationId)
        ).rejects.toThrow("InvalidOperationId");
    });
});
