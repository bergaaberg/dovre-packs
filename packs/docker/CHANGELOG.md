# docker

## 2.0.3 — 2026-11-09

- Logs its writes with `ctx.logged`, not core's `logAction`. Three names in the actions log change, since a kind is now one word: `docker.engine.on` / `.off` are `docker.engine-on` / `-off`, and `docker.project.<verb>` is `docker.project-<verb>`. Needs core API 1.25.

## 2.0.2 — 2026-11-09

- Imports core through its SDK, `dovre/pack.ts`, in place of core's own files. Needs core API 1.24.

## 2.0.1 — 2026-11-09

- The old `…Crate` export alias is gone: import the `…Pack` name.

## 2.0.0 — 2026-11-09

- Core's Docker pack moves here and replaces the `docker ps` one (dovre: Docker out of core). It talks to Docker Engine's API directly: containers by compose project, start, stop, restart and remove (behind a Confirm), a project's containers at once, and a container's logs as they come (never kept). On Windows it uses berth's pipe and switches berth on and off, or Docker Desktop's; on macOS and Linux it finds the socket itself (`DOCKER_PIPE` overrides). Writes `docker.engine-off` and `docker.remove`. No `docker` CLI needed. `colima.sh` sets up Colima on a Mac.

## 1.0.0 — 2026-11-02

- First versioned release: the pack as it was when packs got their own versions.
