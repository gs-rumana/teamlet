import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config } from "./config.ts";
import type { Orchestrator } from "./orchestrator.ts";

const MAX_WORKERS_PER_CALL = 12;

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (error: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
});

/** Delegation tools, scoped to the lead agent that owns the URL token. */
function buildServer(orchestrator: Orchestrator, leadId: string): McpServer {
  const server = new McpServer({ name: "teamlet", version: config.version });

  server.registerTool(
    "list_providers",
    {
      title: "List worker providers",
      description:
        "List the AI providers (signed in with the user's subscriptions) and the models each one offers. Use a model's id as spawn_workers' model; omit model to use the provider's default. Pick models by task: faster/cheaper ones for simple or reading-heavy work, the most capable ones for hard reasoning.",
      annotations: { readOnlyHint: true },
    },
    async () =>
      json(
        orchestrator.workerProviders(leadId).map((p) => ({
          provider: p.id,
          name: p.name,
          plan: p.plan,
          models: p.models
            .filter((m) => m.id)
            .map((m) => ({ id: m.id, name: m.label, ...(m.description ? { description: m.description } : {}) })),
        })),
      ),
  );

  server.registerTool(
    "spawn_workers",
    {
      title: "Spawn parallel workers",
      description:
        "Start one or more worker agents. All workers in one call run in parallel. Returns immediately with worker ids; use wait_for_workers to collect results. Each prompt must be self-contained because workers cannot see your conversation. Omit provider/model to use your own; call list_providers to see which models exist.",
      inputSchema: {
        tasks: z
          .array(
            z.object({
              title: z.string().describe("Short label shown in the UI, e.g. 'Write API tests'"),
              prompt: z.string().describe("Complete, self-contained instructions for the worker"),
              provider: z.enum(["claude", "codex"]).optional(),
              model: z.string().optional(),
            }),
          )
          .min(1)
          .max(MAX_WORKERS_PER_CALL),
      },
    },
    async ({ tasks }) => {
      try {
        const workers = orchestrator.spawnWorkers(leadId, tasks);
        return json({
          started: workers.map((w) => ({ workerId: w.id, title: w.title, provider: w.provider, model: w.model ?? "default" })),
          next: "Call wait_for_workers to collect results.",
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "wait_for_workers",
    {
      title: "Wait for workers",
      description:
        "Wait until the given workers (default: all of your workers) finish, or until the timeout. Returns each worker's status and, for finished workers, its final report. If allDone is false, call again.",
      inputSchema: {
        workerIds: z.array(z.string()).optional(),
        timeoutSeconds: z.number().int().min(1).max(600).optional().describe("Default 300"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workerIds, timeoutSeconds }, extra) => {
      try {
        return json(await orchestrator.waitForWorkers(leadId, workerIds, (timeoutSeconds ?? 300) * 1000, extra.signal));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_worker",
    {
      title: "Get worker",
      description: "Get one worker's status and full final report.",
      inputSchema: { workerId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ workerId }) => {
      try {
        return json(orchestrator.describeWorker(orchestrator.workerOf(leadId, workerId), true));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "message_worker",
    {
      title: "Message worker",
      description: "Send a follow-up instruction to a finished worker. It keeps its previous context. Use wait_for_workers afterwards.",
      inputSchema: { workerId: z.string(), prompt: z.string() },
    },
    async ({ workerId, prompt }) => {
      try {
        orchestrator.workerOf(leadId, workerId);
        orchestrator.sendMessage(workerId, prompt);
        return json({ ok: true, workerId });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "stop_worker",
    {
      title: "Stop worker",
      description: "Stop a running or queued worker.",
      inputSchema: { workerId: z.string() },
    },
    async ({ workerId }) => {
      try {
        orchestrator.workerOf(leadId, workerId);
        orchestrator.stopAgent(workerId);
        return json({ ok: true, workerId });
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

/** Stateless Streamable HTTP endpoint at /mcp/<token>. */
export async function handleMcpRequest(orchestrator: Orchestrator, token: string, req: IncomingMessage, res: ServerResponse) {
  const lead = orchestrator.leadForToken(token);
  if (!lead) {
    res.writeHead(404).end("Unknown MCP token");
    return;
  }
  const server = buildServer(orchestrator, lead.id);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
