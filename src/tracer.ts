import tracer from "dd-trace";

tracer.init({
  logInjection: true,
  env: process.env.NODE_ENV || "development",
  service: "mobile-money",
});

tracer.use("graphql", {
  // -1 = instrument all resolvers (no depth limit) — required for nested
  // query bottleneck analysis. Set to 0 to disable resolver spans.
  depth: -1,

  // Derive the resource name from the operation signature (e.g.
  // "query transaction($id: String!)") so it's human-readable in the UI.
  signature: true,

  // Do NOT capture the raw query text — it may contain PII.
  source: false,

  // Truncate variables that contain PII (phone numbers, addresses, etc.)
  // so they never appear as span tags.
  variables: (vars) => {
    if (!vars) return vars;
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(vars)) {
      if (/phone|address|token|secret|password|key/i.test(key)) {
        sanitized[key] = "***";
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  },

  hooks: {
    execute: (span, args) => {
      if (!span || !args) return;
      // Extract operation type and name from the parsed document
      const opDef = args.document?.definitions?.find(
        (d: any) => d.kind === "OperationDefinition",
      );
      if (opDef) {
        span.setTag("graphql.operation.type", opDef.operation);
        if (opDef.name?.value) {
          span.setTag("graphql.operation.name", opDef.name.value);
        }
      }
    },
  },
});

export default tracer;
