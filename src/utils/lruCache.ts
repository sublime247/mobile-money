import { LRUCache } from "lru-cache";

export const metadataCache = new LRUCache<string, any>({
  max: 500,
  ttl: 1000 * 60 * 60, // 1 hour TTL
});
