# Toolchain for Dovre's sandbox runs: built on dovre-sandbox, cached until this file changes.
FROM dovre-sandbox
USER root
# pnpm at core's pinned version. /dovre is where `link:../dovre` points from /work; the agent
# copies the read-only sibling /siblings/dovre there and installs it (see CONTRIBUTING.md).
RUN corepack disable pnpm && npm install -g pnpm@12.11.2 && pnpm --version \
 && mkdir /dovre && chown agent:agent /dovre
USER agent
