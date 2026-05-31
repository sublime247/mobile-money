import express, { Request, Response } from "express";
import webhookRoutes from "./routes/webhook";
import { config } from "./config/env";

const app = express();

app.use(express.json());

app.get("/", (req: Request, res: Response) => {
  res.send("Bridge Starter API running 🚀");
});

app.use("/api", webhookRoutes);

app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
});
