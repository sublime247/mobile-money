import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRUNO_DIR = path.resolve(__dirname, "../bruno");

function listRequestFiles(dir = BRUNO_DIR) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "environments" ||
      entry.name === "scripts"
    )
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRequestFiles(full));
    else if (entry.name.endsWith(".bru")) out.push(full);
  }
  return out;
}

function read(file) {
  return fs.readFileSync(path.join(BRUNO_DIR, file), "utf-8");
}

test("Bruno collection manifest exists and is valid", () => {
  const raw = read("bruno.json");
  const manifest = JSON.parse(raw);

  assert.strictEqual(manifest.name, "Mobile Money Bridge API");
  assert.strictEqual(manifest.type, "collection");
  assert.ok(Array.isArray(manifest.ignore));
  assert.ok(manifest.ignore.includes("node_modules"));
  assert.strictEqual(
    manifest.scripts?.moduleSystem,
    "commonjs",
    "scripts must use CommonJS so require() works",
  );
});

test("collection package.json declares @stellar/stellar-sdk", () => {
  const pkg = JSON.parse(read("package.json"));
  const version = pkg.dependencies["@stellar/stellar-sdk"];
  assert.ok(version, "stellar-sdk is required by scripts/sep10.js");

  // Bruno's developer sandbox evaluates npm packages as CommonJS; stellar-sdk 16+
  // pulls in the ESM-only `uint8array-extras` and fails with
  // "SyntaxError: Unexpected token 'export'". Keep the pin below 16 until Bruno
  // can load ESM modules.
  const major = Number.parseInt(String(version).replace(/^[\^~]/, ""), 10);
  assert.ok(
    major >= 13 && major < 16,
    `Bruno-compatible stellar-sdk pin required (found ${version})`,
  );
});

