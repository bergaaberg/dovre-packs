# docker

## 2.0.0 — 2026-11-09

- Core's Docker pack moves here and replaces the `docker ps` one (dovre: Docker out of core). It talks to Docker Engine's API directly: containers by compose project, start, stop, restart and remove (behind a Confirm), a project's containers at once, and a container's logs as they come (never kept). On Windows it uses berth's pipe and switches berth on and off, or Docker Desktop's; on macOS and Linux it finds the socket itself (`DOCKER_PIPE` overrides). Writes `docker.engine-off` and `docker.remove`. No `docker` CLI needed. `colima.sh` sets up Colima on a Mac.

## 1.0.0 — 2026-11-02

- First versioned release: the pack as it was when packs got their own versions.
