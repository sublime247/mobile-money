import {
  saveXeroOAuthState,
  consumeXeroOAuthState,
  __clearXeroOAuthStateMemoryStore,
} from "../xeroOauthState";

// Force the in-memory fallback path (redisClient.isOpen === false in tests).
jest.mock("../../config/redis", () => ({
  redisClient: { isOpen: false },
}));

describe("xeroOauthState", () => {
  beforeEach(() => {
    __clearXeroOAuthStateMemoryStore();
  });

  it("stores and resolves a state -> userId mapping", async () => {
    await saveXeroOAuthState("state-1", "user-1");
    const userId = await consumeXeroOAuthState("state-1");
    expect(userId).toBe("user-1");
  });

  it("is single-use (replay protection)", async () => {
    await saveXeroOAuthState("state-2", "user-2");
    expect(await consumeXeroOAuthState("state-2")).toBe("user-2");
    // Second consumption must fail.
    expect(await consumeXeroOAuthState("state-2")).toBeNull();
  });

  it("returns null for unknown state (CSRF defense)", async () => {
    expect(await consumeXeroOAuthState("does-not-exist")).toBeNull();
  });

  it("returns null for empty state", async () => {
    expect(await consumeXeroOAuthState("")).toBeNull();
  });
});