test("Local environment declares every variable the collection uses", () => {
  const env = read("environments/Local.bru");
  const declared = new Set(
    [...env.matchAll(/^\s{2}([a-z_]+):/gim)].map((m) => m[1]),
  );

  for (const required of [
    "base_url",
    "home_domain",
    "stellar_public_key",
    "stellar_secret_key",
    "login_phone",
    "jwt_token",
    "signed_challenge_xdr",
    "transaction_id",
    "quote_id",
  ]) {
    assert.ok(declared.has(required), `environment must declare ${required}`);
  }

  const used = new Set();
  for (const file of listRequestFiles()) {
    const text = fs.readFileSync(file, "utf-8");
    for (const m of text.matchAll(/\{\{([a-z_]+)\}\}/gi)) used.add(m[1]);
    for (const m of text.matchAll(/bru\.(?:get|set)EnvVar\("([a-z_]+)"/gi))
      used.add(m[1]);
  }

  for (const name of used) {
    assert.ok(
      declared.has(name),
      `{{${name}}} is used but never declared in Local.bru`,
    );
  }
});

test("Local environment ships a matching, valid Stellar keypair", () => {
  const env = read("environments/Local.bru");
  const publicKey = env.match(/stellar_public_key:\s*(\S+)/)?.[1];
  const secretKey = env.match(/stellar_secret_key:\s*(\S+)/)?.[1];

  assert.ok(
    publicKey && StrKey.isValidEd25519PublicKey(publicKey),
    "public key must be a valid G… address",
  );
  assert.ok(
    secretKey && StrKey.isValidEd25519SecretSeed(secretKey),
    "secret key must be a valid S… seed",
  );
  assert.strictEqual(
    Keypair.fromSecret(secretKey).publicKey(),
    publicKey,
    "stellar_secret_key must correspond to stellar_public_key",
  );
  // `vars:secret` entries are names only (the value must come from an external
  // secrets file), so the committed dev keypair has to live in `vars`.
  const varsBlock = env.match(/vars \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(
    /stellar_secret_key:\s*\S/.test(varsBlock),
    "stellar_secret_key must carry its value in the vars block",
  );
});

test("collection contains all required request folders", () => {
  const folders = fs
    .readdirSync(BRUNO_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^[0-9]{2}-/.test(e.name))
    .map((e) => e.name);

  for (const required of [
    "00-health",
    "01-auth",
    "02-kyc",
    "03-quotes",
    "04-deposits",
    "05-withdrawals",
  ]) {
    assert.ok(folders.includes(required), `folder ${required} must exist`);
  }
  assert.ok(
    folders.length >= 6,
    `expected at least 6 folders, found ${folders.length}`,
  );
});

test("shared SEP-10 script exposes fetch + sign + JWT decode", () => {
  const src = read("scripts/sep10.js");

  for (const exportName of [
    "fetchChallenge",
    "signChallenge",
    "decodeJwtPayload",
  ]) {
    assert.ok(
      src.includes(exportName),
      `scripts/sep10.js must export ${exportName}`,
    );
  }
  assert.ok(
    src.includes("Keypair.fromSecret"),
    "must sign with Keypair.fromSecret",
  );
  assert.ok(
    src.includes("TransactionBuilder.fromXDR"),
    "must parse the challenge with TransactionBuilder.fromXDR",
  );
  assert.ok(src.includes("toXDR()"), "must return the signed XDR");
  assert.ok(
    !src.includes("secretKey) =>"),
    "must not leak the secret via logging",
  );
});

test("auto-signing request fetches, signs and submits the challenge", () => {
  const file = listRequestFiles().find((f) =>
    f.endsWith("sign-challenge-get-token.bru"),
  );
  assert.ok(file, "sign-challenge-get-token.bru must exist");

  const text = fs.readFileSync(file, "utf-8");
  assert.ok(
    text.includes("script:pre-request"),
    "must sign inside a pre-request script",
  );
  assert.ok(
    text.includes('require("./scripts/sep10")'),
    "must use the shared sep10 helper",
  );
  assert.ok(text.includes("fetchChallenge"), "must fetch a fresh challenge");
  assert.ok(text.includes("signChallenge"), "must sign the challenge locally");
  assert.ok(
    text.includes("signed_challenge_xdr"),
    "must manage the signed XDR variable",
  );
  assert.ok(
    text.includes("req.setBody"),
    "must inject the signed XDR into the request body",
  );
  assert.ok(text.includes("jwt_token"), "must store the exchanged token");
  assert.ok(text.includes("decodeJwtPayload"), "must assert the token subject");
  assert.ok(text.includes("tests {"), "must include test assertions");

  const env = read("environments/Local.bru");
  assert.ok(
    !text.includes("sep10/auth"),
    "must use the real SEP-10 route (GET/POST /sep10), not /sep10/auth",
  );
  assert.ok(env, "environment must exist");
});

test("every request declares metadata and test assertions", () => {
  const files = listRequestFiles();
  assert.ok(
    files.length >= 20,
    `expected at least 20 requests, found ${files.length}`,
  );

  const seqByFolder = new Map();

  for (const file of files) {
    const rel = path.relative(BRUNO_DIR, file);
    const text = fs.readFileSync(file, "utf-8");

    assert.ok(text.startsWith("meta {"), `${rel} must start with a meta block`);
    assert.ok(/type: http/.test(text), `${rel} must declare type: http`);
    assert.match(text, /name: ".+"/, `${rel} must declare a name`);
    assert.match(
      text,
      /(get|post|put|delete) \{/,
      `${rel} must declare an HTTP method block`,
    );
    assert.ok(text.includes("tests {"), `${rel} must include test assertions`);
    assert.ok(text.includes("{{base_url}}"), `${rel} must target {{base_url}}`);

    const folder = path.dirname(rel);
    const seq = Number(text.match(/seq: (\d+)/)?.[1]);
    assert.ok(
      Number.isInteger(seq) && seq > 0,
      `${rel} must declare a positive seq`,
    );
    if (!seqByFolder.has(folder)) seqByFolder.set(folder, new Set());
    const seen = seqByFolder.get(folder);
    assert.ok(!seen.has(seq), `${rel} duplicates seq ${seq} in ${folder}`);
    seen.add(seq);
  }

  for (const [folder, seqs] of seqByFolder) {
    assert.ok(seqs.size > 0, `${folder} must contain sequenced requests`);
  }
});

test("authenticated requests guard against a missing token", () => {
  const authorized = listRequestFiles().filter((file) => {
    const text = fs.readFileSync(file, "utf-8");
    return text.includes("Authorization: Bearer {{jwt_token}}");
  });

  assert.ok(
    authorized.length >= 5,
    `expected several authenticated requests, found ${authorized.length}`,
  );
  for (const file of authorized) {
    const rel = path.relative(BRUNO_DIR, file);
    const text = fs.readFileSync(file, "utf-8");
    assert.ok(
      text.includes("script:pre-request") || text.includes("get-challenge"),
      `${rel} sends a bearer token but has no pre-request guard`,
    );
  }
});
