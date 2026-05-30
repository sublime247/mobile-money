/**
 * /docs routes — development only.
 *
 * GET /docs/openapi.json  → raw OpenAPI 3.0 spec (generated fresh from Zod schemas)
 * GET /docs               → Swagger UI
 *
 * Both routes are guarded: they return 404 when NODE_ENV !== 'development'.
 * Mount this router BEFORE the error handler in src/index.ts.
 */

import { Router, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { generateOpenAPIDocument } from '../openapi/generator';

export const docsRouter = Router();

const isDev = process.env.NODE_ENV === 'development';

// ─── Guard middleware ─────────────────────────────────────────────────────────

function devOnly(_req: Request, res: Response, next: () => void): void {
  if (!isDev) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
}

// ─── /docs/openapi.json ───────────────────────────────────────────────────────

docsRouter.get('/openapi.json', devOnly, (_req: Request, res: Response) => {
  const spec = generateOpenAPIDocument();
  res.setHeader('Content-Type', 'application/json');
  res.json(spec);
});

// ─── /docs (Swagger UI) ───────────────────────────────────────────────────────

// swagger-ui-express needs the spec at setup time, but we want it generated
// fresh on each server start. We generate it once when the module loads
// (which happens at server start) and pass it to the UI middleware.
//
// If you restart the server the module is re-evaluated and a new spec is
// generated — satisfying the "auto-update on server restart" requirement.

if (isDev) {
  const spec = generateOpenAPIDocument();

  docsRouter.use(
    '/',
    devOnly,
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'Mobile Money Bridge — API Docs',
      // Use CDN for Swagger UI assets to improve load performance
      customCssUrl: 'https://cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui.css',
      customJs: 'https://cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui-bundle.js',
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        filter: true,
        tryItOutEnabled: true,
      },
    })
  );
} else {
  // In non-dev environments the route still exists but devOnly will 404 it.
  docsRouter.use('/', devOnly, (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });
}
