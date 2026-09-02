#!/usr/bin/env bun
import { readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { userInfo } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initDb, openDb, findDbPath } from "./db";
import {
  listTasks,
  getTask,
  addTask,
  takeTask,
  doneTask,
  failTask,
  blockTask,
  unblockTask,
  releaseTask,
  reopenTask,
  editTask,
  type EditTaskInput,
  type TaskStatus,
} from "./tasks";
import {
  listSpecs,
  getSpec,
  addSpec,
  startSpec,
  doneSpec,
  setSpecContent,
  addPlan,
  getLatestPlan,
  listPlans,
  editSpec,
  archiveSpec,
  unarchiveSpec,
  deleteSpec,
  type SpecStatus,
} from "./specs";
import {
  formatTask,
  formatTaskList,
  formatSpec,
  formatSpecList,
  formatPlan,
  formatPlanList,
  formatStatus,
  type OutputFormat,
} from "./format";
import {
  readServerState,
  writeServerState,
  clearServerState,
  findFreePort,
  repairServerState,
  killOrphansByProjectDir,
  type OrphanKillResult,
} from "./server-state";

const VERSION = "0.8.1";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, boolean>;
  options: Record<string, string>;
  multi: Record<string, string[]>;
}

const FLAG_NAMES = new Set([
  "json",
  "plain",
  "pending",
  "help",
  "version",
  "full",
  "force",
  "stdin",
  "down",
  "daemon",
  "yes",
  "clear-blocked-by",
  "no-preflight",
]);
const MULTI_OPTIONS = new Set(["package", "gate", "blocked-by"]);

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    positional: [],
    flags: {},
    options: {},
    multi: {},
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== "string") continue;

    if (arg === "-d") {
      result.flags["daemon"] = true;
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (FLAG_NAMES.has(key)) {
        result.flags[key] = true;
        continue;
      }

      const next = argv[i + 1];
      if (typeof next === "string" && !next.startsWith("--")) {
        if (MULTI_OPTIONS.has(key)) {
          (result.multi[key] ??= []).push(next);
        } else {
          result.options[key] = next;
        }
        i++;
      } else {
        result.flags[key] = true;
      }
    } else {
      result.positional.push(arg);
    }
  }

  return result;
}

function detectFormat(args: ParsedArgs): OutputFormat {
  if (args.flags.json) return "json";
  if (args.flags.plain) return "plain";
  return process.stdout.isTTY ? "color" : "plain";
}

/**
 * Build a stable identifier for whoever is invoking feinai.
 *
 * Priority:
 *   1. $FEINAI_USER env var (explicit override — used by agents to identify themselves)
 *   2. parent process name (on Linux via /proc/$PPID/comm) → "{parent_name}:{ppid}:{user}"
 *   3. fallback: "{user}@{hostname}"
 *
 * The parent process name lets us distinguish "harness-a:12345:m" from "harness-b:23456:m"
 * from "bash:9999:m" in the events audit log without manual configuration.
 */
function getCurrentUser(): string {
  const override = process.env.FEINAI_USER;
  if (override) return override;

  const username = process.env.USER ?? userInfo().username ?? "unknown";
  const ppid = process.ppid;

  let parentName: string | null = null;
  try {
    if (process.platform === "linux") {
      parentName = readFileSync(`/proc/${ppid}/comm`, "utf-8").trim();
    } else if (process.platform === "darwin") {
      // On macOS /proc doesn't exist; use ps if available, otherwise skip.
      const proc = Bun.spawnSync(["ps", "-o", "comm=", "-p", String(ppid)]);
      if (proc.exitCode === 0) {
        const out = proc.stdout.toString().trim();
        parentName = out.split("/").pop() ?? null;
      }
    }
  } catch {
    parentName = null;
  }

  if (parentName) return `${parentName}:${ppid}:${username}`;
  return `${username}@${process.env.HOSTNAME ?? "local"}`;
}

function ensureDb(): ReturnType<typeof openDb> {
  if (!findDbPath()) {
    console.error(
      "Error: no .feinai/feinai.db found. Run 'feinai init' to create one.",
    );
    process.exit(2);
  }
  return openDb();
}

function readStdin(): string {
  return readFileSync(0, "utf-8");
}

function readContentFromArgs(args: ParsedArgs): string | undefined {
  if (args.flags.stdin) return readStdin();
  if (args.options.file) return readFileSync(args.options.file, "utf-8");
  if (args.options.content) return args.options.content;
  return undefined;
}

