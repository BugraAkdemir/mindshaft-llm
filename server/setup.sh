#!/usr/bin/env bash
# Downloads everything the bundled test server needs: the vanilla Minecraft
# server jar and a Java 21 runtime to run it with.
#
# Neither is in version control — they are large binaries, and the jar is
# Mojang's to distribute. This script fetches them from the official sources and
# verifies the jar's checksum.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

MC_VERSION="1.21.8"
JAR_SHA1="6bce4ef400e4efaa63a13d5e6f6b500be969ef81"
JAR_URL="https://piston-data.mojang.com/v1/objects/${JAR_SHA1}/server.jar"
JRE_URL="https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jre/hotspot/normal/eclipse"

say() { printf '\n==> %s\n' "$1"; }

# ── Server jar ───────────────────────────────────────────────────────────
if [[ -f server.jar ]] && sha1sum server.jar | grep -q "$JAR_SHA1"; then
  say "server.jar already present and verified"
else
  say "Downloading Minecraft ${MC_VERSION} server (~55 MB)"
  curl -fL --progress-bar "$JAR_URL" -o server.jar

  say "Verifying checksum"
  actual="$(sha1sum server.jar | awk '{print $1}')"
  if [[ "$actual" != "$JAR_SHA1" ]]; then
    echo "Checksum mismatch: expected $JAR_SHA1, got $actual" >&2
    rm -f server.jar
    exit 1
  fi
  echo "OK"
fi

# ── Java 21 runtime ──────────────────────────────────────────────────────
# Minecraft 1.21 requires Java 21; the system Java is often older, so a private
# runtime keeps this self-contained.
if [[ -x jre21/bin/java ]]; then
  say "jre21 already present ($(jre21/bin/java -version 2>&1 | head -1))"
else
  say "Downloading a Java 21 runtime (~50 MB)"
  curl -fL --progress-bar "$JRE_URL" -o jre21.tar.gz

  say "Extracting"
  rm -rf jre21 jre-extract && mkdir jre-extract
  tar xzf jre21.tar.gz -C jre-extract
  mv "$(find jre-extract -maxdepth 1 -mindepth 1 -type d | head -1)" jre21
  rm -rf jre-extract jre21.tar.gz
  echo "OK: $(jre21/bin/java -version 2>&1 | head -1)"
fi

# ── EULA ─────────────────────────────────────────────────────────────────
# Mojang requires explicit acceptance. Read it before agreeing:
# https://aka.ms/MinecraftEULA
if [[ ! -f eula.txt ]]; then
  say "Minecraft EULA"
  echo "Running a server requires accepting Mojang's EULA: https://aka.ms/MinecraftEULA"
  read -r -p "Do you accept it? [y/N] " answer
  if [[ "${answer,,}" != "y" ]]; then
    echo "Not accepted. Write 'eula=true' to server/eula.txt yourself when you are ready." >&2
    exit 1
  fi
  echo "eula=true" > eula.txt
fi

say "Done. Start the server with:"
echo "    ./server/start.sh"
echo
echo "To watch the agent from inside the game, op your Minecraft username:"
echo "    echo \"op YOUR_NAME\" > server/console.in"
