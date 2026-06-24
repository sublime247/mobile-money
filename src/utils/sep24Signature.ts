import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import logger from './logger';

// Environment variables for configuration
const WEBVIEW_SIGNING_SECRET = process.env.WEBVIEW_SIGNING_SECRET;
const WEBVIEW_URL_EXPIRATION_SECONDS = parseInt(process.env.WEBVIEW_URL_EXPIRATION_SECONDS || '600', 10); // Default 10 minutes

// Ensure the secret is set in production
if (!WEBVIEW_SIGNING_SECRET && process.env.NODE_ENV === 'production') {
  logger.error('WEBVIEW_SIGNING_SECRET is not set. This is critical for SEP-24 webview security.');
  // In a real application, you might want to throw an error or exit here.
}

interface Sep24UrlParams {
  [key: string]: string | undefined;
  amount?: string;
  asset_code?: string;
  account?: string;
  memo?: string;
  callback?: string;
  // Add other SEP-24 specific parameters as needed
}

/**
 * Generates an HMAC-SHA256 signature for SEP-24 webview URL parameters.
 * The signature is based on a canonical string of sorted parameters and an expiration timestamp.
 * @param baseUrl The base URL to which parameters will be appended.
 * @param params The parameters to include in the URL.
 * @returns The signed URL with 'sig' and 'exp' query parameters.
 */
export function generateSignedSep24Url(baseUrl: string, params: Sep24UrlParams): string {
  if (!WEBVIEW_SIGNING_SECRET) {
    throw new Error('WEBVIEW_SIGNING_SECRET is not configured. Cannot sign SEP-24 URL.');
  }

  const now = Math.floor(Date.now() / 1000);
  const expiration = now + WEBVIEW_URL_EXPIRATION_SECONDS;

  const allParams: { [key: string]: string } = {
    ...params,
    exp: expiration.toString(),
  };

  // Sort parameters alphabetically by key for canonicalization
  const sortedKeys = Object.keys(allParams).sort();
  const canonicalString = sortedKeys
    .map(key => `${key}=${allParams[key]}`)
    .join('&');

  const hmac = crypto.createHmac('sha256', WEBVIEW_SIGNING_SECRET);
  hmac.update(canonicalString);
  const signature = hmac.digest('hex');

  const url = new URL(baseUrl);
  Object.entries(allParams).forEach(([key, value]) => {
    if (value !== undefined) {
      url.searchParams.append(key, value);
    }
  });
  url.searchParams.append('sig', signature);

  return url.toString();
}

/**
 * Express middleware to verify HMAC-SHA256 signature and expiration of SEP-24 webview URLs.
 */
export function verifySep24Signature(req: Request, res: Response, next: NextFunction) {
  if (!WEBVIEW_SIGNING_SECRET) {
    logger.error('WEBVIEW_SIGNING_SECRET is not configured. Cannot verify SEP-24 URL signature.');
    return res.status(500).json({ error: 'Server configuration error: Signing secret missing.' });
  }

  const { sig, exp, ...otherParams } = req.query;

  if (!sig || typeof sig !== 'string') {
    logger.warn({ url: req.originalUrl }, 'SEP-24 Webview: Missing or invalid signature parameter');
    return res.status(400).json({ error: 'Missing or invalid signature' });
  }

  if (!exp || typeof exp !== 'string') {
    logger.warn({ url: req.originalUrl }, 'SEP-24 Webview: Missing or invalid expiration timestamp');
    return res.status(400).json({ error: 'Missing or invalid expiration timestamp' });
  }

  const expirationTimestamp = parseInt(exp, 10);
  if (isNaN(expirationTimestamp) || expirationTimestamp <= 0) {
    logger.warn({ url: req.originalUrl, exp }, 'SEP-24 Webview: Invalid expiration timestamp format');
    return res.status(400).json({ error: 'Invalid expiration timestamp format' });
  }

  const now = Math.floor(Date.now() / 1000);
  if (now > expirationTimestamp) {
    logger.warn({ url: req.originalUrl, exp }, 'SEP-24 Webview: Expired URL access attempt');
    return res.status(401).json({ error: 'Expired URL' });
  }

  // Reconstruct the canonical string from all parameters *except* 'sig'
  const allParams: { [key: string]: string } = {};
  for (const key in req.query) {
    if (key !== 'sig' && typeof req.query[key] === 'string') {
      allParams[key] = req.query[key] as string;
    }
  }

  const sortedKeys = Object.keys(allParams).sort();
  const canonicalString = sortedKeys
    .map(key => `${key}=${allParams[key]}`)
    .join('&');

  const hmac = crypto.createHmac('sha256', WEBVIEW_SIGNING_SECRET);
  hmac.update(canonicalString);
  const expectedSignature = hmac.digest('hex');

  const expectedSigBuf = Buffer.from(expectedSignature, 'hex');
  const actualSigBuf = Buffer.from(sig, 'hex');

  const equal =
    expectedSigBuf.length === actualSigBuf.length &&
    crypto.timingSafeEqual(expectedSigBuf, actualSigBuf);

  if (!equal) {
    logger.warn({ 
      url: req.originalUrl, 
      providedSig: sig, 
      expectedSig: expectedSignature 
    }, 'SEP-24 Webview: Signature mismatch detected');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // If all checks pass, proceed to the next middleware/route handler
  next();
}