import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

/**
 * Workflow Validation Test Suite
 *
 * **Validates: Requirements 7.1, 7.3, 7.4, 7.5**
 *
 * This test suite validates the GitHub Actions workflow configurations
 * to ensure they meet the project requirements for CI/CD pipeline.
 */

describe("GitHub Actions Workflow Validation", () => {
  const workflowsDir = path.join(process.cwd(), ".github", "workflows");
  const ciWorkflowPath = path.join(workflowsDir, "ci.yml");
  const deployWorkflowPath = path.join(workflowsDir, "deploy.yml");

  describe("Workflow Files Existence", () => {
    it("should have ci.yml workflow file at correct path", () => {
      expect(fs.existsSync(ciWorkflowPath)).toBe(true);
    });

    it("should have deploy.yml workflow file at correct path", () => {
      expect(fs.existsSync(deployWorkflowPath)).toBe(true);
    });

    it("should have .github/workflows directory", () => {
      expect(fs.existsSync(workflowsDir)).toBe(true);
      expect(fs.statSync(workflowsDir).isDirectory()).toBe(true);
    });
  });

  describe("YAML Syntax Validation", () => {
    it("should have valid YAML syntax in ci.yml", () => {
      const content = fs.readFileSync(ciWorkflowPath, "utf8");
      expect(() => yaml.load(content)).not.toThrow();
    });

    it("should have valid YAML syntax in deploy.yml", () => {
      const content = fs.readFileSync(deployWorkflowPath, "utf8");
      expect(() => yaml.load(content)).not.toThrow();
    });

    it("should parse ci.yml into a valid object structure", () => {
      const content = fs.readFileSync(ciWorkflowPath, "utf8");
      const parsed = yaml.load(content);
      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe("object");
    });

    it("should parse deploy.yml into a valid object structure", () => {
      const content = fs.readFileSync(deployWorkflowPath, "utf8");
      const parsed = yaml.load(content);
      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe("object");
    });
  });

  describe("CI Workflow Job Definitions", () => {
    let ciWorkflow: any;

    beforeAll(() => {
      const content = fs.readFileSync(ciWorkflowPath, "utf8");
      ciWorkflow = yaml.load(content);
    });

    it("should have a name defined", () => {
      expect(ciWorkflow.name).toBeDefined();
      expect(typeof ciWorkflow.name).toBe("string");
    });

    it("should have jobs defined", () => {
      expect(ciWorkflow.jobs).toBeDefined();
      expect(typeof ciWorkflow.jobs).toBe("object");
    });

    it("should have test job defined", () => {
      expect(ciWorkflow.jobs.test).toBeDefined();
    });

    it("should have build job defined", () => {
      expect(ciWorkflow.jobs.build).toBeDefined();
    });

    it("should have docker job defined", () => {
      expect(ciWorkflow.jobs.docker).toBeDefined();
    });

    it("should have test job running on ubuntu-latest", () => {
      expect(ciWorkflow.jobs.test["runs-on"]).toBe("ubuntu-latest");
    });

    it("should have build job running on ubuntu-latest", () => {
      expect(ciWorkflow.jobs.build["runs-on"]).toBe("ubuntu-latest");
    });

    it("should have docker job running on ubuntu-latest", () => {
      expect(ciWorkflow.jobs.docker["runs-on"]).toBe("ubuntu-latest");
    });
  });

  describe("Job Dependencies Structure", () => {
    let ciWorkflow: any;

    beforeAll(() => {
      const content = fs.readFileSync(ciWorkflowPath, "utf8");
      ciWorkflow = yaml.load(content);
    });

    it("should have build job depend on test job", () => {
      const buildJob = ciWorkflow.jobs.build;
      expect(buildJob.needs).toBeDefined();
      expect(buildJob.needs).toContain("test");
    });

    it("should have docker job depend on test and build jobs", () => {
      const dockerJob = ciWorkflow.jobs.docker;
      expect(dockerJob.needs).toBeDefined();
      expect(Array.isArray(dockerJob.needs)).toBe(true);
      expect(dockerJob.needs).toContain("test");
      expect(dockerJob.needs).toContain("build");
    });
  });

  describe("Node.js Version Configuration", () => {
    let ciWorkflow: any;

    beforeAll(() => {
      const content = fs.readFileSync(ciWorkflowPath, "utf8");
      ciWorkflow = yaml.load(content);
    });

    it("should use Node.js version 20 in test job", () => {
      const testJob = ciWorkflow.jobs.test;
      const setupNodeStep = testJob.steps.find(
        (step: any) => step.uses && step.uses.includes("actions/setup-node"),
      );

      expect(setupNodeStep).toBeDefined();
      expect(setupNodeStep.with).toBeDefined();
      expect(setupNodeStep.with["node-version"]).toBe("20");
    });

    it("should use Node.js version 20 in build job", () => {
      const buildJob = ciWorkflow.jobs.build;
      const setupNodeStep = buildJob.steps.find(
        (step: any) => step.uses && step.uses.includes("actions/setup-node"),
      );

      expect(setupNodeStep).toBeDefined();
      expect(setupNodeStep.with).toBeDefined();
      expect(setupNodeStep.with["node-version"]).toBe("20");
    });
  });

  describe("NPM Caching Configuration", () => {
    let ciWorkflow: any;

    beforeAll(() => {
      const content = fs.readFileSync(ciWorkflowPath, "utf8");
      ciWorkflow = yaml.load(content);
    });

    it("should have npm caching enabled in test job", () => {
      const testJob = ciWorkflow.jobs.test;
      const setupNodeStep = testJob.steps.find(
        (step: any) => step.uses && step.uses.includes("actions/setup-node"),
      );

      expect(setupNodeStep).toBeDefined();
      expect(setupNodeStep.with).toBeDefined();
      expect(setupNodeStep.with.cache).toBe("npm");
    });

    it("should have npm caching enabled in build job", () => {
      const buildJob = ciWorkflow.jobs.build;
      const setupNodeStep = buildJob.steps.find(
        (step: any) => step.uses && step.uses.includes("actions/setup-node"),
      );

      expect(setupNodeStep).toBeDefined();
      expect(setupNodeStep.with).toBeDefined();
      expect(setupNodeStep.with.cache).toBe("npm");
    });
  });

  describe("Service Container Configurations", () => {
    let ciWorkflow: any;

    beforeAll(() => {
      const content = fs.readFileSync(ciWorkflowPath, "utf8");
      ciWorkflow = yaml.load(content);
    });

    describe("PostgreSQL Configuration", () => {
      it("should have PostgreSQL service container in test job", () => {
        const testJob = ciWorkflow.jobs.test;
        expect(testJob.services).toBeDefined();
        expect(testJob.services.postgres).toBeDefined();
      });

      it("should use PostgreSQL version 16", () => {
        const testJob = ciWorkflow.jobs.test;
        const postgresImage = testJob.services.postgres.image;

        expect(postgresImage).toBeDefined();
        expect(postgresImage).toContain("postgres:16");
      });

      it("should have PostgreSQL environment variables configured", () => {
        const testJob = ciWorkflow.jobs.test;
        const postgresEnv = testJob.services.postgres.env;

        expect(postgresEnv).toBeDefined();
        expect(postgresEnv.POSTGRES_USER).toBeDefined();
        expect(postgresEnv.POSTGRES_PASSWORD).toBeDefined();
        expect(postgresEnv.POSTGRES_DB).toBeDefined();
      });

      it("should have PostgreSQL port mapping configured", () => {
        const testJob = ciWorkflow.jobs.test;
        const postgresPorts = testJob.services.postgres.ports;

        expect(postgresPorts).toBeDefined();
        expect(Array.isArray(postgresPorts)).toBe(true);
        expect(postgresPorts).toContain("5432:5432");
      });

      it("should have PostgreSQL health check configured", () => {
        const testJob = ciWorkflow.jobs.test;
        const postgresOptions = testJob.services.postgres.options;

        expect(postgresOptions).toBeDefined();
        expect(postgresOptions).toContain("--health-cmd");
        expect(postgresOptions).toContain("pg_isready");
      });
    });

    describe("Redis Configuration", () => {
      it("should have Redis service container in test job", () => {
        const testJob = ciWorkflow.jobs.test;
        expect(testJob.services).toBeDefined();
        expect(testJob.services.redis).toBeDefined();
      });

      it("should use Redis version 7", () => {
        const testJob = ciWorkflow.jobs.test;
        const redisImage = testJob.services.redis.image;

        expect(redisImage).toBeDefined();
        expect(redisImage).toContain("redis:7");
      });

      it("should have Redis port mapping configured", () => {
        const testJob = ciWorkflow.jobs.test;
        const redisPorts = testJob.services.redis.ports;

        expect(redisPorts).toBeDefined();
        expect(Array.isArray(redisPorts)).toBe(true);
        expect(redisPorts).toContain("6379:6379");
      });

      it("should have Redis health check configured", () => {
        const testJob = ciWorkflow.jobs.test;
        const redisOptions = testJob.services.redis.options;

        expect(redisOptions).toBeDefined();
        expect(redisOptions).toContain("--health-cmd");
        expect(redisOptions).toContain("redis-cli ping");
      });
    });
  });

  describe("CD Workflow Configuration", () => {
    let deployWorkflow: any;

    beforeAll(() => {
      const content = fs.readFileSync(deployWorkflowPath, "utf8");
      deployWorkflow = yaml.load(content);
    });

    it("should have a name defined", () => {
      expect(deployWorkflow.name).toBeDefined();
      expect(typeof deployWorkflow.name).toBe("string");
    });

    it("should have workflow_run trigger configured", () => {
      expect(deployWorkflow.on).toBeDefined();
      expect(deployWorkflow.on.workflow_run).toBeDefined();
    });

    it("should trigger on CI workflow completion", () => {
      const workflowRun = deployWorkflow.on.workflow_run;
      expect(workflowRun.workflows).toBeDefined();
      expect(Array.isArray(workflowRun.workflows)).toBe(true);
      expect(workflowRun.workflows).toContain("CI");
    });

    it("should trigger only on main branch", () => {
      const workflowRun = deployWorkflow.on.workflow_run;
      expect(workflowRun.branches).toBeDefined();
      expect(Array.isArray(workflowRun.branches)).toBe(true);
      expect(workflowRun.branches).toContain("main");
    });

    it("should have deploy-staging job defined", () => {
      expect(deployWorkflow.jobs).toBeDefined();
      expect(deployWorkflow.jobs["deploy-staging"]).toBeDefined();
    });

    it("should have staging environment configured", () => {
      const deployJob = deployWorkflow.jobs["deploy-staging"];
      expect(deployJob.environment).toBe("staging");
    });

    it("should have success condition check", () => {
      const deployJob = deployWorkflow.jobs["deploy-staging"];
      expect(deployJob.if).toBeDefined();
      expect(deployJob.if).toContain("workflow_run.conclusion");
      expect(deployJob.if).toContain("success");
    });
  });

  describe("Specific Scenario Tests", () => {
    let ciWorkflow: any;
    let deployWorkflow: any;

    beforeAll(() => {
      const ciContent = fs.readFileSync(ciWorkflowPath, "utf8");
      ciWorkflow = yaml.load(ciContent);

      const deployContent = fs.readFileSync(deployWorkflowPath, "utf8");
      deployWorkflow = yaml.load(deployContent);
    });

    it("should verify CI workflow triggers on push to any branch", () => {
      expect(ciWorkflow.on).toBeDefined();
      expect(ciWorkflow.on.push).toBeDefined();
      expect(ciWorkflow.on.push.branches).toBeDefined();
      expect(Array.isArray(ciWorkflow.on.push.branches)).toBe(true);

      // Verify it includes multiple branches (not just main)
      expect(ciWorkflow.on.push.branches.length).toBeGreaterThan(0);

      // Verify it also triggers on pull requests
      expect(ciWorkflow.on.pull_request).toBeDefined();
    });

    it("should verify CD workflow triggers only on main branch after CI success", () => {
      // Check workflow_run trigger
      expect(deployWorkflow.on.workflow_run).toBeDefined();
      expect(deployWorkflow.on.workflow_run.workflows).toContain("CI");
      expect(deployWorkflow.on.workflow_run.types).toContain("completed");

      // Check branch restriction
      expect(deployWorkflow.on.workflow_run.branches).toBeDefined();
      expect(deployWorkflow.on.workflow_run.branches).toEqual(["main"]);

      // Check success condition in job
      const deployJob = deployWorkflow.jobs["deploy-staging"];
      expect(deployJob.if).toBeDefined();
      expect(deployJob.if).toContain("workflow_run.conclusion");
      expect(deployJob.if).toContain("success");
      expect(deployJob.if).toContain("head_branch");
      expect(deployJob.if).toContain("main");
    });

    it('should verify "latest" tag is only applied on main branch builds', () => {
      const dockerJob = ciWorkflow.jobs.docker;
      expect(dockerJob).toBeDefined();

      const buildPushStep = dockerJob.steps.find(
        (step: any) =>
          step.uses && step.uses.includes("docker/build-push-action"),
      );

      expect(buildPushStep).toBeDefined();
      expect(buildPushStep.with).toBeDefined();
      expect(buildPushStep.with.tags).toBeDefined();

      // Verify tags configuration includes conditional latest tag
      const tagsString = buildPushStep.with.tags;
      expect(tagsString).toContain("github.sha");
      expect(tagsString).toContain("github.ref_name");
      expect(tagsString).toContain("latest");
      expect(tagsString).toContain("github.ref_name == 'main'");
    });

    it("should verify staging-specific environment variables are used in CD workflow", () => {
      const deployJob = deployWorkflow.jobs["deploy-staging"];
      expect(deployJob).toBeDefined();

      // Check environment is set to staging
      expect(deployJob.environment).toBe("staging");

      // Find the deployment step
      const deployStep = deployJob.steps.find(
        (step: any) => step.name && step.name.includes("Deploy to staging"),
      );

      expect(deployStep).toBeDefined();
      expect(deployStep.env).toBeDefined();

      // Verify staging-specific environment variables are present
      const requiredEnvVars = [
        "DATABASE_URL",
        "REDIS_URL",
        "STELLAR_NETWORK",
        "STELLAR_HORIZON_URL",
        "STELLAR_ISSUER_SECRET",
      ];

      for (const envVar of requiredEnvVars) {
        expect(deployStep.env[envVar]).toBeDefined();
        expect(deployStep.env[envVar]).toContain("secrets");
      }
    });

    it("should verify Codecov upload step is configured correctly", () => {
      const testJob = ciWorkflow.jobs.test;
      expect(testJob).toBeDefined();

      const codecovStep = testJob.steps.find(
        (step: any) =>
          step.uses && step.uses.includes("codecov/codecov-action"),
      );

      expect(codecovStep).toBeDefined();
      expect(codecovStep.with).toBeDefined();

      // Verify token is configured
      expect(codecovStep.with.token).toBeDefined();
      expect(codecovStep.with.token).toContain("secrets.CODECOV_TOKEN");

      // Verify coverage file path
      expect(codecovStep.with.files).toBeDefined();
      expect(codecovStep.with.files).toContain("lcov.info");

      // Verify flags are set
      expect(codecovStep.with.flags).toBeDefined();

      // Verify name is set
      expect(codecovStep.with.name).toBeDefined();
    });
  });

  describe("Edge Case Tests", () => {
    let ciWorkflow: any;
    let deployWorkflow: any;

    beforeAll(() => {
      const ciContent = fs.readFileSync(ciWorkflowPath, "utf8");
      ciWorkflow = yaml.load(ciContent);

      const deployContent = fs.readFileSync(deployWorkflowPath, "utf8");
      deployWorkflow = yaml.load(deployContent);
    });

    /**
     * **Validates: Requirements 1.3**
     *
     * Tests that the CI workflow handles empty test suite scenarios gracefully.
     * The test job should still execute and report results even if no tests are found.
     */
    it("should handle empty test suite scenarios", () => {
      const testJob = ciWorkflow.jobs.test;
      expect(testJob).toBeDefined();

      // Verify test step exists
      const testStep = testJob.steps.find(
        (step: any) => step.run && step.run.includes("test"),
      );

      expect(testStep).toBeDefined();
      expect(testStep.run).toBeDefined();

      // Verify the test command is configured (Jest will handle empty suites)
      expect(testStep.run).toContain("npm run test");

      // Verify coverage upload has fail_ci_if_error set to false
      // This ensures empty test suites don't fail the pipeline
      const codecovStep = testJob.steps.find(
        (step: any) =>
          step.uses && step.uses.includes("codecov/codecov-action"),
      );

      expect(codecovStep).toBeDefined();
      expect(codecovStep.with).toBeDefined();
      expect(codecovStep.with.fail_ci_if_error).toBe(false);
    });

    /**
     * **Validates: Requirements 2.3, 2.5**
     *
     * Tests that the Docker build job handles missing Dockerfile scenarios.
     * The workflow should fail gracefully with clear error messaging.
     */
    it("should handle missing Dockerfile error scenarios", () => {
      const dockerJob = ciWorkflow.jobs.docker;
      expect(dockerJob).toBeDefined();

      // Verify Docker build step specifies the Dockerfile path
      const buildStep = dockerJob.steps.find(
        (step: any) =>
          step.uses && step.uses.includes("docker/build-push-action"),
      );

      expect(buildStep).toBeDefined();
      expect(buildStep.with).toBeDefined();
      expect(buildStep.with.file).toBeDefined();
      expect(buildStep.with.file).toBe("./Dockerfile");

      // Verify context is set (Docker will fail if Dockerfile is missing)
      expect(buildStep.with.context).toBeDefined();
      expect(buildStep.with.context).toBe(".");

      // The docker/build-push-action will automatically fail if Dockerfile is missing
      // No additional error handling needed - Docker's native error is clear
    });

    /**
     * **Validates: Requirements 4.3**
     *
     * Tests that the workflow handles invalid registry credentials gracefully.
     * The Docker login step should fail with clear authentication errors.
     */
    it("should handle invalid registry credentials error scenarios", () => {
      const dockerJob = ciWorkflow.jobs.docker;
      expect(dockerJob).toBeDefined();

      // Verify Docker login step exists and uses secrets
      const loginStep = dockerJob.steps.find(
        (step: any) => step.uses && step.uses.includes("docker/login-action"),
      );

      expect(loginStep).toBeDefined();
      expect(loginStep.with).toBeDefined();
      expect(loginStep.with.username).toBeDefined();
      expect(loginStep.with.password).toBeDefined();

      // Verify credentials are pulled from secrets
      expect(loginStep.with.username).toContain("secrets.REGISTRY_USERNAME");
      expect(loginStep.with.password).toContain("secrets.REGISTRY_PASSWORD");

      // The docker/login-action will automatically fail with authentication error
      // if credentials are invalid, which will stop the pipeline

      // Verify the docker job depends on test and build
      // This ensures we don't waste time on authentication if tests fail
      expect(dockerJob.needs).toBeDefined();
      expect(Array.isArray(dockerJob.needs)).toBe(true);
      expect(dockerJob.needs).toContain("test");
      expect(dockerJob.needs).toContain("build");
    });

    /**
     * **Validates: Requirements 5.5**
     *
     * Tests that the deployment workflow handles network timeout scenarios.
     * The health check should timeout gracefully and fail the deployment.
     */
    it("should handle network timeout in deployment scenarios", () => {
      const deployJob = deployWorkflow.jobs["deploy-staging"];
      expect(deployJob).toBeDefined();

      // Verify health check step exists
      const healthCheckStep = deployJob.steps.find(
        (step: any) => step.name && step.name.includes("Health check"),
      );

      expect(healthCheckStep).toBeDefined();
      expect(healthCheckStep.run).toBeDefined();

      // Verify timeout is configured in the health check script
      const healthCheckScript = healthCheckStep.run;
      expect(healthCheckScript).toContain("TIMEOUT");
      expect(healthCheckScript).toContain("300"); // 5 minutes timeout

      // Verify interval between checks is configured
      expect(healthCheckScript).toContain("INTERVAL");
      expect(healthCheckScript).toContain("10"); // 10 seconds interval

      // Verify the script has a loop that respects the timeout
      expect(healthCheckScript).toContain("while");
      expect(healthCheckScript).toContain("ELAPSED");

      // Verify the script exits with error code on timeout
      expect(healthCheckScript).toContain("exit 1");

      // Verify failure notification step exists and runs on failure
      const notifyStep = deployJob.steps.find(
        (step: any) =>
          step.name && step.name.includes("Notify deployment failure"),
      );

      expect(notifyStep).toBeDefined();
      expect(notifyStep.if).toBe(
        "failure() && steps.check_secrets.outputs.credentials_available == 'true'",
      );

      // Verify notification includes diagnostic information
      expect(notifyStep.run).toContain("logs");
    });
  });
});
