#!/usr/bin/env bash
# Starts the bundled vanilla Minecraft server for agent testing.
#
# The server ships with its own Java 21 runtime under server/jre21, because
# modern Minecraft needs Java 21 and the system Java may be older.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

JAVA="$HERE/jre21/bin/java"
if [[ ! -x "$JAVA" ]]; then
  # Fall back to whatever java is on PATH, but warn if it is too old.
  JAVA="$(command -v java || true)"
  if [[ -z "$JAVA" ]]; then
    echo "No Java found. Expected a bundled runtime at server/jre21/bin/java." >&2
    exit 1
  fi
  echo "warning: bundled jre21 missing, using $JAVA (Minecraft 1.21 needs Java 21+)" >&2
fi

MEMORY="${MC_MEMORY:-2G}"

# A FIFO on stdin keeps the console usable: write commands to server/console.in
# (e.g. echo "op someone" > server/console.in) without holding a terminal open.
if [[ "${MC_CONSOLE_FIFO:-1}" == "1" ]]; then
  rm -f console.in
  mkfifo console.in
  # `tail -f` keeps the pipe open across writers so the server never sees EOF.
  tail -f console.in | "$JAVA" -Xmx"$MEMORY" -Xms1G -jar server.jar nogui
else
  exec "$JAVA" -Xmx"$MEMORY" -Xms1G -jar server.jar nogui
fi
