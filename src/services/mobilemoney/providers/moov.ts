import { MobileMoneyProvider, ProviderTransactionStatus } from "../mobileMoneyService";
import crypto from "crypto";
import logger from "../../../utils/logger";
import { maskPII } from "../../../utils/masking";
import axios from "axios";

export class MoovProvider implements MobileMoneyProvider {
  private privateKey: string;
  private publicKey: string;
  private baseUrl: string;

  constructor() {
    this.privateKey = process.env.MOOV_PRIVATE_KEY || "";
    this.publicKey = process.env.MOOV_PUBLIC_KEY || "";
    this.baseUrl = process.env.MOOV_BASE_URL || "https://api.moov.com/soap";
  }

  // sign the XML payload using RSA-SHA256
  public signPayload(xml: string): string {
    if (!this.privateKey) {
      throw new Error("Moov Provider: Private key (MOOV_PRIVATE_KEY) is missing");
    }
    const cleanKey = this.privateKey.trim();
    const sign = crypto.createSign("SHA256");
    sign.update(xml);
    return sign.sign(cleanKey, "base64");
  }

  // verify the XML response payload signature using RSA-SHA256
  public verifyResponse(xml: string, signature: string): boolean {
    if (!this.publicKey) {
      throw new Error("Moov Provider: Public key (MOOV_PUBLIC_KEY) is missing");
    }
    const cleanKey = this.publicKey.trim();
    const verify = crypto.createVerify("SHA256");
    verify.update(xml);
    return verify.verify(cleanKey, signature, "base64");
  }

