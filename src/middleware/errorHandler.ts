import { Request, Response, NextFunction } from "express";
import { ErrorResponse } from "../types/api";

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  console.error(err.stack);

  const body: ErrorResponse = {
    error: "Internal server error",
    message: process.env.NODE_ENV === "development" ? err.message : undefined,
  };
  res.status(500).json(body);
};
