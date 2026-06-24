/**
 * Apollo Client with Automatic Persisted Queries (APQ)
 *
 * On first request the client sends only the SHA-256 hash of the query.
 * If the server returns PersistedQueryNotFound, the client automatically
 * retries with the full query string + hash. Subsequent requests for the
 * same query send the hash only, dramatically reducing payload size.
 *
 * Usage (browser / React Native):
 *   import { apolloClient } from "./apolloClient";
 *
 * Usage (Node.js / SSR):
 *   import { createApolloClient } from "./apolloClient";
 *   const client = createApolloClient({ uri: "http://localhost:3000/graphql" });
 */

import {
  ApolloClient,
  InMemoryCache,
  HttpLink,
  ApolloLink,
  from,
} from "@apollo/client";
import { createPersistedQueryLink } from "@apollo/client/link/persisted-queries";
import crypto from "crypto";

const sha256 = async (query: string): Promise<string> => {
  return crypto.createHash("sha256").update(query).digest("hex");
};

export interface ApolloClientOptions {
  /** GraphQL endpoint URL */
  uri?: string;
  /** Additional headers to include on every request */
  headers?: Record<string, string>;
}

/**
 * Creates an Apollo Client instance with APQ enabled.
 *
 * Link chain:
 *   persistedQueryLink → authLink → httpLink
 *
 * The persistedQueryLink intercepts every operation:
 *  1. Sends hash-only request first
 *  2. On PersistedQueryNotFound, retries with full query + hash
 *  3. Caches the hash locally so subsequent requests skip step 2
 */
export function createApolloClient(options: ApolloClientOptions = {}) {
  const uri = options.uri || process.env.GRAPHQL_URI || "http://localhost:3000/graphql";

  // APQ link — handles the hash-first / fallback-to-full-query protocol
  const persistedQueryLink = createPersistedQueryLink({
    sha256,
    useGETForHashedQueries: false, // POST for all requests (avoids CORS preflight issues)
  });

  // Auth link — attaches the API key header when available
  const authLink = new ApolloLink((operation, forward) => {
    const apiKey = typeof process !== "undefined"
      ? process.env.GRAPHQL_API_KEY
      : undefined;

    if (apiKey) {
      operation.setContext(({ headers = {} }) => ({
        headers: {
          ...headers,
          "x-api-key": apiKey,
          ...options.headers,
        },
      }));
    } else if (options.headers) {
      operation.setContext(({ headers = {} }) => ({
        headers: { ...headers, ...options.headers },
      }));
    }

    return forward(operation);
  });

  const httpLink = new HttpLink({ uri });

  return new ApolloClient({
    link: from([persistedQueryLink, authLink, httpLink]),
    cache: new InMemoryCache(),
    defaultOptions: {
      watchQuery: { fetchPolicy: "cache-and-network" },
      query: { fetchPolicy: "network-only" },
    },
  });
}

// Default singleton client (suitable for browser / React Native apps)
export const apolloClient = createApolloClient();