  private buildSoapEnvelope(action: string, bodyContent: string, signature: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <Signature xmlns="http://www.moov.com/security">${signature}</Signature>
    <Action>${action}</Action>
  </soap:Header>
  <soap:Body>
    ${bodyContent}
  </soap:Body>
</soap:Envelope>`;
  }

  private getSoapBodyContent(xml: string): string {
    const match = xml.match(/<soap:Body[^>]*>([\s\S]*?)<\/soap:Body>/);
    if (!match) {
      throw new Error("Moov Provider: SOAP response is missing Body element");
    }
    return match[1].trim();
  }

  private getXmlElementValue(xml: string, tagName: string): string {
    const match = xml.match(new RegExp(`<${tagName}[^>]*>([^<]+)<\/${tagName}>`));
    return match ? match[1] : "";
  }

  private isSupportedCountry(phoneNumber: string): boolean {
    const trimmed = phoneNumber.trim();
    // Moov Money covers Benin (+229), Togo (+228), and Côte d'Ivoire (+225)
    return trimmed.startsWith("+229") || trimmed.startsWith("+228") || trimmed.startsWith("+225");
  }

  async requestPayment(
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ) {
    const reqId = requestId || `moov-pay-${Date.now()}`;
    const log = logger.child({ requestId: reqId });
    log.info(maskPII({ phoneNumber, amount }), "Moov: Requesting payment");

    if (!this.isSupportedCountry(phoneNumber)) {
      const errorMsg = "Moov Money only supports Benin (+229), Togo (+228), and Côte d'Ivoire (+225) phone numbers";
      log.error({ phoneNumber }, errorMsg);
      return { success: false, error: errorMsg };
    }

    const startTime = Date.now();
    try {
      const bodyContent = `<RequestPayment><PhoneNumber>${phoneNumber}</PhoneNumber><Amount>${amount}</Amount><RequestId>${reqId}</RequestId></RequestPayment>`;
      const signature = this.signPayload(bodyContent);
      const requestXml = this.buildSoapEnvelope("RequestPayment", bodyContent, signature);

      const response = await axios.post(this.baseUrl, requestXml, {
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          "Accept": "text/xml",
          SOAPAction: "RequestPayment",
        },
      });

      const responseXml = response.data;
      const signatureMatch = responseXml.match(/<Signature[^>]*>([^<]+)<\/Signature>/);
      if (!signatureMatch) {
        throw new Error("Response signature verification failed: SOAP response is missing Signature header");
      }
      const resSignature = signatureMatch[1].trim();
      const bodyXml = this.getSoapBodyContent(responseXml);
      
      if (!this.verifyResponse(bodyXml, resSignature)) {
        throw new Error("Response signature verification failed");
      }

      const status = this.getXmlElementValue(responseXml, "Status");
      const transactionId = this.getXmlElementValue(responseXml, "TransactionId");
      const duration = Date.now() - startTime;

      if (status === "SUCCESS" || status === "PENDING") {
        log.info(
          maskPII({ duration, transactionId, status }),
          "Moov: Payment request successful",
        );
        return {
          success: true,
          data: { transactionId, status },
          providerResponseTimeMs: duration,
        };
      } else {
        const errorDetail = this.getXmlElementValue(responseXml, "ErrorDetail") || "Payment request failed";
        throw new Error(errorDetail);
      }
    } catch (error: any) {
      const duration = Date.now() - startTime;
      log.error(
        maskPII({ duration, error: error.message }),
        "Moov: Payment request failed",
      );
      return {
        success: false,
        error: error.message || error,
        providerResponseTimeMs: duration,
      };
    }
  }

  async sendPayout(phoneNumber: string, amount: string, requestId?: string) {
    const reqId = requestId || `moov-payout-${Date.now()}`;
    const log = logger.child({ requestId: reqId });
    log.info(maskPII({ phoneNumber, amount }), "Moov: Sending payout");

    if (!this.isSupportedCountry(phoneNumber)) {
      const errorMsg = "Moov Money only supports Benin (+229), Togo (+228), and Côte d'Ivoire (+225) phone numbers";
      log.error({ phoneNumber }, errorMsg);
      return { success: false, error: errorMsg };
    }

    const startTime = Date.now();
    try {
      const bodyContent = `<SendPayout><PhoneNumber>${phoneNumber}</PhoneNumber><Amount>${amount}</Amount><RequestId>${reqId}</RequestId></SendPayout>`;
      const signature = this.signPayload(bodyContent);
      const requestXml = this.buildSoapEnvelope("SendPayout", bodyContent, signature);

      const response = await axios.post(this.baseUrl, requestXml, {
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          "Accept": "text/xml",
          SOAPAction: "SendPayout",
        },
      });

      const responseXml = response.data;
      const signatureMatch = responseXml.match(/<Signature[^>]*>([^<]+)<\/Signature>/);
      if (!signatureMatch) {
        throw new Error("Response signature verification failed: SOAP response is missing Signature header");
      }
      const resSignature = signatureMatch[1].trim();
      const bodyXml = this.getSoapBodyContent(responseXml);

      if (!this.verifyResponse(bodyXml, resSignature)) {
        throw new Error("Response signature verification failed");
      }

      const status = this.getXmlElementValue(responseXml, "Status");
      const transactionId = this.getXmlElementValue(responseXml, "TransactionId");
      const duration = Date.now() - startTime;

      if (status === "SUCCESS") {
        log.info(
          maskPII({ duration, transactionId, status }),
          "Moov: Payout request successful",
        );
        return {
          success: true,
          data: { transactionId, status },
          providerResponseTimeMs: duration,
        };
      } else {
        const errorDetail = this.getXmlElementValue(responseXml, "ErrorDetail") || "Payout request failed";
        throw new Error(errorDetail);
      }
    } catch (error: any) {
      const duration = Date.now() - startTime;
      log.error(
        maskPII({ duration, error: error.message }),
        "Moov: Payout request failed",
      );
      return {
        success: false,
        error: error.message || error,
        providerResponseTimeMs: duration,
      };
    }
  }

  async getTransactionStatus(
    referenceId: string,
  ): Promise<{ status: ProviderTransactionStatus }> {
    const log = logger;
    log.info(maskPII({ referenceId }), "Moov: Querying transaction status");

    try {
      const bodyContent = `<GetTransactionStatus><ReferenceId>${referenceId}</ReferenceId></GetTransactionStatus>`;
      const signature = this.signPayload(bodyContent);
      const requestXml = this.buildSoapEnvelope("GetTransactionStatus", bodyContent, signature);

      const response = await axios.post(this.baseUrl, requestXml, {
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          "Accept": "text/xml",
          SOAPAction: "GetTransactionStatus",
        },
      });

      const responseXml = response.data;
      const signatureMatch = responseXml.match(/<Signature[^>]*>([^<]+)<\/Signature>/);
      if (!signatureMatch) {
        throw new Error("Response signature verification failed: SOAP response is missing Signature header");
      }
      const resSignature = signatureMatch[1].trim();
      const bodyXml = this.getSoapBodyContent(responseXml);

      if (!this.verifyResponse(bodyXml, resSignature)) {
        throw new Error("Response signature verification failed");
      }

      const status = this.getXmlElementValue(responseXml, "Status");
      if (status === "SUCCESS" || status === "COMPLETED") {
        return { status: "completed" };
      } else if (status === "FAILED") {
        return { status: "failed" };
      } else if (status === "PENDING") {
        return { status: "pending" };
      }
      return { status: "unknown" };
    } catch (error: any) {
      log.error({ referenceId, error: error.message }, "Moov: Status query failed");
      return { status: "unknown" };
    }
  }
}
