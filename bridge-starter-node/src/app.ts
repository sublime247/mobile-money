import express, { Request, Response } from "express";
import webhookRoutes from "./routes/webhook";
import { config } from "./config/env";
import { createChildLogger } from "./config/logger";
import { requestLogger } from "./middleware/requestLogger";

const logger = createChildLogger("app");
const app = express();

app.use(express.json());
app.use(requestLogger);

app.get("/", (req: Request, res: Response) => {
  res.send("Bridge Starter API running 🚀");
});

app.use("/api", webhookRoutes);

app.listen(config.port, () => {
  logger.info({ port: config.port }, "Server started");
});