function showHelp(): void {
  console.log(`feinai v\${VERSION} — task & spec manager for AI agents and humans

USAGE:
  feinai <command> [options]

DB MANAGEMENT:
  init [--force]                    Create .feinai/feinai.db in cwd
  destroy [--yes]                   Delete .feinai/ entirely (prompts unless --yes)
                                    (--force allows nesting under an existing DB)
  status                            Summary of pending/in_progress/completed counts

TASKS:
  list [filters]                    List tasks
    --status <status>               Filter by status
    --pending                       Shortcut for --status pending
    --spec <SPEC-ID>                Filter by spec
    --owner <name>                  Filter by owner

  add <TASK-ID> <subject>           Create new task
    --spec <SPEC-ID>                Link to spec
    --desc <text>                   Description / workplan
    --package <name>                Add package (repeatable)
    --gate <cmd>                    Add quality gate (repeatable)
    --blocked-by <TASK-ID>          Add dependency (repeatable)

  show <TASK-ID>                    Show full task detail
  take <TASK-ID> [--owner <name>]   Atomically claim a pending task
                                    (returns full task payload — single call)
  done <TASK-ID> --result <text>    Mark task completed
  fail <TASK-ID> --error <text>     Mark task failed
  block <TASK-ID> --by <TASK-ID>    Add a dependency
  unblock <TASK-ID> --dep <TASK-ID> Remove a specific dependency
  release <TASK-ID>                 Release back to pending (in_progress → pending)
  reopen <TASK-ID>                  Reopen to pending (completed/failed → pending)
  edit <TASK-ID>                    Edit task metadata (any status)
    --subject <text>                Replace subject
    --desc <text>                   Replace description (also --stdin, --file)
    --package <name>                Replace packages array (repeatable)
    --gate <cmd>                    Replace quality_gates array (repeatable)
    --clear-blocked-by              Clear all dependencies

SPECS:
  spec list [--status <status>]
  spec show <SPEC-ID> [--full]
  spec add <SPEC-ID> <title>        Create spec
    --content <text>                Inline markdown content
    --file <path>                   Read content from file
    --stdin                         Read content from stdin
  spec content <SPEC-ID>            Print spec markdown content to stdout
  spec set-content <SPEC-ID>        Replace spec content (same content flags as add)
  spec start <SPEC-ID>              Mark spec as in progress
  spec done <SPEC-ID>               Mark spec as completed
    --pr <number>
    --merged <YYYY-MM-DD>
  spec edit <SPEC-ID>               Edit spec metadata
    --title <text>                  Replace title

PLANS:
  plan add <SPEC-ID>                Create new plan revision for a spec
    --content <text> | --file <path> | --stdin
  plan show <SPEC-ID>               Print latest plan markdown to stdout
  plan list <SPEC-ID>               List all plan versions for a spec

SERVER:
  server                            Start HTTP dashboard + REST API
    --port <N>                      Port (default: 8272 — TASC on phone keypad)
    --host <addr>                   Bind host (default: 127.0.0.1)
  server --daemon / -d              Start detached (no job control noise)
  server --down                     Stop this project's recorded feinai server

GLOBAL FLAGS:
  --json                            Output as JSON
  --plain                           Output without colors
  --help                            Show this help
  --version                         Show version

ENV:
  FEINAI_USER                        Override owner/actor identity used in audit log

\x1b[34m\x1b[1m── Agent Harness Skills ───────────────────────────────────────────\x1b[0m
  \x1b[36mActivate feinai skills for your agent harness (run once after install):\x1b[0m

  \x1b[33mmkdir -p <your-harness-skills-dir>\x1b[0m
  \x1b[33mSKILLS=~/.bun/install/global/node_modules/feinai/skills\x1b[0m
  \x1b[33mfor skill in feinai-sdd feinai-write-spec feinai-write-tasks feinai-dispatch feinai-implement; do\x1b[0m
  \x1b[33m  ln -sf "$SKILLS/$skill" <your-harness-skills-dir>/$skill\x1b[0m
  \x1b[33mdone\x1b[0m

  \x1b[36mSkills included:\x1b[0m
\x1b[34m    \x1b[1;94mfeinai-sdd\x1b[0m  \x1b[1;94mfeinai-write-spec\x1b[0m  \x1b[1;94mfeinai-write-tasks\x1b[0m  \x1b[1;94mfeinai-dispatch\x1b[0m  \x1b[1;94mfeinai-implement\x1b[0m
\x1b[34m\x1b[1m────────────────────────────────────────────────────────────────────\x1b[0m
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.version) {
    console.log(VERSION);
    return;
  }
  if (args.flags.help || args.positional.length === 0) {
    showHelp();
    return;
  }

  const [command, ...rest] = args.positional;
  const format = detectFormat(args);

  try {
    switch (command) {
      case "init":
        return cmdInit(args);
      case "status":
        return cmdStatus(format);
      case "list":
        return cmdList(args, format);
      case "add":
        return cmdAdd(rest, args, format);
      case "show":
        return cmdShow(rest, format);
      case "take":
        return cmdTake(rest, args, format);
      case "done":
        return cmdDone(rest, args, format);
      case "fail":
        return cmdFail(rest, args, format);
      case "block":
        return cmdBlock(rest, args, format);
      case "unblock":
        return cmdUnblock(rest, args, format);
      case "release":
        return cmdRelease(rest, format);
      case "destroy":
        return cmdDestroy(args);
      case "reopen":
        return cmdReopen(rest, format);
      case "edit":
        return cmdTaskEdit(rest, args, format);
      case "spec":
        return cmdSpec(rest, args, format);
      case "plan":
        return cmdPlan(rest, args, format);
      case "server":
        return cmdServer(args);
      case "git":
        return cmdGit(rest);
      case "whoami":
        console.log(getCurrentUser());
        return;
      default:
        console.error(`Unknown command: ${command}`);
        console.error("Run 'feinai --help' for usage.");
        process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (format === "json") {
      console.error(JSON.stringify({ error: msg }));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }
}

function cmdGit(rest: string[]): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const opengitPath = resolve(__dirname, "opengit.sh");

  if (rest.length === 0) {
    console.error("Usage: feinai git <subcommand> [args...]");
    console.error("Runs opengit — safe git wrapper for parallel worktree workflows.");
    process.exit(1);
  }

  const result = spawnSync(opengitPath, rest, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

async function cmdDestroy(args: ParsedArgs): Promise<void> {
  const dbPath = findDbPath();
  if (!dbPath) {
    console.error("Error: no .feinai/feinai.db found.");
    process.exit(2);
  }

  if (!args.flags["yes"]) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) =>
      rl.question(`Destroy ${dbPath}? This cannot be undone. [y/N] `, resolve)
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.log("Aborted.");
      return;
    }
  }

  const feinaiDir = dbPath.replace(/\/feinai\.db$/, "");
  rmSync(feinaiDir, { recursive: true, force: true });
  console.log(`Destroyed ${feinaiDir}`);
}

function cmdInit(args: ParsedArgs): void {
  const existing = findDbPath();
  if (existing && !args.flags.force) {
    console.error(`feinai DB already exists at ${existing}`);
    console.error(`Use --force to create a nested DB anyway.`);
    process.exit(1);
  }
  const path = initDb();
  console.log(`Initialized feinai DB at ${path}`);

  // Auto-add .feinai/ to .gitignore if inside a git repo
  if (existsSync(".git")) {
    const gitignorePath = ".gitignore";
    const entry = ".feinai/";

    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, entry + "\n");
      console.log(".feinai/ added to .gitignore");
    } else {
      const content = readFileSync(gitignorePath, "utf-8");
      if (!content.includes(entry)) {
        const separator = content.endsWith("\n") ? "" : "\n";
        writeFileSync(gitignorePath, content + separator + entry + "\n");
        console.log(".feinai/ added to .gitignore");
      }
    }
  }
}

function cmdStatus(format: OutputFormat): void {
  const db = ensureDb();
  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) AS in_progress,
         SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed
       FROM tasks`,
    )
    .get() as { pending: number; in_progress: number; completed: number };
  const specs = (db.prepare(`SELECT COUNT(*) AS n FROM specs`).get() as { n: number }).n;
  const plans = (db.prepare(`SELECT COUNT(*) AS n FROM plans`).get() as { n: number }).n;

  // Check server state: validate and repair stale records first
  const serverRecord = repairServerState(db);
  const serverRunning = serverRecord !== null;
  const serverPort = serverRecord?.port ?? 8272;
  const serverUrl = serverRunning ? `http://127.0.0.1:${serverPort}` : undefined;

  console.log(
    formatStatus(
      {
        pending: counts.pending ?? 0,
        in_progress: counts.in_progress ?? 0,
        completed: counts.completed ?? 0,
        specs,
        plans,
        serverRunning,
        serverPort,
        serverUrl,
      },
      format,
    ),
  );
}

