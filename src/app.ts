/**
 * Express Application with Swagger UI Documentation Middleware
 */

import app from "./index";
import { docsRouter } from "./routes/docs";

// Ensure Swagger UI is mounted at /api/docs
app.use("/api/docs", docsRouter);

export { app };
export default app;
