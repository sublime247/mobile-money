import { Request, Response, NextFunction } from "express";
import { createChildLogger } from "../config/logger";

const logger = createChildLogger("http");

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info(
      {
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        durationMs: duration,
      },
      "Request completed"
    );
  });

  next();
}
