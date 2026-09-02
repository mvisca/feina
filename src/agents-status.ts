import { readlink } from "node:fs/promises";

export interface AgentProcess {
  pid: number;
  cpu: number;
  mem: number;
  command: string;
  taskId: string | null;
  /** true if the process's cwd was confirmed inside the task's worktree */
  verified: boolean;
}

export interface ExpectedAgent {
  taskId: string;
  worktree: string | null;
}

/**
 * Snapshot of processes that look like they're working on active tasks.
 *
 * Matching is done two ways:
 * 1. By worktree cwd (`/proc/:pid/cwd`) against each expected task's worktree
 *    path — this is the precise signal and sets `verified: true`.
 * 2. By a `TASK-...` substring in the command line — kept as a fallback so we
 *    don't lose visibility into agents whose cwd we can't resolve (e.g. the
 *    process already exited, or /proc isn't readable), but reported as
 *    `verified: false` since a substring match can be coincidental or belong
 *    to an unrelated project using the same task ID scheme.
 */
export async function listAgentProcesses(
  expected: ExpectedAgent[] = [],
): Promise<AgentProcess[]> {
  let lines: string[];
  try {
    const result = await Bun.$`ps -eo pid,pcpu,pmem,command`.text();
    lines = result.trim().split("\n").slice(1).filter(Boolean);
  } catch {
    return [];
  }

  const worktreeByTask = new Map(
    expected
      .filter((e): e is ExpectedAgent & { worktree: string } => !!e.worktree)
      .map((e) => [e.taskId, e.worktree]),
  );

  const candidates: Omit<AgentProcess, "verified">[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = parseInt(parts[0]!, 10);
    const cpu = parseFloat(parts[1]!);
    const mem = parseFloat(parts[2]!);
    const command = parts.slice(3).join(" ");
    if (!Number.isFinite(pid)) continue;
    const taskMatch = command.match(/TASK-[A-Z0-9-]+/);
    const taskId = taskMatch ? taskMatch[0] : null;
    if (!taskId) continue;
    candidates.push({ pid, cpu, mem, command, taskId });
  }

  const results = await Promise.all(
    candidates.map(async (c) => {
      const worktree = c.taskId ? worktreeByTask.get(c.taskId) : undefined;
      let verified = false;
      if (worktree) {
        try {
          const cwd = await readlink(`/proc/${c.pid}/cwd`);
          verified = cwd === worktree || cwd.startsWith(worktree + "/");
        } catch {
          verified = false;
        }
      }
      return { ...c, verified };
    }),
  );

  return results;
}