function cmdList(args: ParsedArgs, format: OutputFormat): void {
  const db = ensureDb();
  const tasks = listTasks(db, {
    status: args.options.status as TaskStatus | undefined,
    pending: args.flags.pending,
    spec_id: args.options.spec,
    owner: args.options.owner,
  });
  console.log(formatTaskList(tasks, format));
}

function cmdAdd(rest: string[], args: ParsedArgs, format: OutputFormat): void {
  const [id, ...subjectParts] = rest;
  if (!id || subjectParts.length === 0) {
    console.error(
      "Usage: feinai add <TASK-ID> <subject> [--spec ID] [--desc text] [--package X] [--gate X]",
    );
    process.exit(1);
  }
  const db = ensureDb();
  const task = addTask(db, {
    id,
    subject: subjectParts.join(" "),
    description: args.options.desc,
    spec_id: args.options.spec,
    packages: args.multi.package ?? [],
    quality_gates: args.multi.gate ?? [],
    blocked_by: args.multi["blocked-by"] ?? [],
  });
  console.log(formatTask(task, format));
}

function cmdShow(rest: string[], format: OutputFormat): void {
  const [id] = rest;
  if (!id) {
    console.error("Usage: feinai show <TASK-ID>");
    process.exit(1);
  }
  const db = ensureDb();
  const task = getTask(db, id);
  if (!task) {
    console.error(`Task ${id} not found`);
    process.exit(1);
  }

  if (task.spec_id) {
    const spec = getSpec(db, task.spec_id);
    const plan = spec ? (getLatestPlan(db, task.spec_id) ?? undefined) : undefined;
    if (format === "json") {
      console.log(JSON.stringify({ ...task, spec_context: spec ? { ...spec, plan_content: plan?.content ?? null } : null }, null, 2));
    } else {
      console.log(formatTask(task, format));
      if (spec) {
        console.log();
        console.log(formatSpec(spec, format, { includeContent: true, plan }));
      }
    }
    return;
  }

  console.log(formatTask(task, format));
}

