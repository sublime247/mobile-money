import { Request, Response, NextFunction } from "express";
import { getUserById } from "../services/userService";

/**
 * Middleware to fetch user object once per request after authentication.
 * Attaches user object to res.locals.user for downstream use.
 */
export async function attachUserObject(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    // Prefer JWT userId, fallback to req.user?.id if present
    const userId = req.jwtUser?.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const user = await getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.locals.user = user;
    next();
  } catch (error) {
    next(error);
  }
}
