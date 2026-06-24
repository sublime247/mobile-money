import { Router, Request, Response } from "express";
import { Pool } from "pg";
import { z } from "zod";
import crypto from "crypto";
import { getNetworkPassphrase } from "../config/stellar";

// ── Validation Schema ────────────────────────────────────────────────────────

const federationQuerySchema = z.object({
  q: z.string().min(1, "q is required"),
  type: z.enum(["name", "id", "txid", "forward"], {
    message: "type must be one of: name, id, txid, forward",
  }),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value.toLowerCase().trim()).digest("hex");
}

function parseFederationAddress(address: string): { localPart: string; domain: string } | null {
  if (!address || typeof address !== "string") return null;
  const parts = address.split("*");
  if (parts.length !== 2) return null;
  return { localPart: parts[0], domain: parts[1] };
}

// ── FederationService ────────────────────────────────────────────────────────

export class FederationService {
  constructor(private db: Pool) {}

  async lookupByName(address: string): Promise<{ stellar_address: string; account_id: string; memo_type?: string; memo?: string } | null> {
    const parsed = parseFederationAddress(address);
    if (!parsed) return null;

    const domain = (process.env.STELLAR_FEDERATION_DOMAIN || "mobilemoney.com").toLowerCase().trim();
    if (parsed.domain.toLowerCase().trim() !== domain) {
      return null;
    }

    const { localPart } = parsed;

    // 1. Username lookup
    try {
      const usernameRes = await this.db.query(
        "SELECT id, stellar_address, username, phone_hash, email_hash FROM users WHERE LOWER(username) = $1",
        [localPart.toLowerCase().trim()]
      );
      if (usernameRes.rows.length > 0) {
        const row = usernameRes.rows[0];
        return {
          stellar_address: `${row.username || localPart}*${domain}`,
          account_id: row.stellar_address,
        };
      }
    } catch (err) {
      console.error("Federation username lookup error:", err);
    }

    // 2. Phone hash lookup
    const hashed = sha256(localPart);
    try {
      const phoneRes = await this.db.query(
        "SELECT id, stellar_address, username, phone_hash, email_hash FROM users WHERE phone_hash = $1",
        [hashed]
      );
      if (phoneRes.rows.length > 0) {
        const row = phoneRes.rows[0];
        return {
          stellar_address: `${row.username || localPart}*${domain}`,
          account_id: row.stellar_address,
        };
      }
    } catch (err) {
      console.error("Federation phone hash lookup error:", err);
    }

    // 3. Email hash lookup
    try {
      const emailRes = await this.db.query(
        "SELECT id, stellar_address, username, phone_hash, email_hash FROM users WHERE email_hash = $1",
        [hashed]
      );
      if (emailRes.rows.length > 0) {
        const row = emailRes.rows[0];
        return {
          stellar_address: `${row.username || localPart}*${domain}`,
          account_id: row.stellar_address,
        };
      }
    } catch (err) {
      console.error("Federation email hash lookup error:", err);
    }

    return null;
  }

  async lookupById(accountId: string): Promise<{ stellar_address: string; account_id: string; memo_type?: string; memo?: string } | null> {
    const domain = (process.env.STELLAR_FEDERATION_DOMAIN || "mobilemoney.com").toLowerCase().trim();
    try {
      const res = await this.db.query(
        "SELECT id, stellar_address, username, phone_hash, email_hash FROM users WHERE stellar_address = $1",
        [accountId]
      );
      if (res.rows.length > 0) {
        const row = res.rows[0];
        const localPart = row.username || row.stellar_address;
        return {
          stellar_address: `${localPart}*${domain}`,
          account_id: row.stellar_address,
        };
      }
    } catch (err) {
      console.error("Federation lookupById error:", err);
    }
    return null;
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

export function createFederationRouter(db: Pool): Router {
  const router = Router();
  const service = new FederationService(db);

  router.get("/", async (req: Request, res: Response) => {
    const parsed = federationQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ detail: parsed.error.issues[0].message });
    }

    const { q, type } = parsed.data;

    if (type === "txid" || type === "forward") {
      return res.status(501).json({ detail: `Lookup type '${type}' not implemented` });
    }

    if (type === "name") {
      const result = await service.lookupByName(q);
      if (!result) {
        return res.status(404).json({ detail: "Federation address not found" });
      }
      return res.status(200).json(result);
    }

    if (type === "id") {
      const result = await service.lookupById(q);
      if (!result) {
        return res.status(404).json({ detail: "Stellar address not found" });
      }
      return res.status(200).json(result);
    }

    return res.status(400).json({ detail: "Invalid lookup type" });
  });

  return router;
}

// ── TOML Helper ──────────────────────────────────────────────────────────────

export function buildStellarToml(): string {
  const passphrase = getNetworkPassphrase();
  const domain = process.env.STELLAR_FEDERATION_DOMAIN || "mobilemoney.com";

  return [
    `FEDERATION_SERVER="https://${domain}/federation"`,
    `NETWORK_PASSPHRASE="${passphrase}"`
  ].join("\n");
}