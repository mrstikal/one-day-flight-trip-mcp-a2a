import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Aggregate development stack (ODTF_PLAN.md Phase 11 section 5.3).
 *
 * Starts the package watcher, web app, MCP host, the three primary A2A agents
 * and the coordinator worker. Each agent receives its own restricted-role
 * database URL; the worker receives the trusted agent registry. Nothing here
 * starts a LangGraph graph or a checkpointer.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function loadEnv(): void {
  for (const candidate of [".env.local", ".env"]) {
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        // Config validation below reports actionable problems.
      }
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required; see README "Protocol services"`);
  }
  return value;
}

function roleDatabaseUrl(role: string, passwordEnv: string): string {
  const base = new URL(requireEnv("DATABASE_URL"));
  const password = requireEnv(passwordEnv);
  const url = new URL(base.toString());
  url.username = role;
  url.password = password;
  return url.toString();
}

interface ChildSpec {
  readonly name: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

function buildChildren(): ChildSpec[] {
  const baseEnv = process.env;
  const agentRegistry = requireEnv("ODFT_AGENT_REGISTRY_PATH");
  const mcpHostRegistry =
    process.env.ODFT_MCP_AGENT_REGISTRY_PATH ??
    (existsSync("tests/fixtures/protocols/mcp-host-registry.json")
      ? "tests/fixtures/protocols/mcp-host-registry.json"
      : undefined);
  if (!mcpHostRegistry) {
    throw new Error("ODFT_MCP_AGENT_REGISTRY_PATH is required for the MCP host");
  }

  const mcpRegistry = requireEnv("ODFT_MCP_REGISTRY_PATH");
  const mcpReadonlyDatabaseUrl = roleDatabaseUrl("odft_mcp_readonly", "ODFT_MCP_READONLY_PASSWORD");
  const flightDatabaseUrl = roleDatabaseUrl("odft_flight_agent", "ODFT_FLIGHT_AGENT_PASSWORD");
  const accommodationDatabaseUrl = roleDatabaseUrl(
    "odft_accommodation_agent",
    "ODFT_ACCOMMODATION_AGENT_PASSWORD",
  );
  const cityGuideDatabaseUrl = roleDatabaseUrl(
    "odft_city_guide_agent",
    "ODFT_CITY_GUIDE_AGENT_PASSWORD",
  );

  return [
    {
      name: "packages",
      args: ["run", "dev:packages"],
      env: baseEnv,
    },
    {
      name: "web",
      args: ["run", "dev:web"],
      env: baseEnv,
    },
    {
      name: "mcp",
      args: ["run", "dev:mcp"],
      env: {
        ...baseEnv,
        DATABASE_URL: mcpReadonlyDatabaseUrl,
        ODFT_MCP_READONLY_DATABASE_URL: mcpReadonlyDatabaseUrl,
        ODFT_MCP_AGENT_REGISTRY_PATH: mcpHostRegistry,
      },
    },
    {
      name: "flight",
      args: ["run", "dev:flight-agent"],
      env: {
        ...baseEnv,
        DATABASE_URL: flightDatabaseUrl,
        ODFT_FLIGHT_AGENT_REGISTRY_PATH: agentRegistry,
        ODFT_MCP_REGISTRY_PATH: mcpRegistry,
      },
    },
    {
      name: "accommodation",
      args: ["run", "dev:accommodation-agent"],
      env: {
        ...baseEnv,
        DATABASE_URL: accommodationDatabaseUrl,
        ODFT_ACCOMMODATION_AGENT_REGISTRY_PATH: agentRegistry,
        ODFT_ACCOMMODATION_AGENT_MCP_REGISTRY_PATH: mcpRegistry,
      },
    },
    {
      name: "city-guide",
      args: ["run", "dev:city-guide-agent"],
      env: {
        ...baseEnv,
        DATABASE_URL: cityGuideDatabaseUrl,
        ODFT_CITY_GUIDE_AGENT_REGISTRY_PATH: agentRegistry,
        ODFT_CITY_GUIDE_AGENT_MCP_REGISTRY_PATH: mcpRegistry,
      },
    },
    {
      name: "worker",
      args: ["run", "dev:worker"],
      env: {
        ...baseEnv,
        ODFT_AGENT_REGISTRY_PATH: agentRegistry,
      },
    },
  ];
}

const children: Array<{ name: string; child: ChildProcess }> = [];
let stopping = false;

function stopAll(signal: NodeJS.Signals = "SIGTERM"): void {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  }
}

function main(): void {
  loadEnv();

  let specs: ChildSpec[];
  try {
    specs = buildChildren();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n` +
        "Run `npm run setup:env`, `npm run protocol:roles` and set the role/token values first.\n",
    );
    process.exitCode = 1;
    return;
  }

  process.on("SIGINT", () => stopAll("SIGINT"));
  process.on("SIGTERM", () => stopAll("SIGTERM"));

  for (const spec of specs) {
    const child = spawn("npm", spec.args, {
      cwd: REPO_ROOT,
      env: spec.env,
      stdio: "inherit",
    });
    child.on("exit", (code, signal) => {
      if (!stopping) {
        process.stderr.write(
          `[dev] ${spec.name} exited (${code ?? signal ?? "unknown"}); stopping the stack\n`,
        );
        stopAll();
        process.exitCode = code ?? 1;
      }
    });
    children.push({ name: spec.name, child });
  }
}

main();
