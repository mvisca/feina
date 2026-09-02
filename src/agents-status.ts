import { readdir, readlink } from "node:fs/promises";

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
  /** absolute path to the task's worktree, or null if it has none */
  worktree: string | null;
}

interface PsRow {
  pid: number;
  cpu: number;
  mem: number;
  command: string;
}

async function psSnapshot(): Promise<PsRow[]> {
  try {
    const result = await Bun.$`ps -eo pid,pcpu,pmem,command`.text();
    return result
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return {
          pid: parseInt(parts[0]!, 10),
          cpu: parseFloat(parts[1]!),
          mem: parseFloat(parts[2]!),
          command: parts.slice(3).join(" "),
        };
      })
      .filter((p) => Number.isFinite(p.pid));
  } catch {
    return [];
  }
}

/**
 * Snapshot of processes working on active tasks.
 *
 * Real agent sessions here (an interactive `claude` or `opencode` process cd'd
 * into a task's git worktree) rarely put the task ID anywhere in their
 * command line — so grepping ps output for `TASK-...` misses them entirely.
 * The reliable signal is the process's current working directory: for each
 * in_progress task with a worktree, we check every process's
 * `/proc/:pid/cwd` against that worktree path. A cwd match is `verified: true`.
 *
 * As a fallback (e.g. a task has no worktree yet, or /proc isn't readable),
 * we also look for a literal `TASK-...` substring in the command line —
 * kept as `verified: false` since it's coincidental at best.
 */
export async function listAgentProcesses(
  expected: ExpectedAgent[] = [],
): Promise<AgentProcess[]> {
  const rows = await psSnapshot();
  if (!rows.length) return [];

  const pids = await readdir("/proc").catch(() => [] as string[]);
  const numericPids = new Set(pids.filter((p) => /^\d+$/.test(p)).map(Number));

  const cwdByPid = new Map<number, string>();
  await Promise.all(
    rows
      .filter((r) => numericPids.has(r.pid))
      .map(async (r) => {
        try {
          cwdByPid.set(r.pid, await readlink(`/proc/${r.pid}/cwd`));
        } catch {
          // process exited or unreadable — no cwd signal for it
        }
      }),
  );

  const results: AgentProcess[] = [];
  const matchedPids = new Set<number>();

  for (const { taskId, worktree } of expected) {
    if (!worktree) continue;
    for (const row of rows) {
      if (matchedPids.has(row.pid)) continue;
      const cwd = cwdByPid.get(row.pid);
      if (!cwd) continue;
      if (cwd === worktree || cwd.startsWith(worktree + "/")) {
        matchedPids.add(row.pid);
        results.push({ ...row, taskId, verified: true });
      }
    }
  }

  for (const row of rows) {
    if (matchedPids.has(row.pid)) continue;
    const taskMatch = row.command.match(/TASK-[A-Z0-9-]+/);
    if (!taskMatch) continue;
    results.push({ ...row, taskId: taskMatch[0], verified: false });
  }

  return results;
}