function cmdTake(rest: string[], args: ParsedArgs, format: OutputFormat): void {
  const [id] = rest;
  if (!id) {
    console.error("Usage: feinai take <TASK-ID> [--owner name]");
    process.exit(1);
  }
  const db = ensureDb();
  const owner = args.options.owner ?? getCurrentUser();
  const task = takeTask(db, id, owner);

  if (task.spec_id) {
    const spec = getSpec(db, task.spec_id);
    const plan = spec ? (getLatestPlan(db, task.spec_id) ?? undefined) : undefined;
    if (format === "json") {
      console.log(JSON.stringify({ ...task, spec_context: spec ? { ...spec, plan_content: plan?.content ?? null } : null }, null, 2));
    } else {
      console.log(formatTask(task, format));
      if (spec) {
        console.log();
        console.log(formatSpec(spec, format, { includeContent: true, plan }));
      }
    }
    return;
  }

  console.log(formatTask(task, format));
}

function cmdDone(rest: string[], args: ParsedArgs, format: OutputFormat): void {
  const [id] = rest;
  const result = args.options.result;
  if (!id || !result) {
    console.error("Usage: feinai done <TASK-ID> --result <text>");
    process.exit(1);
  }
  const db = ensureDb();
  const task = doneTask(db, id, result, getCurrentUser());
  console.log(formatTask(task, format));
}

function cmdFail(rest: string[], args: ParsedArgs, format: OutputFormat): void {
  const [id] = rest;
  const error = args.options.error;
  if (!id || !error) {
    console.error("Usage: feinai fail <TASK-ID> --error <text>");
    process.exit(1);
  }
  const db = ensureDb();
  const task = failTask(db, id, error, getCurrentUser());
  console.log(formatTask(task, format));
}

function cmdRelease(rest: string[], format: OutputFormat): void {
  const [id] = rest;
  if (!id) { console.error("Usage: feinai release <TASK-ID>"); process.exit(1); }
  const db = ensureDb();
  const task = releaseTask(db, id, getCurrentUser());
  console.log(formatTask(task, format));
}

