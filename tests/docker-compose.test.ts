/**
 * Structural checks for docker-compose.yml / docker-compose.dev.yml
 * (issue #1997: multi-component local development environment).
 *
 * These parse the compose files with js-yaml and assert on structure only;
 * they do not shell out to the Docker daemon, so they run in any CI
 * environment without Docker installed.
 */
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

interface ComposeService {
  image?: string;
  build?: unknown;
  healthcheck?: { test: unknown };
  depends_on?: Record<string, { condition?: string }> | string[];
  ports?: string[];
  environment?: Record<string, string> | string[];
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
}

function loadCompose(fileName: string): ComposeFile {
  const filePath = path.join(__dirname, "..", fileName);
  const raw = fs.readFileSync(filePath, "utf8");
  return yaml.load(raw) as ComposeFile;
}

describe("docker-compose.yml", () => {
  const compose = loadCompose("docker-compose.yml");

  it("defines the app, postgres, redis, provider-mock, and stellar services", () => {
    expect(Object.keys(compose.services)).toEqual(
      expect.arrayContaining([
        "app",
        "postgres",
        "redis",
        "provider-mock",
        "stellar",
      ]),
    );
  });

  it("gives every core service (app, postgres, redis, provider-mock, stellar) a healthcheck", () => {
    for (const name of [
      "app",
      "postgres",
      "redis",
      "provider-mock",
      "stellar",
    ]) {
      expect(compose.services[name].healthcheck).toBeDefined();
      expect(compose.services[name].healthcheck?.test).toBeDefined();
    }
  });

  it("makes the app wait for postgres, redis, provider-mock, and stellar to be healthy", () => {
    const dependsOn = compose.services.app.depends_on as Record<
      string,
      { condition?: string }
    >;
    expect(dependsOn.postgres.condition).toBe("service_healthy");
    expect(dependsOn.redis.condition).toBe("service_healthy");
    expect(dependsOn["provider-mock"].condition).toBe("service_healthy");
    expect(dependsOn.stellar.condition).toBe("service_healthy");
  });

  it("exposes the provider-mock server on its configured port", () => {
    expect(compose.services["provider-mock"].ports).toContain("4010:4010");
  });

  it("runs the mock provider server via the repo's existing tsx script", () => {
    const command = (compose.services["provider-mock"] as any).command as
      string[] | string;
    const commandStr = Array.isArray(command) ? command.join(" ") : command;
    expect(commandStr).toContain("scripts/provider-mock-server.ts");
  });

  it("declares a named volume for the provider-mock service's node_modules", () => {
    expect(compose.volumes).toHaveProperty("provider_mock_node_modules");
  });
});

describe("docker-compose.dev.yml", () => {
  const compose = loadCompose("docker-compose.dev.yml");

  it("defines app, db, redis, maildev, stellar, and provider-mock services", () => {
    expect(Object.keys(compose.services)).toEqual(
      expect.arrayContaining([
        "app",
        "db",
        "redis",
        "maildev",
        "stellar",
        "provider-mock",
      ]),
    );
  });

  it("waits for provider-mock to be healthy before starting the app", () => {
    const dependsOn = compose.services.app.depends_on as Record<
      string,
      { condition?: string }
    >;
    expect(dependsOn["provider-mock"].condition).toBe("service_healthy");
  });

  it("gives provider-mock a healthcheck", () => {
    expect(compose.services["provider-mock"].healthcheck).toBeDefined();
  });
});

describe(".env.docker", () => {
  it("exists and documents the variables the compose files reference", () => {
    const filePath = path.join(__dirname, "..", ".env.docker");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, "utf8");
    for (const key of [
      "STELLAR_HORIZON_URL",
      "PROVIDER_MOCK_PORT",
      "MTN_HEALTH_URL",
      "SENTRY_DSN",
    ]) {
      expect(content).toContain(key);
    }
  });
});
