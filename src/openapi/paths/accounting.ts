import { registry } from "../registry";

registry.registerPath({
  method: "get",
  path: "/api/v1/accounting/float-forecast",
  tags: ["Accounting"],
  summary: "Get provider float and depletion forecasts",
  description: "Returns a 48-hour forecast based on the trailing seven days of withdrawal volume. Requires finance access.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "Provider float forecasts and depletion alerts" },
    401: { description: "Authentication required" },
    403: { description: "Finance access required" },
  },
});
