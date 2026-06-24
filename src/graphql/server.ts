import type { Application, Request } from "express";
import { ApolloServer } from "apollo-server-express";
import {
  ApolloServerPluginLandingPageGraphQLPlayground,
  ApolloServerPluginLandingPageProductionDefault,
} from "apollo-server-core";
// @ts-expect-error ESM module
import { makeExecutableSchema } from "@graphql-tools/schema";
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/use/ws";
import { typeDefs } from "./schema";
import { resolvers, subscriptionResolvers } from "./resolvers";
import { buildGraphqlContext } from "./context";
import { Server } from "http";
import depthLimit from "graphql-depth-limit";
import {
  createComplexityRule,
  simpleEstimator,
  fieldExtensionsEstimator,
} from "graphql-query-complexity";
import { createAPQCache } from "./apqCache";
import { verifyToken } from "../auth/jwt";

// Merge resolvers with subscription resolvers
const mergedResolvers = {
  ...resolvers,
  ...subscriptionResolvers,
};

export async function startApolloServer(
  app: Application,
  httpServer: Server,
): Promise<void> {
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers: mergedResolvers,
  });

  // APQ cache — Redis-backed, degrades gracefully on Redis downtime
  const apqCache = createAPQCache();

  const server = new ApolloServer({
    schema,
    context: ({ req }: { req: Request }) => buildGraphqlContext(req),

    // ---------------------------------------------------------------------------
    // Automatic Persisted Queries (APQ)
    // Clients send a SHA-256 hash of the query instead of the full string.
    // On cache miss Apollo returns PersistedQueryNotFound; the client retries
    // with the full query + hash, which is then stored in Redis for future hits.
    // ---------------------------------------------------------------------------
    persistedQueries: {
      cache: apqCache,
      // ttl is managed by the cache adapter itself (APQ_TTL_SECONDS env var)
    },

    validationRules: [
      depthLimit(5),
        // Enforce strict query complexity limit of 500 points per request
      createComplexityRule({
        maximumComplexity: 500,
        estimators: [
          fieldExtensionsEstimator(),
          simpleEstimator({ defaultComplexity: 1 }),
        ],
      }),
    ],
    plugins: [
      process.env.NODE_ENV === "production"
        ? ApolloServerPluginLandingPageProductionDefault({ footer: false })
        : ApolloServerPluginLandingPageGraphQLPlayground(),
      // Plugin for proper shutdown of WebSocket server
      {
        async serverWillStart() {
          return {
            async drainServer() {
              await serverCleanup.dispose();
            },
          };
        },
      },
    ],
  });

  await server.start();
  // apollo-server-express bundles its own @types/express; cast avoids duplicate-type errors.
  server.applyMiddleware({ app: app as never, path: "/graphql", cors: false });

  // Create the WebSocket server for subscriptions
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: "/graphql",
  });

  // Set up the graphql-ws server
  const serverCleanup = useServer(
    {
      schema,
      context: (ctx: any) => {
        const req = ctx.extra.request as Request | undefined;
        const jwtClaims = ctx.extra.jwtClaims;
        // Build base context from HTTP request, then overlay WS auth
        const base = buildGraphqlContext(req as Request);
        if (jwtClaims) {
          base.auth = { authenticated: true, subject: jwtClaims.userId };
        }
        return base;
      },
      onConnect: (ctx: any) => {
        // ── JWT authentication on WS handshake ──────────────────────────
        // Clients must pass: connectionParams: { authToken: "<jwt>" }
        const token =
          ctx.connectionParams?.authToken ||
          ctx.connectionParams?.Authorization?.replace(/^Bearer\s+/i, "");

        // Allow unauthenticated in dev when no GRAPHQL_API_KEY is set
        const apiKeyRequired = !!process.env.GRAPHQL_API_KEY;

        if (apiKeyRequired) {
          if (!token) {
            console.warn("[WS] Rejected unauthenticated connection — no authToken");
            return false; // graphql-ws closes the connection
          }
          try {
            const claims = verifyToken(String(token));
            // Attach claims to context so subscription resolvers can access them
            ctx.extra.jwtClaims = claims;
            console.log(`[WS] Authenticated connection for user ${claims.userId}`);
          } catch (err) {
            console.warn("[WS] Rejected connection — invalid token:", (err as Error).message);
            return false;
          }
        }

        return true;
      },
      onDisconnect: (_ctx: any) => {
        console.log("WebSocket subscription disconnected");
      },
      onError: (_ctx: any, err: any) => {
        console.error("WebSocket subscription error:", err);
      },
    },
    wsServer,
  );
}