function cmdReopen(rest: string[], format: OutputFormat): void {
  const [id] = rest;
  if (!id) { console.error("Usage: feinai reopen <TASK-ID>"); process.exit(1); }
  const db = ensureDb();
  const task = reopenTask(db, id, getCurrentUser());
  console.log(formatTask(task, format));
}

function cmdBlock(rest: string[], args: ParsedArgs, format: OutputFormat): void {
  const [id] = rest;
  const by = args.options.by;
  if (!id || !by) {
    console.error("Usage: feinai block <TASK-ID> --by <BLOCKER-ID>");
    process.exit(1);
  }
  const db = ensureDb();
  const task = blockTask(db, id, by);
  console.log(formatTask(task, format));
}

function cmdUnblock(rest: string[], args: ParsedArgs, format: OutputFormat): void {
  const [id] = rest;
  const dep = args.options.dep;
  if (!id || !dep) {
    console.error("Usage: feinai unblock <TASK-ID> --dep <BLOCKER-ID>");
    process.exit(1);
  }
  const db = ensureDb();
  const task = unblockTask(db, id, dep);
  console.log(formatTask(task, format));
}

function cmdTaskEdit(rest: string[], args: ParsedArgs, format: OutputFormat): void {
  const [id] = rest;
  if (!id) {
    console.error('Usage: feinai task edit <TASK-ID> [--subject text] [--desc text] [--package name] [--gate cmd]');
    console.error('       Supports --stdin and --file for --desc');
    process.exit(1);
  }

  let description: string | undefined;
  if (args.flags.stdin) description = readStdin();
  else if (args.options.file) description = readFileSync(args.options.file, 'utf-8');
  else if (args.options.desc !== undefined) description = args.options.desc;

  const input: EditTaskInput = {};
  if (args.options.subject !== undefined) input.subject = args.options.subject;
  if (description !== undefined) input.description = description;
  if (args.multi.package?.length) input.packages = args.multi.package;
  if (args.multi.gate?.length) input.quality_gates = args.multi.gate;
  if (args.options.worktree !== undefined) input.worktree = args.options.worktree || null;
  if (args.flags["clear-blocked-by"]) input.blocked_by = [];

  const db = ensureDb();
  const task = editTask(db, id, input, getCurrentUser());
  console.log(formatTask(task, format));
}

