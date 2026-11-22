import { metadataCache } from "../utils/lruCache";

export class MetadataService {
  async getCountryCodes() {
    const key = "country_codes";
    if (metadataCache.has(key)) {
      return metadataCache.get(key);
    }
    const data = await this.fetchCountryCodesFromDb();
    metadataCache.set(key, data);
    return data;
  }

  async getProviderCapabilities() {
    const key = "provider_capabilities";
    if (metadataCache.has(key)) {
      return metadataCache.get(key);
    }
    const data = await this.fetchProviderCapabilitiesFromDb();
    metadataCache.set(key, data);
    return data;
  }

  async getFeeTiers() {
    const key = "fee_tiers";
    if (metadataCache.has(key)) {
      return metadataCache.get(key);
    }
    const data = await this.fetchFeeTiersFromDb();
    metadataCache.set(key, data);
    return data;
  }

  async getAssetConfigurations() {
    const key = "asset_configurations";
    if (metadataCache.has(key)) {
      return metadataCache.get(key);
    }
    const data = await this.fetchAssetConfigurationsFromDb();
    metadataCache.set(key, data);
    return data;
  }

  async invalidateCache() {
    metadataCache.clear();
  }

  private async fetchCountryCodesFromDb() {
    // Mock database fetch
    return [{ code: "US" }, { code: "UK" }, { code: "NG" }];
  }

  private async fetchProviderCapabilitiesFromDb() {
    // Mock database fetch
    return { mtn: ["mobile_money", "airtime"], moov: ["mobile_money"] };
  }

  private async fetchFeeTiersFromDb() {
    // Mock database fetch
    return [{ tier: 1, fee: "1.00" }, { tier: 2, fee: "2.00" }];
  }
  
  private async fetchAssetConfigurationsFromDb() {
    // Mock database fetch
    return [{ asset: "USDC", type: "stablecoin" }];
  }
}

export const metadataService = new MetadataService();
