#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")"

readonly EXPECTED_LAVALINK_VERSION="${LAVALINK_VERSION:-4.2.2}"
readonly LAVALINK_DOWNLOAD_URL="https://github.com/lavalink-devs/Lavalink/releases/download/${EXPECTED_LAVALINK_VERSION}/Lavalink.jar"
readonly LAVALINK_JAR="${LAVALINK_JAR:-lavalink.jar}"
readonly VERSION_MARKER=".lavalink-version"
LAVALINK_PID=""
BOT_PID=""

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

load_dotenv() {
  local file="$1"
  [ -f "$file" ] || return 0

  echo "🔐 Loading environment variables from ${file} (values hidden)"
  while IFS= read -r raw || [ -n "$raw" ]; do
    raw="${raw%$'\r'}"
    local line
    line="$(trim "$raw")"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == export\ * ]] && line="${line#export }"
    [[ "$line" == *=* ]] || continue

    local key value
    key="$(trim "${line%%=*}")"
    value="$(trim "${line#*=}")"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue

    if [[ "$value" == \"*\" && "$value" == *\" ]] ||
       [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi

    if [ -z "${!key+x}" ]; then
      export "$key=$value"
    fi
  done < "$file"
}

load_dotenv ".env"

export LAVALINK_HOST="${LAVALINK_HOST:-127.0.0.1}"
export LAVALINK_PORT="${LAVALINK_PORT:-2333}"
export LAVALINK_SECURE="${LAVALINK_SECURE:-false}"

require_env() {
  local missing=()
  local key
  for key in "$@"; do
    if [ -z "${!key:-}" ]; then
      missing+=("$key")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "❌ Missing required environment variables: ${missing[*]}"
    exit 1
  fi
}

require_env DISCORD_TOKEN MUSIC_TEXT_CHANNEL_ID LAVALINK_PASSWORD

if ! command -v java >/dev/null 2>&1; then
  echo "❌ Java is missing. Lavalink 4 requires Java 17 or newer."
  exit 1
fi

java_major="$(java -version 2>&1 | awk -F'[\".]' '/version/ {print $2; exit}')"
if ! [[ "$java_major" =~ ^[0-9]+$ ]] || [ "$java_major" -lt 17 ]; then
  echo "❌ Java 17 or newer is required; detected: $(java -version 2>&1 | head -n 1)"
  exit 1
fi

echo "☕ $(java -version 2>&1 | head -n 1)"

jar_manifest_version() {
  local jar_path="$1"
  if command -v unzip >/dev/null 2>&1; then
    unzip -p "$jar_path" META-INF/MANIFEST.MF 2>/dev/null |
      awk -F': ' '/^Implementation-Version:/ {gsub(/\r/, "", $2); print $2; exit}'
  fi
}

valid_jar_size() {
  local jar_path="$1"
  [ -f "$jar_path" ] || return 1
  local size
  size="$(wc -c < "$jar_path")"
  [ "$size" -ge 50000000 ]
}

download_lavalink() {
  local temporary="${LAVALINK_JAR}.download"
  rm -f "$temporary"

  echo "⬇️ Downloading official Lavalink ${EXPECTED_LAVALINK_VERSION}..."
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --silent --show-error \
      --connect-timeout 20 --max-time 300 --retry 3 \
      "$LAVALINK_DOWNLOAD_URL" --output "$temporary"
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet --timeout=300 --tries=3 --output-document="$temporary" "$LAVALINK_DOWNLOAD_URL"
  else
    echo "❌ Neither curl nor wget is installed, so Lavalink cannot be downloaded."
    return 1
  fi

  if ! valid_jar_size "$temporary"; then
    echo "❌ Downloaded Lavalink file is missing or unexpectedly small."
    rm -f "$temporary"
    return 1
  fi

  local downloaded_version
  downloaded_version="$(jar_manifest_version "$temporary" || true)"
  if [ -n "$downloaded_version" ] && [ "$downloaded_version" != "$EXPECTED_LAVALINK_VERSION" ]; then
    echo "❌ Expected Lavalink ${EXPECTED_LAVALINK_VERSION}, downloaded ${downloaded_version}."
    rm -f "$temporary"
    return 1
  fi

  mv -f "$temporary" "$LAVALINK_JAR"
  printf '%s\n' "$EXPECTED_LAVALINK_VERSION" > "$VERSION_MARKER"
  echo "✅ Lavalink ${EXPECTED_LAVALINK_VERSION} installed."
}

installed_version="$(jar_manifest_version "$LAVALINK_JAR" || true)"
marker_version="$(cat "$VERSION_MARKER" 2>/dev/null || true)"

if ! valid_jar_size "$LAVALINK_JAR" ||
   { [ "$installed_version" != "$EXPECTED_LAVALINK_VERSION" ] && [ "$marker_version" != "$EXPECTED_LAVALINK_VERSION" ]; }; then
  if ! download_lavalink; then
    echo "❌ Lavalink ${EXPECTED_LAVALINK_VERSION} is required for current Discord voice/DAVE support."
    echo "   Download it from the official Lavalink release and place it at ${LAVALINK_JAR}."
    exit 1
  fi
else
  echo "✅ Lavalink ${installed_version:-$marker_version} is already installed."
fi

if [ ! -f application.yml ]; then
  echo "❌ application.yml is missing from the project root."
  exit 1
fi

wait_for_tcp() {
  local host="$1"
  local port="$2"
  local timeout="${3:-120}"
  local started now
  started="$(date +%s)"
  echo "⏳ Waiting for Lavalink at ${host}:${port}..."

  while true; do
    if (echo > "/dev/tcp/${host}/${port}") >/dev/null 2>&1; then
      echo "✅ Lavalink port is open."
      return 0
    fi
    if [ -n "$LAVALINK_PID" ] && ! kill -0 "$LAVALINK_PID" >/dev/null 2>&1; then
      echo "❌ Lavalink exited before opening its port."
      return 1
    fi
    now="$(date +%s)"
    if [ $((now - started)) -ge "$timeout" ]; then
      echo "❌ Timed out waiting for Lavalink."
      return 1
    fi
    sleep 2
  done
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  echo "🧹 Stopping Stoney Music services..."
  for pid in "$BOT_PID" "$LAVALINK_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  sleep 1
  for pid in "$BOT_PID" "$LAVALINK_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
  done
  exit "$status"
}
trap cleanup EXIT INT TERM

JAVA_OPTS="${JAVA_OPTS:--Xms256M -Xmx900M}"
rm -f lavalink.log

echo "🎧 Starting Lavalink ${EXPECTED_LAVALINK_VERSION}..."
# Process substitution keeps $! attached to Java rather than to tee.
java $JAVA_OPTS -jar "$LAVALINK_JAR" > >(tee -a lavalink.log) 2>&1 &
LAVALINK_PID=$!

if ! wait_for_tcp "127.0.0.1" "$LAVALINK_PORT" "${LAVALINK_WAIT_TIMEOUT:-120}"; then
  tail -n 200 lavalink.log 2>/dev/null || true
  exit 1
fi

echo "🚀 Starting Stoney Music bot..."
node src/index.js &
BOT_PID=$!

set +e
wait -n "$LAVALINK_PID" "$BOT_PID"
status=$?
set -e

if ! kill -0 "$LAVALINK_PID" >/dev/null 2>&1; then
  echo "❌ Lavalink stopped unexpectedly."
  tail -n 200 lavalink.log 2>/dev/null || true
elif ! kill -0 "$BOT_PID" >/dev/null 2>&1; then
  echo "❌ Discord bot stopped unexpectedly."
fi

exit "$status"