function cmdSpec(rest: string[], args: ParsedArgs, format: OutputFormat): void {
  const [subcommand, ...subRest] = rest;
  const db = ensureDb();
  const actor = getCurrentUser();

  switch (subcommand) {
    case "list": {
      const status = args.options.status as SpecStatus | undefined;
      console.log(formatSpecList(listSpecs(db, status), format));
      return;
    }
    case "show": {
      const [id] = subRest;
      if (!id) {
        console.error("Usage: feinai spec show <SPEC-ID> [--full]");
        process.exit(1);
      }
      const spec = getSpec(db, id);
      if (!spec) {
        console.error(`Spec ${id} not found`);
        process.exit(1);
      }
      const plan = getLatestPlan(db, id) ?? undefined;
      console.log(formatSpec(spec, format, { includeContent: args.flags.full, plan }));
      return;
    }
    case "content": {
      const [id] = subRest;
      if (!id) {
        console.error("Usage: feinai spec content <SPEC-ID>");
        process.exit(1);
      }
      const spec = getSpec(db, id);
      if (!spec) {
        console.error(`Spec ${id} not found`);
        process.exit(1);
      }
      if (!spec.content) {
        console.error(`Spec ${id} has no content`);
        process.exit(1);
      }
      process.stdout.write(spec.content);
      return;
    }
    case "add": {
      const [id, ...titleParts] = subRest;
      if (!id || titleParts.length === 0) {
        console.error(
          "Usage: feinai spec add <SPEC-ID> <title> [--content text | --file path | --stdin]",
        );
        process.exit(1);
      }
      const spec = addSpec(
        db,
        { id, title: titleParts.join(" "), content: readContentFromArgs(args) },
        actor,
      );
      console.log(formatSpec(spec, format));
      return;
    }
    case "set-content": {
      const [id] = subRest;
      if (!id) {
        console.error(
          "Usage: feinai spec set-content <SPEC-ID> --content text | --file path | --stdin",
        );
        process.exit(1);
      }
      const content = readContentFromArgs(args);
      if (content === undefined) {
        console.error("Provide content via --content, --file, or --stdin");
        process.exit(1);
      }
      const spec = setSpecContent(db, id, content, actor);
      console.log(formatSpec(spec, format));
      return;
    }
    case "start": {
      const [id] = subRest;
      if (!id) {
        console.error("Usage: feinai spec start <SPEC-ID>");
        process.exit(1);
      }
      console.log(formatSpec(startSpec(db, id, actor), format));
      return;
    }
    case "done": {
      const [id] = subRest;
      if (!id) {
        console.error("Usage: feinai spec done <SPEC-ID> [--pr N] [--merged YYYY-MM-DD]");
        process.exit(1);
      }
      const spec = doneSpec(
        db,
        id,
        { pr: args.options.pr, merged_date: args.options.merged },
        actor,
      );
      console.log(formatSpec(spec, format));
      return;
    }
    case "edit": {
      const [id] = subRest;
      if (!id) {
        console.error("Usage: feinai spec edit <SPEC-ID> [--title text]");
        process.exit(1);
      }
      const spec = editSpec(db, id, { title: args.options.title }, actor);
      console.log(formatSpec(spec, format));
      return;
    }
    case "archive": {
      const [id] = subRest;
      if (!id) { console.error("Usage: feinai spec archive <SPEC-ID>"); process.exit(1); }
      console.log(formatSpec(archiveSpec(db, id, actor), format));
      return;
    }
    case "unarchive": {
      const [id] = subRest;
      if (!id) { console.error("Usage: feinai spec unarchive <SPEC-ID>"); process.exit(1); }
      console.log(formatSpec(unarchiveSpec(db, id, actor), format));
      return;
    }
    case "delete": {
      const [id] = subRest;
      if (!id) { console.error("Usage: feinai spec delete <SPEC-ID>"); process.exit(1); }
      console.log(JSON.stringify(deleteSpec(db, id, actor)));
      return;
    }
    default:
      console.error(`Unknown spec subcommand: ${subcommand ?? "(none)"}`);
      console.error("Available: list, show, content, add, set-content, start, done, edit, archive, unarchive, delete");
      process.exit(1);
  }
}

