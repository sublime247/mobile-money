describe("OIDC payload validation", () => {
  const loadOidc = async () => {
    jest.resetModules();
    process.env.SSO_GOOGLE_CLIENT_ID = "google-client-id";
    process.env.SSO_AZURE_OIDC_CLIENT_ID = "azure-client-id";
    process.env.SSO_AZURE_OIDC_ISSUER = "https://login.microsoftonline.com/test-tenant/v2.0";
    return await import("../../src/auth/oidc");
  };

  it("rejects Google payload when email is not verified", async () => {
    const oidc = await loadOidc();
    const profile = {
      provider: "google",
      id: "google-subject",
      emails: [{ value: "alice@example.com" }],
      _json: {
        email: "alice@example.com",
        email_verified: false,
        iss: "https://accounts.google.com",
        aud: "google-client-id",
      },
    };

    await expect(oidc.validateGoogleOIDCProfile(profile)).rejects.toThrow(
      "Google account email must be verified",
    );
  });

  it("rejects Google payload when subject is missing", async () => {
    const oidc = await loadOidc();
    const profile = {
      provider: "google",
      emails: [{ value: "alice@example.com" }],
      _json: {
        email: "alice@example.com",
        email_verified: true,
        iss: "https://accounts.google.com",
        aud: "google-client-id",
      },
    };

    await expect(oidc.validateGoogleOIDCProfile(profile)).rejects.toThrow(
      "Google subject is required",
    );
  });

  it("accepts valid Google payload with verified email", async () => {
    const oidc = await loadOidc();
    const profile = {
      provider: "google",
      id: "google-subject",
      emails: [{ value: "alice@example.com" }],
      _json: {
        email: "alice@example.com",
        email_verified: true,
        iss: "https://accounts.google.com",
        aud: "google-client-id",
      },
    };

    const validated = await oidc.validateGoogleOIDCProfile(profile);
    expect(validated.email).toBe("alice@example.com");
    expect(validated.subject).toBe("google-subject");
  });

  it("rejects Azure payload when issuer mismatches", async () => {
    const oidc = await loadOidc();
    const profile = {
      provider: "azure",
      id: "azure-subject",
      emails: [{ value: "bob@example.com" }],
      _json: {
        email: "bob@example.com",
        iss: "https://login.microsoftonline.com/other-tenant/v2.0",
        aud: "azure-client-id",
      },
    };

    await expect(oidc.validateAzureOIDCProfile(profile)).rejects.toThrow(
      "Azure token issuer mismatch",
    );
  });

  it("rejects Azure payload when email is missing", async () => {
    const oidc = await loadOidc();
    const profile = {
      provider: "azure",
      id: "azure-subject",
      _json: {
        iss: "https://login.microsoftonline.com/test-tenant/v2.0",
        aud: "azure-client-id",
      },
    };

    await expect(oidc.validateAzureOIDCProfile(profile)).rejects.toThrow(
      "Azure email is required",
    );
  });
});
