#!/bin/sh
# Docker without Docker Desktop on a Mac: Colima (a small Linux VM running Docker Engine) and the
# docker CLI from Homebrew, started now and at every login. The Docker pack finds Colima's socket
# (~/.colima/default/docker.sock) by itself, and Colima makes itself the docker CLI's context.
#   sh colima.sh           set it up (again: it's safe to run twice)
#   sh colima.sh --remove  stop it and delete the VM with its images, containers and volumes;
#                                  uninstalls colima, keeps the docker CLI (other engines use it)
# Linux needs none of this: Docker Engine is one package (docker.io, docker-ce).
set -eu

[ "$(uname -s)" = Darwin ] || { echo "This is for macOS. On Linux, install Docker Engine (docker.io or docker-ce)." >&2; exit 1; }
command -v brew >/dev/null || { echo "Homebrew is needed first: https://brew.sh" >&2; exit 1; }

if [ "${1:-}" = --remove ]; then
  if command -v colima >/dev/null; then
    brew services stop colima >/dev/null 2>&1 || true
    colima stop >/dev/null 2>&1 || true
    colima delete --force >/dev/null 2>&1 || true
    brew uninstall colima
    echo "Removed Colima and its VM, with its images, containers and volumes."
  else
    echo "Colima isn't installed; nothing to remove."
  fi
  exit 0
fi
[ -z "${1:-}" ] || { echo "usage: sh colima.sh [--remove]" >&2; exit 2; }

missing=""
command -v colima >/dev/null || missing=" colima"
command -v docker >/dev/null || missing="$missing docker"
if [ -n "$missing" ]; then
  echo "Installing$missing with Homebrew..."
  # shellcheck disable=SC2086 # one word per formula
  brew install $missing
fi

# brew services runs `colima start` now and at every login (a LaunchAgent for this user, no admin).
echo "Starting Colima (the first start downloads its VM image, a minute or two)..."
brew services start colima >/dev/null

i=0
until docker --context colima info >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -le 120 ] || { echo "Colima didn't answer within 4 minutes. See: colima status, or ~/.colima/default/*.log" >&2; exit 1; }
  sleep 2
done
echo "Docker Engine $(docker --context colima version --format '{{.Server.Version}}' 2>/dev/null) is up on Colima, and starts at login. Dovre's /docker finds it by itself."
