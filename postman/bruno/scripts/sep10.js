/**
 * Shared SEP-10 helpers for the Bruno collection.
 *
 * Used from `script:pre-request` / `script:post-response` blocks via:
 *
 *   const sep10 = require("./scripts/sep10");
 *
 * Requires a `package.json` at the collection root (this directory) declaring
 * `@stellar/stellar-sdk`, and Developer Mode enabled when running locally:
 *
 *   bru run postman/bruno --env Local --sandbox=developer
 *
 * All functions throw descriptive errors — Bruno surfaces them and marks the
 * request as failed, which is exactly what we want in CI / smoke runs.
 */
"use strict";

const { Keypair, TransactionBuilder } = require("@stellar/stellar-sdk");

/**
 * Reads a response object produced by `bru.sendRequest(...)` or `res`.
 * Prefers the typed `getBody()` helper and falls back to raw fields.
 *
 * @param {any} response
 * @returns {any}
 */
function parseBody(response) {
  if (!response) return null;

  if (typeof response.getBody === "function") {
    const body = response.getBody();
    if (typeof body === "string") {
      try {
        return JSON.parse(body);
      } catch (_err) {
        return body;
      }
    }
    return body;
  }

  const raw = response.body !== undefined ? response.body : response.data;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (_err) {
      return raw;
    }
  }
  return raw !== undefined ? raw : null;
}

/**
 * GET {{base_url}}/sep10?account=<publicKey>&home_domain=<homeDomain>
 *
 * Uses `bru.sendRequest` so a single click can fetch + sign + verify the
 * challenge (single-round-trip auto-signing). If the Bruno sandbox does not
 * expose `sendRequest`, callers fall back to the two-step flow
 * ("SEP-10 Get Challenge" → "SEP-10 Sign Challenge & Get Token").
 *
 * @param {{bru: any, baseUrl: string, publicKey: string, homeDomain: string}} args
 * @returns {Promise<{transaction: string, network_passphrase: string}>}
 */
async function fetchChallenge({ bru, baseUrl, publicKey, homeDomain }) {
  if (typeof bru.sendRequest !== "function") {
    throw new Error(
      "bru.sendRequest is unavailable in this Bruno sandbox — run 'SEP-10 Get Challenge' first.",
    );
  }
  if (!publicKey) {
    throw new Error("stellar_public_key is not set in the environment.");
  }

  const url =
    baseUrl +
    "/sep10?account=" +
    encodeURIComponent(publicKey) +
    "&home_domain=" +
    encodeURIComponent(homeDomain || "localhost:3000");

  const response = await bru.sendRequest({
    method: "GET",
    url,
    headers: { Accept: "application/json" },
  });

  const status =
    typeof response.getStatus === "function" ? response.getStatus() : null;
  const body = parseBody(response);

  if (status !== null && status !== 200) {
    throw new Error(
      "SEP-10 challenge request failed (HTTP " +
        status +
        "): " +
        JSON.stringify(body),
    );
  }
  if (!body || !body.transaction) {
    throw new Error(
      "SEP-10 challenge response did not include a transaction XDR: " +
        JSON.stringify(body),
    );
  }
  if (!body.network_passphrase) {
    throw new Error("SEP-10 challenge response is missing network_passphrase.");
  }
  return body;
}

/**
 * Signs a SEP-10 challenge transaction with `stellar_secret_key`.
 *
 * Mirrors what a production client does: `TransactionBuilder.fromXDR` (the
 * server builds and signs the challenge), then `tx.sign(keypair)` adds the
 * client signature over the challenge nonce.
 *
 * @param {{transaction: string, network_passphrase: string}} challenge
 * @param {string} secretKey Stellar secret seed (S...)
 * @returns {string} signed challenge XDR
 */
function signChallenge(challenge, secretKey) {
  if (!challenge || !challenge.transaction) {
    throw new Error(
      "No SEP-10 challenge to sign — run 'SEP-10 Get Challenge' first.",
    );
  }
  if (!secretKey) {
    throw new Error(
      "stellar_secret_key is empty — set it in the environment before signing.",
    );
  }

  let keypair;
  try {
    keypair = Keypair.fromSecret(secretKey);
  } catch (err) {
    throw new Error(
      "stellar_secret_key is not a valid Stellar secret seed: " + err.message,
    );
  }

  const passphrase = challenge.network_passphrase;
  if (!passphrase) {
    throw new Error("Challenge is missing network_passphrase.");
  }

  let tx;
  try {
    tx = TransactionBuilder.fromXDR(challenge.transaction, passphrase);
  } catch (err) {
    throw new Error("Failed to parse the challenge XDR: " + err.message);
  }

  tx.sign(keypair);
  return tx.toXDR();
}

/**
 * Decodes the payload of a compact JWT without verifying it — used only to
 * assert that the token subject matches the Stellar public key we control.
 *
 * @param {string} token
 * @returns {any} decoded claims, or null when the token cannot be decoded
 */
function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch (_err) {
    return null;
  }
}

module.exports = {
  fetchChallenge,
  signChallenge,
  decodeJwtPayload,
  parseBody,
};
