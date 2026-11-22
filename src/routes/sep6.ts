import { Router } from "express";
import { Pool } from "pg";
import { pool } from "../config/database";
import {
  createSep6Router,
  getSep6Config,
  buildSep6InfoPayload,
  validateSep6CorridorConfig,
} from "../stellar/sep6";
import { sep6InfoResponseSchema } from "../schemas/sep6";

export {
  createSep6Router,
  getSep6Config,
  buildSep6InfoPayload,
  validateSep6CorridorConfig,
  sep6InfoResponseSchema,
};

export const sep6Router: Router = createSep6Router(pool);

export default sep6Router;