async function cmdServer(args: ParsedArgs): Promise<void> {
  // --down: stop this project's recorded server AND any orphan servers that
  // share the project directory, so stale/untracked processes are cleaned up.
  if (args.flags["down"]) {
    if (!findDbPath()) {
      console.error(
        "Error: no .feinai/feinai.db found. Cannot stop server without project context.",
      );
      process.exit(2);
    }

    const dbPath = findDbPath()!;
    const db = openDb();
    repairServerState(db);
    const record = readServerState(db);
    const killed: OrphanKillResult[] = [];

    if (record) {
      try {
        process.kill(record.pid, "SIGTERM");
        killed.push({ pid: record.pid, port: record.port });
      } catch {
        console.error(
          `Failed to stop feinai server (PID ${record.pid}, port ${record.port}).`,
        );
      }
      clearServerState(db);
    }
    db.close();

    // Also kill any unregistered servers whose CWD matches this project.
    // The DB lives at <projectDir>/.feinai/feinai.db, so go up two levels.
    const projectDir = dirname(dirname(dbPath));
    const orphans = killOrphansByProjectDir(projectDir);
    killed.push(...orphans);

    if (killed.length === 0) {
      console.log("No running feinai server found for this project.");
    } else {
      const summary = killed
        .map((k) => `PID ${k.pid}${k.port ? ` (port ${k.port})` : ""}`)
        .join(", ");
      console.log(`Stopped feinai server(s): ${summary}`);
    }
    return;
  }

  // Verify DB exists before starting server (fast fail)
  if (!findDbPath()) {
    console.error("Error: no .feinai/feinai.db found. Run 'feinai init' first.");
    process.exit(2);
  }

  const db = ensureDb();
  const host = args.options.host ?? "127.0.0.1";
  const noPreflight = args.flags["no-preflight"];

  // Pre-flight consistency check: repair stale records, reject if valid server exists.
  // Skipped when the child is launched by the daemon parent (it already validated).
  if (!noPreflight) {
    repairServerState(db);
    const existing = readServerState(db);
    if (existing) {
      console.error(
        `feinai server is already running for this project at http://127.0.0.1:${existing.port}`,
      );
      console.error(`Stop it first with: feinai server --down`);
      db.close();
      process.exit(1);
    }
  }

  // Determine port: if --port is given, use it; otherwise auto-increment from 8272
  const requestedPort = args.options.port ? Number(args.options.port) : undefined;
  let resolvedPort: number;

  if (requestedPort !== undefined) {
    if (isNaN(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
      console.error("Error: --port must be a valid port number (1-65535)");
      db.close();
      process.exit(1);
    }
    if (findFreePort(requestedPort) !== requestedPort) {
      console.error(`Error: port ${requestedPort} is already in use.`);
      db.close();
      process.exit(1);
    }
    resolvedPort = requestedPort;
  } else {
    resolvedPort = findFreePort(8272);
  }

  if (args.flags["daemon"]) {
    // Spawn a detached child WITHOUT starting the server in the parent first.
    const noDaemon = (a: string) => a !== "--daemon" && a !== "-d";
    // In compiled binary argv[1] is a virtual /$bunfs/ path — skip it; user args start at argv[2].
    // In dev mode (bun src/cli.ts) argv[1] is the script path — keep it.
    const isCompiled = process.argv[1]?.startsWith("/$bunfs/");
    let childArgs: string[];
    if (isCompiled) {
      childArgs = [process.execPath, ...process.argv.slice(2).filter(noDaemon)];
    } else {
      childArgs = [process.execPath, ...process.argv.slice(1).filter(noDaemon)];
    }
    // Force the resolved port and the internal no-preflight flag onto the child.
    // Strip any existing --port so the child always uses the port we resolved here.
    for (let i = 0; i < childArgs.length; ) {
      if (childArgs[i] === "--port") {
        childArgs.splice(i, 2);
        continue;
      }
      i++;
    }
    childArgs.push("--port", String(resolvedPort), "--no-preflight");

    const child = Bun.spawn(childArgs, { detached: true, stdio: ["ignore", "ignore", "ignore"] });

    // The parent owns the DB record: write it immediately with the child's pid
    // so the server is tracked before the parent exits.
    writeServerState(db, resolvedPort, child.pid);
    child.unref();
    console.log(`feinai dashboard → http://${host}:${resolvedPort}`);
    console.log(`Stop with: feinai server --down`);
    db.close();
    return;
  }

  // Lazy import so server.ts and dashboard.ts aren't loaded in non-server CLI invocations.
  const { startServer } = await import("./server");
  const server = startServer({ port: resolvedPort, host });

  // Write the server state row after successful bind (only when the CLI is the
  // actual server process; daemon children skip this because the parent wrote it).
  if (!noPreflight) {
    writeServerState(db, resolvedPort, process.pid);
  }
  db.close();

  console.log(`feinai dashboard listening at ${server.url}`);
  console.log(`Stop with: feinai server --down`);

  const shutdown = () => {
    console.log("\nStopping server...");
    const cleanupDb = ensureDb();
    clearServerState(cleanupDb);
    cleanupDb.close();
    server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function cmdPlan(rest: string[], args: ParsedArgs, format: OutputFormat): void {
  const [subcommand, ...subRest] = rest;
  const db = ensureDb();
  const actor = getCurrentUser();

  switch (subcommand) {
    case "add": {
      const [specId] = subRest;
      if (!specId) {
        console.error(
          "Usage: feinai plan add <SPEC-ID> --content text | --file path | --stdin",
        );
        process.exit(1);
      }
      const content = readContentFromArgs(args);
      if (content === undefined) {
        console.error("Provide content via --content, --file, or --stdin");
        process.exit(1);
      }
      const plan = addPlan(db, specId, content, actor);
      console.log(formatPlan(plan, format));
      return;
    }
    case "show": {
      const [specId] = subRest;
      if (!specId) {
        console.error("Usage: feinai plan show <SPEC-ID>");
        process.exit(1);
      }
      const plan = getLatestPlan(db, specId);
      if (!plan) {
        console.error(`No plan found for spec ${specId}`);
        process.exit(1);
      }
      process.stdout.write(plan.content);
      return;
    }
    case "list": {
      const [specId] = subRest;
      if (!specId) {
        console.error("Usage: feinai plan list <SPEC-ID>");
        process.exit(1);
      }
      console.log(formatPlanList(listPlans(db, specId), format));
      return;
    }
    default:
      console.error(`Unknown plan subcommand: ${subcommand ?? "(none)"}`);
      console.error("Available: add, show, list");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
