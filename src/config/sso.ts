import { SSOConfig } from "../auth/sso.js";

/**
 * SSO Configuration
 * Loads SSO provider configuration from environment variables
 */

export interface SSOEnvironmentConfig {
  enabled: boolean;
  providers: SSOConfig[];
  enforceSSOForEmployees: boolean;
  employeeEmailDomain?: string;
  oidc: {
    google?: {
      clientID?: string;
      clientSecret?: string;
      callbackURL?: string;
    };
    azure?: {
      clientID?: string;
      clientSecret?: string;
      issuer?: string;
      callbackURL?: string;
    };
  };
}

/**
 * Parse SSO configuration from environment variables
 * Supports multiple SSO providers via comma-separated env vars
 */
export function loadSSOConfig(): SSOEnvironmentConfig {
  const enabled = process.env.SSO_ENABLED === "true";

  if (!enabled) {
    return {
      enabled: false,
      providers: [],
      enforceSSOForEmployees: false,
      oidc: {},
    };
  }

  const providers: SSOConfig[] = [];

  // Load Okta configuration
  if (process.env.SSO_OKTA_ENABLED === "true") {
    providers.push({
      providerName: process.env.SSO_OKTA_NAME || "Okta",
      providerType: "okta",
      entryPoint: process.env.SSO_OKTA_ENTRY_POINT || "",
      issuer: process.env.SSO_OKTA_ISSUER || "",
      cert: process.env.SSO_OKTA_CERT || "",
      callbackUrl: process.env.SSO_OKTA_CALLBACK_URL || "",
    });
  }

  // Load Entra (Azure AD) configuration
  if (process.env.SSO_ENTRA_ENABLED === "true") {
    providers.push({
      providerName: process.env.SSO_ENTRA_NAME || "Entra",
      providerType: "entra",
      entryPoint: process.env.SSO_ENTRA_ENTRY_POINT || "",
      issuer: process.env.SSO_ENTRA_ISSUER || "",
      cert: process.env.SSO_ENTRA_CERT || "",
      callbackUrl: process.env.SSO_ENTRA_CALLBACK_URL || "",
    });
  }

  // Load generic SAML configuration
  if (process.env.SSO_SAML_ENABLED === "true") {
    providers.push({
      providerName: process.env.SSO_SAML_NAME || "SAML",
      providerType: "saml",
      entryPoint: process.env.SSO_SAML_ENTRY_POINT || "",
      issuer: process.env.SSO_SAML_ISSUER || "",
      cert: process.env.SSO_SAML_CERT || "",
      callbackUrl: process.env.SSO_SAML_CALLBACK_URL || "",
    });
  }

  return {
    enabled,
    providers,
    enforceSSOForEmployees: process.env.SSO_ENFORCE_EMPLOYEES === "true",
    employeeEmailDomain: process.env.SSO_EMPLOYEE_EMAIL_DOMAIN,
    oidc: {
      google: {
        clientID: process.env.SSO_GOOGLE_CLIENT_ID,
        clientSecret: process.env.SSO_GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.SSO_GOOGLE_CALLBACK_URL,
      },
      azure: {
        clientID: process.env.SSO_AZURE_OIDC_CLIENT_ID,
        clientSecret: process.env.SSO_AZURE_OIDC_CLIENT_SECRET,
        issuer: process.env.SSO_AZURE_OIDC_ISSUER,
        callbackURL: process.env.SSO_AZURE_OIDC_CALLBACK_URL,
      },
    },
  };
}

/**
 * Validate SSO configuration
 */
export function validateSSOConfig(config: SSOEnvironmentConfig): string[] {
  const errors: string[] = [];

  if (!config.enabled) {
    return errors;
  }

  if (config.providers.length === 0) {
    errors.push("SSO is enabled but no providers are configured");
  }

  for (const provider of config.providers) {
    if (!provider.entryPoint) {
      errors.push(`Provider ${provider.providerName}: entryPoint is required`);
    }
    if (!provider.issuer) {
      errors.push(`Provider ${provider.providerName}: issuer is required`);
    }
    if (!provider.cert) {
      errors.push(`Provider ${provider.providerName}: cert is required`);
    }
    if (!provider.callbackUrl) {
      errors.push(`Provider ${provider.providerName}: callbackUrl is required`);
    }
  }

  if (config.enforceSSOForEmployees && !config.employeeEmailDomain) {
    errors.push(
      "SSO_ENFORCE_EMPLOYEES is enabled but SSO_EMPLOYEE_EMAIL_DOMAIN is not set"
    );
  }

  if (
    config.oidc.google &&
    (config.oidc.google.clientID || config.oidc.google.clientSecret || config.oidc.google.callbackURL)
  ) {
    if (
      !config.oidc.google.clientID ||
      !config.oidc.google.clientSecret ||
      !config.oidc.google.callbackURL
    ) {
      errors.push(
        "SSO OIDC Google configuration is incomplete: clientID, clientSecret, and callbackURL are required"
      );
    }
  }

  if (
    config.oidc.azure &&
    (config.oidc.azure.clientID || config.oidc.azure.clientSecret || config.oidc.azure.issuer || config.oidc.azure.callbackURL)
  ) {
    if (
      !config.oidc.azure.clientID ||
      !config.oidc.azure.clientSecret ||
      !config.oidc.azure.issuer ||
      !config.oidc.azure.callbackURL
    ) {
      errors.push(
        "SSO OIDC Azure configuration is incomplete: clientID, clientSecret, issuer, and callbackURL are required"
      );
    }
  }

  return errors;
}

/**
 * Initialize SSO providers in database from environment configuration
 */
export async function initializeSSOProviders(): Promise<void> {
  const config = loadSSOConfig();
  const errors = validateSSOConfig(config);

  if (errors.length > 0) {
    console.error("[SSO] Configuration errors:", errors);
    throw new Error(`SSO configuration invalid: ${errors.join(", ")}`);
  }

  if (!config.enabled) {
    console.log("[SSO] SSO is disabled");
    return;
  }

  const { ssoService } = await import("../auth/sso.js");

  for (const providerConfig of config.providers) {
    try {
      await ssoService.upsertProvider(providerConfig);
      console.log(
        `[SSO] Initialized provider: ${providerConfig.providerName}`
      );
    } catch (error) {
      console.error(
        `[SSO] Failed to initialize provider ${providerConfig.providerName}:`,
        error
      );
    }
  }

  console.log(`[SSO] Initialized ${config.providers.length} provider(s)`);
}

export const ssoConfig = loadSSOConfig();
