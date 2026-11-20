# Regulator audit export

`GET /api/v1/compliance/audit/export?start=2026-01-01T00:00:00Z&end=2026-02-01T00:00:00Z`

Authentication and the
`audit_export:read` Casbin permission are required. The bundled policy permits
admins, super-admins, compliance officers, and auditors.

Configure `ANCHOR_COMPLIANCE_MASTER_PRIVATE_KEY` with the anchor's compliance
master RSA private key in PEM format (literal `\n` escapes are supported).
Provision it through the deployment's secret manager. No fallback or generated
signing key is used. Auditors must obtain the corresponding public key through
a trusted channel.

The range uses UTC ISO timestamps and includes the start but excludes the end.
The archive contains:

- `ledger.csv`: transactions created in the interval, including all statuses.
- `documents/`: original S3 document bytes, named by document ID.
- `documents.csv`: attachment paths, user IDs, document types, and MIME types.
- `range.json`: interval and signature algorithm.
- `manifest.sha256`: SHA-256 sums of every payload file above.
- `manifest.sig`: detached base64 RSA-SHA256 signature over the exact manifest bytes.

KYC evidence includes documents created before the end of the interval for users
with transactions in the interval, even when uploaded before the start. Database
queries share a repeatable-read snapshot. Missing or unreadable documents fail
the entire export. Spreadsheet formula prefixes in CSV values are neutralized.
Responses are marked `Cache-Control: no-store`.

The manifest and detached signature do not hash themselves. To verify after
extracting the ZIP into an empty directory, decode `manifest.sig` from base64,
then run:

```sh
openssl base64 -d -in manifest.sig -out manifest.sig.bin
openssl dgst -sha256 -verify compliance-public.pem -signature manifest.sig.bin manifest.sha256
sha256sum -c manifest.sha256
```

Reject unexpected payload files not listed in the signed manifest. The archive
is assembled in memory; operators should request appropriately sized intervals.
