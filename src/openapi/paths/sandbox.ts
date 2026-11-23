import { z } from "zod";
import { registry } from "../registry";

registry.registerPath({
  method: "post",
  path: "/api/v1/sandbox/webhooks/simulate",
  tags: ["Sandbox"],
  summary: "Simulate a payment webhook in the sandbox",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            provider: z.string(),
            status: z.string(),
            targetUrl: z.string().url(),
            amount: z.string().optional(),
            currency: z.string().optional(),
            transactionType: z.string().optional(),
            secret: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Webhook simulation result" },
    400: { description: "Invalid request or failed simulation" },
  },
});
