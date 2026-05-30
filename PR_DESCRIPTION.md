# Pull Request Description

**Title:** `feat: serve Swagger UI assets via CDN`

### 📖 Summary
Implemented serving of Swagger UI assets from a public CDN (jsDelivr) instead of local static files. This reduces bundle size, speeds up documentation load times, and simplifies deployment by removing the need to serve Swagger UI static assets.

### 🛠️ Changes
| File | Modification |
|------|--------------|
| `src/routes/docs.ts` | - Removed `swaggerUi.serve` middleware.
| | - Added `customCssUrl` and `customJs` options pointing to CDN URLs.
| | - Updated comments to reflect CDN usage.

### ✅ Verification
- **Local Development:** Run the server in development mode and navigate to `/docs`. Swagger UI loads correctly with assets fetched from CDN.
- **Production Build:** Build the application (`npm run build`) and start the server in production mode. The `/docs` endpoint still returns a 404 as expected, preserving the dev-only guard.
- **Network Inspection:** Confirm that CSS and JS are loaded from `https://cdn.jsdelivr.net/npm/swagger-ui-dist/...`.

### 📈 Impact
- **Performance:** Faster initial load of API documentation due to CDN caching and reduced server payload.
- **Maintenance:** No need to manage local Swagger UI static files; updates to the UI are automatically obtained via CDN.
- **Security:** Using a reputable CDN (jsDelivr) ensures integrity via subresource integrity (SRI) checks can be added in the future.

### 📦 Release Notes
- Swagger UI now served via CDN in development environments.
- No functional changes to the OpenAPI spec generation.

---

**How to Merge**
1. Review the changes.
2. Ensure CI passes (`npm test`).
3. Merge into `main`.
