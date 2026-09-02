import { existsSync } from "node:fs";
import { dirname, basename, resolve, join } from "node:path";
import { homedir } from "node:os";
import { openDb, findDbPath, type DbInstance } from "./db";
import { clearServerState } from "./server-state";
import {
  listTasks,
  getTask,
  addTask,
  takeTask,
  doneTask,
  failTask,
  blockTask,
  releaseTask,
  reopenTask,
  type Task,
} from "./tasks";
import {
  listSpecs,
  getSpec,
  addSpec,
  startSpec,
  doneSpec,
  archiveSpec,
  unarchiveSpec,
  deleteSpec,
  setSpecContent,
  addPlan,
  getLatestPlan,
  listPlans,
  type Spec,
} from "./specs";
import { dashboardHtml } from "./dashboard";
import { inspectWorktree } from "./worktree-status";
import { listAgentProcesses } from "./agents-status";

interface Stats {
  pending: number;
  in_progress: number;
  completed: number;
  failed: number;
  specs: number;
  plans: number;
}

interface SpecWithExtras extends Spec {
  task_count: number;
  task_summary: { pending: number; in_progress: number; completed: number };
  latest_plan_version: number | null;
}

interface EventRow {
  id: number;
  entity_type: string;
  entity_id: string;
  event_type: string;
  actor: string | null;
  payload: string | null;
  created_at: string;
}

function getStats(db: DbInstance): Stats {
  const taskCounts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END)     AS pending,
         SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) AS in_progress,
         SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END)   AS completed,
         SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END)      AS failed
       FROM tasks`,
    )
    .get() as Record<string, number | null>;
  const specs = (db.prepare(`SELECT COUNT(*) AS n FROM specs`).get() as { n: number }).n;
  const plans = (db.prepare(`SELECT COUNT(*) AS n FROM plans`).get() as { n: number }).n;
  return {
    pending: taskCounts.pending ?? 0,
    in_progress: taskCounts.in_progress ?? 0,
    completed: taskCounts.completed ?? 0,
    failed: taskCounts.failed ?? 0,
    specs,
    plans,
  };
}

function listSpecsWithExtras(db: DbInstance): SpecWithExtras[] {
  const specs = listSpecs(db);
  return specs.map((spec) => {
    const taskCounts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END)     AS pending,
           SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) AS in_progress,
           SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END)   AS completed,
           COUNT(*) AS total
         FROM tasks WHERE spec_id = ?`,
      )
      .get(spec.id) as {
        pending: number | null;
        in_progress: number | null;
        completed: number | null;
        total: number;
      };
    const planRow = db
      .prepare(`SELECT MAX(version) AS v FROM plans WHERE spec_id = ?`)
      .get(spec.id) as { v: number | null };
    return {
      ...spec,
      task_count: taskCounts.total ?? 0,
      task_summary: {
        pending: taskCounts.pending ?? 0,
        in_progress: taskCounts.in_progress ?? 0,
        completed: taskCounts.completed ?? 0,
      },
      latest_plan_version: planRow.v ?? null,
    };
  });
}

function listEvents(db: DbInstance, limit: number = 50, sinceId: number = 0): EventRow[] {
  return db
    .prepare(
      `SELECT id, entity_type, entity_id, event_type, actor, payload, created_at
       FROM events
       WHERE id > ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(sinceId, limit) as EventRow[];
}

function getMaxEventId(db: DbInstance): number {
  const row = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM events`).get() as { id: number };
  return row.id;
}

interface SearchHit {
  type: "spec" | "task";
  id: string;
  title: string;
  status: string;
  match_field: string;
}

// In-memory request log (non-persistent, session-only)
interface RequestLogEntry {
  id: number;
  method: string;
  path: string;
  actor: string;
  source: string;
  timestamp: string;
}

const requestLog: RequestLogEntry[] = [];
let nextRequestLogId = 1;
const MAX_REQUEST_LOG = 100;

function deriveSource(actor: string): "Dashboard" | "API" | "Terminal" {
  if (actor === "dashboard") return "Dashboard";
  if (actor.startsWith("api:")) return "API";
  return "Terminal";
}

