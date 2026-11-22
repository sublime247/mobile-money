import { LocationMetadata } from "./geolocation";

export interface IPRiskResult {
  isTorExitNode: boolean;
  isProxy: boolean;
  highRiskJurisdiction: boolean;
  countryCode: string;
  riskScore: number;
}

export class IPReputationService {
  async checkIP(ip: string): Promise<IPRiskResult> {
    // Mock MaxMind / ProxyCheck logic for local testing
    const isTorExitNode = ip === "185.220.101.1" || ip === "192.42.116.16"; // example mock IPs
    const isProxy = ip.startsWith("104.28."); // example proxy
    const countryCode = "US"; // Default mock country
    const highRiskJurisdiction = ["KP", "IR", "SY"].includes(countryCode);
    
    let riskScore = 0;
    if (isTorExitNode) riskScore += 90;
    if (isProxy) riskScore += 50;
    if (highRiskJurisdiction) riskScore += 100;
    
    return {
      isTorExitNode,
      isProxy,
      highRiskJurisdiction,
      countryCode,
      riskScore: Math.min(riskScore, 100)
    };
  }
}

export const ipReputationService = new IPReputationService();
