/**
 * Central OpenAPI registry.
 *
 * This file MUST be imported before any Zod schema is used so that
 * extendZodWithOpenApi() runs first and the .openapi() method is available
 * on every Zod type.
 *
 * Import order in src/index.ts:
 *   import './openapi/registry';   ← first
 *   import { z } from 'zod';       ← after
 */

import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// Extend Zod once, globally.
extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();
