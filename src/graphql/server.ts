import type { Application, Request } from "express";
import { ApolloServer } from "apollo-server-express";
import {
  ApolloServerPluginLandingPageGraphQLPlayground,
  ApolloServerPluginLandingPageProductionDefault,
} from "apollo-server-core";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/dist/use/ws";
import { typeDefs } from "./schema";
import { resolvers, subscriptionResolvers } from "./resolvers";
import { buildGraphqlContext } from "./context";
import { Server } from "http";

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

  const server = new ApolloServer({
    schema,
    context: ({ req }: { req: Request }) => buildGraphqlContext(req),
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
        // Extract the request from the WebSocket context
        const req = ctx.extra.request as Request | undefined;
        return buildGraphqlContext(req as Request);
      },
      onConnect: (ctx: any) => {
        // Authentication can be performed here if needed
        // The connectionParams from the client are available in ctx.connectionParams
        console.log("WebSocket subscription connected");
        return true; // Allow connection
      },
      onDisconnect: (ctx: any) => {
        console.log("WebSocket subscription disconnected");
      },
      onError: (ctx: any, err: any) => {
        console.error("WebSocket subscription error:", err);
      },
    },
    wsServer,
  );
}