function logRequest(method: string, path: string, actor: string): void {
  if (path === "/" || path === "/api/events/stream") return;

  // Suppress dashboard's own reads (list views, detail views, worktree-status
  // polling). The exact-match list missed per-id paths like /api/tasks/:id and
  // /api/tasks/:id/worktree-status — those got logged, which fed the SSE
  // "refresh" broadcast, which made every open dashboard re-render and re-fetch,
  // logging a new request that fed the next refresh: a self-sustaining loop that
  // caused the whole page to flicker every ~1.5s while a task/spec detail page
  // was open. Dashboard mutations (POST/PATCH/DELETE) are never GET, so they
  // still get logged and still drive refresh for everyone else.
  if (actor === "dashboard" && method === "GET") return;

  const source = deriveSource(actor);
  requestLog.push({
    id: nextRequestLogId++,
    method,
    path,
    actor,
    source,
    timestamp: new Date().toISOString(),
  });
  if (requestLog.length > MAX_REQUEST_LOG) {
    requestLog.splice(0, requestLog.length - MAX_REQUEST_LOG);
  }
}

function search(db: DbInstance, query: string, limit: number = 20): SearchHit[] {
  const pattern = `%${query.toLowerCase()}%`;
  const specs = db
    .prepare(
      `SELECT id, title, status,
         CASE
           WHEN lower(title) LIKE ? THEN 'title'
           WHEN lower(content) LIKE ? THEN 'content'
         END AS match_field
       FROM specs
       WHERE lower(title) LIKE ? OR lower(content) LIKE ?
       LIMIT ?`,
    )
    .all(pattern, pattern, pattern, pattern, limit) as Array<{
      id: string;
      title: string;
      status: string;
      match_field: string;
    }>;

  const tasks = db
    .prepare(
      `SELECT id, subject AS title, status,
         CASE
           WHEN lower(subject) LIKE ? THEN 'subject'
           WHEN lower(description) LIKE ? THEN 'description'
         END AS match_field
       FROM tasks
       WHERE lower(subject) LIKE ? OR lower(description) LIKE ?
       LIMIT ?`,
    )
    .all(pattern, pattern, pattern, pattern, limit) as Array<{
      id: string;
      title: string;
      status: string;
      match_field: string;
    }>;

  return [
    ...specs.map((s) => ({ type: "spec" as const, ...s })),
    ...tasks.map((t) => ({ type: "task" as const, ...t })),
  ];
}

