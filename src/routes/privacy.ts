import { Router } from "express";
import privacyController from "../controllers/privacyController";
import { authenticateToken } from "../middleware/auth";

export const privacyRoutes = Router();

privacyRoutes.get(
  "/export",
  authenticateToken,
  privacyController.exportDataEndpoint,
);

privacyRoutes.get(
  "/right-to-be-forgotten",
  authenticateToken,
  privacyController.rightToBeForgettenEndpoint,
);

// New DELETE endpoint for GDPR data purge
privacyRoutes.delete(
  "/delete",
  authenticateToken,
  privacyController.rightToBeForgettenEndpoint,
);
