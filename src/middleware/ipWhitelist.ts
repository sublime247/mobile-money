import { NextFunction, Request, Response } from "express";
import ipaddr from "ipaddr.js";

const ALLOWED_PROVIDER_CIDRS = [
  "41.134.0.0/16", // MTN example block
  "196.216.0.0/16", // Airtel example block
];

const allowedNetworks = ALLOWED_PROVIDER_CIDRS.map((cidr) =>
  ipaddr.parseCIDR(cidr),
);

const resolveClientIp = (req: Request): string | null => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }

  return req.ip || null;
};

const isIpAllowed = (rawIp: string): boolean => {
  try {
    const parsed = ipaddr.process(rawIp);

    return allowedNetworks.some(([network, prefix]) =>
      parsed.match(network, prefix),
    );
  } catch {
    return false;
  }
};

export const ipWhitelist = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const clientIp = resolveClientIp(req);

  if (!clientIp || !isIpAllowed(clientIp)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  next();
};