function json(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function notFound(msg: string = "Not found"): Response {
  return json({ error: msg }, 404);
}

function badRequest(msg: string): Response {
  return json({ error: msg }, 400);
}

function serverError(err: unknown): Response {
  const msg = err instanceof Error ? err.message : String(err);
  return json({ error: msg }, 500);
}

/**
 * Determine actor for an inbound HTTP mutation. Priority:
 *   1. X-Feinai-Actor header (explicit)
 *   2. derived from request: "dashboard:<host>" or "api:<user-agent>"
 */
function actorFromRequest(req: Request): string {
  // Bun's headers.get may not be case-insensitive for custom headers;
  // iterate manually to be safe.
  let explicit: string | undefined;
  for (const [k, v] of req.headers.entries()) {
    if (k.toLowerCase() === "x-feinai-actor") {
      explicit = v;
      break;
    }
  }
  if (explicit) return explicit;

  const ua = req.headers.get("user-agent") ?? "";
  if (ua.includes("Mozilla")) return "dashboard";
  return `api:${ua.split(/\s+/)[0] || "unknown"}`;
}

async function readJsonBody<T = unknown>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function findRepoRoot(startDir: string = process.cwd()): string | null {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

let cachedDashboardVersion = "";
async function resolveDashboardVersion(): Promise<string> {
  if (cachedDashboardVersion) return cachedDashboardVersion;
  const root = findRepoRoot();
  if (!root) return "";
  try {
    const countResult = await Bun.$`git log --oneline -- src/dashboard.html | wc -l`.cwd(root).text();
    const count = parseInt(countResult.trim(), 10);
    const hashResult = await Bun.$`git log -1 --format=%h -- src/dashboard.html`.cwd(root).text();
    const hash = hashResult.trim();
    cachedDashboardVersion = `dashboard-v${count} (${hash})`;
  } catch {
    cachedDashboardVersion = "";
  }
  return cachedDashboardVersion;
}

export interface ServerOptions {
  port: number;
  host?: string;
}

export function startServer(opts: ServerOptions): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host ?? "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // CORS preflight
      if (method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, PATCH, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Feinai-Actor",
          },
        });
      }

      // Static dashboard — inject cached version string
      if (path === "/" || path === "/index.html") {
        const version = await resolveDashboardVersion();
        const html = version
          ? (dashboardHtml as unknown as string).replace('<span id="dash-version">v—</span>', `<span id="dash-version">${version}</span>`)
          : (dashboardHtml as unknown as string);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // SSE stream — special-cased: keeps connection open, polls events table.
      if (path === "/api/events/stream" && method === "GET") {
        return handleSseStream(req);
      }

      // Determine actor and log the request (session-only, non-persistent)
      const actor = actorFromRequest(req);
      logRequest(method, path, actor);

      // All other API routes open db lazily
      let db: DbInstance;
      try {
        db = openDb();
      } catch (err) {
        return serverError(err);
      }

      try {
        // ===== READ ENDPOINTS =====

        if (path === "/api/status" && method === "GET") {
          return json(getStats(db));
        }

        if (path === "/api/specs" && method === "GET") {
          return json(listSpecsWithExtras(db));
        }

        const specMatch = path.match(/^\/api\/specs\/([^/]+)$/);
        if (specMatch && method === "GET") {
          const id = decodeURIComponent(specMatch[1]!);
          const spec = getSpec(db, id);
          if (!spec) return notFound(`Spec ${id} not found`);
          const tasks = listTasks(db, { spec_id: id });
          const plans = listPlans(db, id);
          const latestPlan = getLatestPlan(db, id);
          return json({ spec, tasks, plans, latest_plan: latestPlan });
        }

        const specContentMatch = path.match(/^\/api\/specs\/([^/]+)\/content$/);
        if (specContentMatch && method === "GET") {
          const id = decodeURIComponent(specContentMatch[1]!);
          const spec = getSpec(db, id);
          if (!spec) return notFound(`Spec ${id} not found`);
          return new Response(spec.content ?? "", {
            headers: {
              "Content-Type": "text/markdown; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        const specPlanMatch = path.match(/^\/api\/specs\/([^/]+)\/plan$/);
        if (specPlanMatch && method === "GET") {
          const id = decodeURIComponent(specPlanMatch[1]!);
          const plan = getLatestPlan(db, id);
          if (!plan) return notFound(`No plan for spec ${id}`);
          return new Response(plan.content, {
            headers: {
              "Content-Type": "text/markdown; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        if (path === "/api/tasks" && method === "GET") {
          const q = url.searchParams;
          const tasks = listTasks(db, {
            status: (q.get("status") as Task["status"] | null) ?? undefined,
            spec_id: q.get("spec") ?? undefined,
            owner: q.get("owner") ?? undefined,
            pending: q.get("pending") === "1" || q.get("pending") === "true",
          });
          return json(tasks);
        }

        const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
        if (taskMatch && method === "GET") {
          const id = decodeURIComponent(taskMatch[1]!);
          const task = getTask(db, id);
          if (!task) return notFound(`Task ${id} not found`);
          return json(task);
        }

        // GET /api/tasks/:id/worktree-status
        const taskWorktreeMatch = path.match(/^\/api\/tasks\/([^/]+)\/worktree-status$/);
        if (taskWorktreeMatch && method === "GET") {
          const id = decodeURIComponent(taskWorktreeMatch[1]!);
          const task = getTask(db, id);
          if (!task) return notFound(`Task ${id} not found`);
          const status = await inspectWorktree(task.worktree);
          return json(status);
        }

        // GET /api/agents — running agent processes with task matching
        if (path === "/api/agents" && method === "GET") {
          const inProgress = listTasks(db, { status: "in_progress" });
          // task.worktree is stored relative to the project root the server
          // was launched from — resolve it so it can be compared against the
          // absolute paths /proc/:pid/cwd returns.
          const expected = inProgress.map((t) => ({
            taskId: t.id,
            worktree: t.worktree ? resolve(process.cwd(), t.worktree) : null,
          }));
          const agents = await listAgentProcesses(expected);
          return json(agents);
        }

        // GET /api/context — repo and feinai DB context info for dashboard
        if (path === "/api/context" && method === "GET") {
          const repoRoot = findRepoRoot();
          const dbPath = findDbPath();
          const home = homedir();
          const feinaiPath = dbPath?.startsWith(home)
            ? `~${dbPath.slice(home.length)}`
            : (dbPath ?? null);
          return json({
            repoRoot: repoRoot ?? null,
            repoName: repoRoot ? basename(repoRoot) : null,
            feinaiPath,
          });
        }

        if (path === "/api/events" && method === "GET") {
          const limit = Number(url.searchParams.get("limit") ?? "50");
          if (Number.isNaN(limit) || limit < 1 || limit > 1000)
            return badRequest("limit must be between 1 and 1000");
          return json(listEvents(db, limit));
        }

        if (path === "/api/search" && method === "GET") {
          const q = url.searchParams.get("q") ?? "";
          if (!q.trim()) return json([]);
          return json(search(db, q.trim(), 20));
        }

        // ===== MUTATION ENDPOINTS =====

        // POST /api/specs — create spec
        if (path === "/api/specs" && method === "POST") {
          const body = await readJsonBody<{
            id?: string;
            title?: string;
            content?: string;
          }>(req);
          if (!body.id || !body.title)
            return badRequest("Required: id, title");
          const spec = addSpec(
            db,
            { id: body.id, title: body.title, content: body.content },
            actor,
          );
          return json(spec, 201);
        }

        // POST /api/specs/:id/start
        const specStartMatch = path.match(/^\/api\/specs\/([^/]+)\/start$/);
        if (specStartMatch && method === "POST") {
          const id = decodeURIComponent(specStartMatch[1]!);
          return json(startSpec(db, id, actor));
        }

        // POST /api/specs/:id/done
        const specDoneMatch = path.match(/^\/api\/specs\/([^/]+)\/done$/);
        if (specDoneMatch && method === "POST") {
          const id = decodeURIComponent(specDoneMatch[1]!);
          const body = await readJsonBody<{ pr?: string; merged_date?: string }>(req);
          return json(doneSpec(db, id, body, actor));
        }

        // POST /api/specs/:id/archive
        const specArchiveMatch = path.match(/^\/api\/specs\/([^/]+)\/archive$/);
        if (specArchiveMatch && method === "POST") {
          const id = decodeURIComponent(specArchiveMatch[1]!);
          return json(archiveSpec(db, id, actor));
        }

        // POST /api/specs/:id/unarchive
        const specUnarchiveMatch = path.match(/^\/api\/specs\/([^/]+)\/unarchive$/);
        if (specUnarchiveMatch && method === "POST") {
          const id = decodeURIComponent(specUnarchiveMatch[1]!);
          return json(unarchiveSpec(db, id, actor));
        }

        // DELETE /api/specs/:id
        const specDeleteMatch = path.match(/^\/api\/specs\/([^/]+)$/);
        if (specDeleteMatch && method === "DELETE") {
          const id = decodeURIComponent(specDeleteMatch[1]!);
          return json(deleteSpec(db, id, actor));
        }

        // POST /api/specs/:id/content — replace content
        const specContentPostMatch = path.match(/^\/api\/specs\/([^/]+)\/content$/);
        if (specContentPostMatch && method === "POST") {
          const id = decodeURIComponent(specContentPostMatch[1]!);
          const body = await readJsonBody<{ content?: string }>(req);
          if (typeof body.content !== "string")
            return badRequest("Required: content (string)");
          return json(setSpecContent(db, id, body.content, actor));
        }

        // POST /api/specs/:id/plans — add new plan version
        const specPlansMatch = path.match(/^\/api\/specs\/([^/]+)\/plans$/);
        if (specPlansMatch && method === "POST") {
          const id = decodeURIComponent(specPlansMatch[1]!);
          const body = await readJsonBody<{ content?: string }>(req);
          if (typeof body.content !== "string")
            return badRequest("Required: content (string)");
          return json(addPlan(db, id, body.content, actor), 201);
        }

        // POST /api/tasks — create task
        if (path === "/api/tasks" && method === "POST") {
          const body = await readJsonBody<{
            id?: string;
            subject?: string;
            description?: string;
            spec_id?: string;
            packages?: string[];
            quality_gates?: string[];
            blocked_by?: string[];
          }>(req);
          if (!body.id || !body.subject)
            return badRequest("Required: id, subject");
          const task = addTask(db, {
            id: body.id,
            subject: body.subject,
            description: body.description,
            spec_id: body.spec_id,
            packages: body.packages,
            quality_gates: body.quality_gates,
            blocked_by: body.blocked_by,
          });
          return json(task, 201);
        }

        // POST /api/tasks/:id/take
        const taskTakeMatch = path.match(/^\/api\/tasks\/([^/]+)\/take$/);
        if (taskTakeMatch && method === "POST") {
          const id = decodeURIComponent(taskTakeMatch[1]!);
          const body = await readJsonBody<{ owner?: string }>(req).catch(() => ({} as { owner?: string }));
          const owner = body.owner ?? actor;
          return json(takeTask(db, id, owner));
        }

        // POST /api/tasks/:id/done
        const taskDoneMatch = path.match(/^\/api\/tasks\/([^/]+)\/done$/);
        if (taskDoneMatch && method === "POST") {
          const id = decodeURIComponent(taskDoneMatch[1]!);
          const body = await readJsonBody<{ result?: string }>(req);
          if (!body.result) return badRequest("Required: result");
          return json(doneTask(db, id, body.result, actor));
        }

        // POST /api/tasks/:id/fail
        const taskFailMatch = path.match(/^\/api\/tasks\/([^/]+)\/fail$/);
        if (taskFailMatch && method === "POST") {
          const id = decodeURIComponent(taskFailMatch[1]!);
          const body = await readJsonBody<{ error?: string }>(req);
          if (!body.error) return badRequest("Required: error");
          return json(failTask(db, id, body.error, actor));
        }

        // POST /api/tasks/:id/block
        const taskBlockMatch = path.match(/^\/api\/tasks\/([^/]+)\/block$/);
        if (taskBlockMatch && method === "POST") {
          const id = decodeURIComponent(taskBlockMatch[1]!);
          const body = await readJsonBody<{ by?: string }>(req);
          if (!body.by) return badRequest("Required: by");
          return json(blockTask(db, id, body.by));
        }

        // POST /api/tasks/:id/release
        const taskReleaseMatch = path.match(/^\/api\/tasks\/([^/]+)\/release$/);
        if (taskReleaseMatch && method === "POST") {
          const id = decodeURIComponent(taskReleaseMatch[1]!);
          return json(releaseTask(db, id, actor));
        }

        // POST /api/tasks/:id/reopen
        const taskReopenMatch = path.match(/^\/api\/tasks\/([^/]+)\/reopen$/);
        if (taskReopenMatch && method === "POST") {
          const id = decodeURIComponent(taskReopenMatch[1]!);
          return json(reopenTask(db, id, actor));
        }

        return notFound();
      } catch (err) {
        return serverError(err);
      } finally {
        db.close();
      }
    },
  });

  return {
    url: `http://${server.hostname}:${server.port}`,
    stop: () => {
      // Clear the server_state row on graceful shutdown
      try {
        const db = openDb();
        clearServerState(db);
        db.close();
      } catch {
        // DB might not exist or be inaccessible; ignore to avoid masking
        // the actual server stop.
      }
      server.stop();
    },
  };
}

/**
 * SSE stream: server-side polls events table and pushes new events to client.
 * Replaces client-side polling. Client connects once, server sends updates
 * as they appear in the audit log.
 */
function handleSseStream(req: Request): Response {
  const encoder = new TextEncoder();
  let lastEventId = 0;
  let lastRequestLogId = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // Initialize lastEventId from current max so we don't replay all history
  try {
    const db = openDb();
    lastEventId = getMaxEventId(db);
    db.close();
  } catch {
    // ignore; will retry in poll
  }

  const stream = new ReadableStream({
    start(controller) {
      const send = (eventType: string, data: unknown) => {
        try {
          const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // controller closed
        }
      };

      // Initial hello so the client knows the stream is up
      send("hello", { since_event_id: lastEventId, at: new Date().toISOString() });

      // Replay current in-memory request log to the new client
      if (requestLog.length > 0) {
        for (const reqEntry of requestLog) {
          send("request", reqEntry);
          lastRequestLogId = Math.max(lastRequestLogId, reqEntry.id);
        }
      }

      pollTimer = setInterval(() => {
        let hadData = false;
        try {
          const db = openDb();
          const newEvents = db
            .prepare(
              `SELECT id, entity_type, entity_id, event_type, actor, payload, created_at
               FROM events WHERE id > ? ORDER BY id ASC LIMIT 50`,
            )
            .all(lastEventId) as EventRow[];
          db.close();

          if (newEvents.length > 0) {
            for (const ev of newEvents) {
              send(`event:${ev.event_type}`, ev);
              lastEventId = Math.max(lastEventId, ev.id);
            }
            hadData = true;
          }
        } catch {
          // DB unavailable transiently; try again on next tick
        }

        // Push new in-memory request log entries
        const newRequests = requestLog.filter((r) => r.id > lastRequestLogId);
        if (newRequests.length > 0) {
          for (const reqEntry of newRequests) {
            send("request", reqEntry);
            lastRequestLogId = reqEntry.id;
          }
          hadData = true;
        }

        if (hadData) {
          // Also send a generic "refresh" hint so dashboards can refetch summaries
          send("refresh", { last_event_id: lastEventId });
        } else {
          // Keep-alive comment to stop proxies from closing the connection
          try {
            controller.enqueue(encoder.encode(`: keep-alive\n\n`));
          } catch {
            // closed
          }
        }
      }, 1500);

      // Detect client disconnect
      req.signal.addEventListener("abort", () => {
        if (pollTimer) clearInterval(pollTimer);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      if (pollTimer) clearInterval(pollTimer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
