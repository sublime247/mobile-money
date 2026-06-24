import {
  ApiKeyScope,
  ScopeSets,
  listAllScopeNames,
  createApiKey,
  describeScopes,
  validateTimeWindow,
  hasScope,
} from "../apikeys";

describe("ApiKey scopes and helpers", () => {
  test("ScopeSets exposes resource arrays", () => {
    expect(ScopeSets).toHaveProperty("TRANSACTIONS");
    expect(ScopeSets.TRANSACTIONS).toEqual(
      expect.arrayContaining(["TRANSACTIONS_READ", "TRANSACTIONS_WRITE"]),
    );
    expect(ScopeSets).toHaveProperty("DEPOSITS");
    expect(ScopeSets.DEPOSITS).toEqual(
      expect.arrayContaining(["DEPOSITS_READ", "DEPOSITS_INITIATE"]),
    );
  });

  test("listAllScopeNames includes known scopes", () => {
    const all = listAllScopeNames();
    expect(all).toEqual(expect.arrayContaining(["DEPOSITS_INITIATE", "TRANSACTIONS_READ"]));
  });

  test("createApiKey honors named scopes and sets permissions bitmask", () => {
    const user: { apiKeys?: any[] } = { apiKeys: [] };
    const key = createApiKey(user, {
      scopes: ["DEPOSITS_INITIATE", "DEPOSITS_READ"],
      expiresInDays: 1,
    });

    expect(key.scopes).toEqual(expect.arrayContaining(["DEPOSITS_INITIATE", "DEPOSITS_READ"]));
    expect((key.permissions & ApiKeyScope.DEPOSITS_INITIATE) === ApiKeyScope.DEPOSITS_INITIATE).toBe(true);
    expect((key.permissions & ApiKeyScope.DEPOSITS_READ) === ApiKeyScope.DEPOSITS_READ).toBe(true);
  });

  test("describeScopes returns names for a permission bitmask", () => {
    const mask = ApiKeyScope.TRANSACTIONS_READ | ApiKeyScope.BALANCE_READ;
    const names = describeScopes(mask);
    expect(names).toEqual(expect.arrayContaining(["TRANSACTIONS_READ", "BALANCE_READ"]));
  });

  test("validateTimeWindow catches invalid values and accepts valid windows", () => {
    expect(validateTimeWindow({ startHour: 24, endHour: 1 })).toBeTruthy();
    expect(validateTimeWindow({ startHour: 1, endHour: 1 })).toBe("startHour and endHour must differ");
    expect(validateTimeWindow({ startHour: 0, endHour: 23 })).toBeNull();
  });

  test("hasScope recognizes a granted scope", () => {
    const mask = ApiKeyScope.DEPOSITS_INITIATE | ApiKeyScope.DEPOSITS_READ;
    const fakeKey = { permissions: mask } as any;
    expect(hasScope(fakeKey, ApiKeyScope.DEPOSITS_INITIATE)).toBe(true);
    expect(hasScope(fakeKey, ApiKeyScope.TRANSACTIONS_READ)).toBe(false);
  });
});
