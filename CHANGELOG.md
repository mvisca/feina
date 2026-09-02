# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.8.2] - 2026-09-02

### Fixed

- **Flicker en el dashboard mientras una página de spec/task detail estaba abierta.** `logRequest` sólo suprimía un listado exacto de paths (`/api/status`, `/api/specs`, ...); los reads con id (`/api/tasks/:id`, `/api/tasks/:id/worktree-status`) se colaban al log de requests. Cada uno disparaba el evento SSE `refresh`, que hacía que el dashboard se re-renderizara y re-fetchara la misma página, generando un nuevo request logueado — un loop autoalimentado de ~1.5s mientras esa página quedaba abierta. Ahora se suprime cualquier GET del actor `dashboard` (las mutaciones POST/PATCH/DELETE se siguen registrando y disparando refresh para el resto).

## [0.8.1] - 2026-09-02

### Added

- Chips de estado con contador en las tarjetas Specs y Tasks del overview. Navegan a la lista completa filtrada (`#/specs?status=pending`) en vez de filtrar la tarjeta truncada, para que el filtro nunca opere sobre un recorte arbitrario. Se omiten los estados sin items.

### Fixed

- El contenedor del toast quedaba parcialmente visible en reposo: `translateY(140%)` sobre una caja de 30px la desplaza 42px, menos de los 54px necesarios para salir con `bottom: 24px`. Ahora usa `opacity` + `visibility`.

## [0.8.0] - 2026-09-02

### Changed

- **Dashboard rediseñado: el detalle de spec/task pasa de modal overlay a páginas navegables.** Rutas por hash, linkeables y compartibles: `#/`, `#/specs`, `#/tasks`, `#/spec/:id`, `#/task/:id`, `#/new/spec`, `#/new/task`. El botón atrás del navegador funciona.
- **Eliminados los scrolls anidados.** El documento es el único contenedor con scroll: se quitaron los `max-height` de `.list` (600px), `.markdown` (400px), `.modal` (90vh), la lista de archivos del worktree (120px) y los payloads de eventos (120px). Sobrevive sólo el dropdown de búsqueda (es un menú) y el scroll horizontal de bloques de código y tablas.
- Breadcrumbs jerárquicos (`feinai / Specs / SPEC-012 / TASK-012-B`) con el crumb actual teñido por el estado real de la entidad.
- Los filtros viven en la URL (`#/tasks?status=pending`); los stats del header linkean a su lista filtrada.
- `prompt()` / `confirm()` nativos reemplazados por un diálogo dentro de la página.

### Added

- Soporte de tablas markdown en el renderer del dashboard (antes se veían como texto crudo con pipes).
- Los IDs en `blocked_by` son links a la task correspondiente.

### Fixed

- `feinai server --down` sólo detiene el servidor registrado de este proyecto, no cualquier proceso en el puerto.
- Lifecycle de specs huérfanas (SPEC-124) y normalización de estados a inglés.

## [0.7.2] - 2026-06-22

### Fixed
- `isPortInUse` / `pidsOnPort` / `portOfPid` usaban `result.exitCode` en vez de `result.status` (API de `child_process.spawnSync`), causando que `findFreePort` nunca detectara puertos ocupados

## [0.7.1] - 2026-06-22

### Fixed
- `feinai --version` reports correct version 0.7.1

## [0.7.0] - 2026-06-22

### Added
- **Project-scoped server port tracking** (`server_state` table in `feinai.db`)
  - `feinai status` now validates & repairs the server record before printing the exact project URL
  - `feinai server` auto-increments from port 8272 when the default is busy
  - `feinai server --down` targets the recorded pid/port for this project
  - Graceful shutdown clears the server record from the DB
- 6 unit tests for server-state DB operations

### Changed
- **Normalized language**: removed all "Claude Code" and provider-specific references across CLI, README, and skill files
- `feinai-implement` skill fully translated from Spanish to English
- `CLAUDE.md` references → `AGENTS.md`, `.claude/ARCHITECTURE.md` → `ARCHITECTURE.md`
- `formatStatus` accepts optional `serverUrl` parameter

## [0.6.3] - 2026-06-11

### Fixed
- `feinai --version` now reports the correct version number
- `feinai edit <TASK-ID> --worktree <path>` no longer throws "provide at least one field to edit" when `--worktree` is the only flag passed

## [0.5.0] - 2026-06-10

### Added
- `feinai git <cmd>` — safe git wrapper subcommand. Passes through to `opengit`, enforcing a worktree-only whitelist (blocks branch, merge, rebase, checkout, etc.)
- `opengit` shipped as a binary alongside `feinai` — `bun install -g feinai` now installs both
- `feinai unblock <TASK-ID> --dep <TASK-ID>` — remove a specific dependency from a task
- `feinai edit --clear-blocked-by` — clear all dependencies from a task
- Live Agents Monitor: working directory, repo name, and `.feinai` path shown per agent card
- Live Agents Monitor: presence indicator — gray dot when idle, green dot with ripple animation when agents are active
- Live Agents Monitor: elapsed time and spec ID per card
- `feinai init` now auto-adds `.feinai/` to `.gitignore` if in a git repo
- Skills: `feinai-implement` — claim one pending task, implement in isolated worktree, run quality gates, push to main

### Changed
- Dashboard is now English-only — removed i18n/language selector
- `feinai-implement` SKILL.md updated to use `feinai git` instead of `opengit` directly
- `package.json`: added `repository`, `homepage`, `bugs` fields

### Skills included
`feinai-sdd` · `feinai-write-spec` · `feinai-write-tasks` · `feinai-dispatch` · `feinai-implement`

---

## [0.4.0] - 2026-06-08

Initial public release. Core CLI with specs, plans, tasks, HTTP dashboard, and SDD skills.

### Features
- `feinai init / status / list / add / show / take / done / fail / block / release / reopen / edit`
- `feinai spec` — spec lifecycle (add, start, done, archive, set-content, edit)
- `feinai plan` — plan revisions per spec
- `feinai server` — HTTP dashboard + REST API + SSE live updates
- Live Agents Monitor — real-time view of in-progress tasks with worktree state
- Atomic `take` — SQL-level concurrency safety for parallel agents
- Append-only events audit log
- Skills: `feinai-sdd`, `feinai-write-spec`, `feinai-write-tasks`, `feinai-dispatch`
