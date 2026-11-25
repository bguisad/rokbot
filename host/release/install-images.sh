#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

readonly COMPOSE_FILE="docker-compose.images.yml"
# Optional operator overlay, layered after the base file the way Compose itself does by default.
readonly OVERRIDE_FILE="docker-compose.override.yml"
readonly ENV_EXAMPLE=".env.images.example"
readonly ENV_FILE=".env"

usage() {
  cat <<'EOF'
Usage: bash install-images.sh [OPTIONS]

Download RokBot prebuilt-image Compose files, initialize .env secrets, and start RokBot.

Options:
  --prepare-only   Prepare Compose files and .env, validate config, and exit without starting containers
  --local          Use existing local files in the current directory or beside install-images.sh when present
  --pull-never     Skip docker compose pull and pass --pull never to docker compose up
  --offline        Implies --local and --pull-never; never use curl or pull images
  -h, --help       Show this help message and exit

Environment overrides:
  ROKBOT_DOWNLOAD_BASE            Base URL (https://... or file://...) for Compose/env template files
  ROKBOT_RELEASE_REF              Git branch/tag used in default GitHub raw URL (default: main)
  ROKBOT_DOWNLOAD_SKIP_EXISTING   Set to 1 to behave like --local
  ROKBOT_PULL_NEVER               Set to 1 to behave like --pull-never
EOF
}

prepare_only=false
skip_existing=false
pull_never=false
offline=false
if [[ "${ROKBOT_DOWNLOAD_SKIP_EXISTING:-}" == "1" ]]; then
  skip_existing=true
fi
if [[ "${ROKBOT_PULL_NEVER:-}" == "1" ]]; then
  pull_never=true
fi

for arg in "$@"; do
  case "$arg" in
    --prepare-only)
      prepare_only=true
      ;;
    --local)
      skip_existing=true
      ;;
    --pull-never)
      pull_never=true
      ;;
    --offline)
      # Air-gap bootstrap: keep local Compose/env files and do not pull images.
      skip_existing=true
      pull_never=true
      offline=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

download_ref="${ROKBOT_RELEASE_REF:-main}"
DOWNLOAD_BASE="${ROKBOT_DOWNLOAD_BASE:-https://raw.githubusercontent.com/hongfaqiu/rokbot/${download_ref}/host/release}"
while [[ "$DOWNLOAD_BASE" == */ ]]; do
  DOWNLOAD_BASE="${DOWNLOAD_BASE%/}"
done
case "$DOWNLOAD_BASE" in
  https://*|file://*) ;;
  *)
    echo "RokBot setup failed: ROKBOT_DOWNLOAD_BASE must use https:// or file://." >&2
    exit 1
    ;;
esac
readonly DOWNLOAD_BASE

temporary_file=""
cleanup() {
  if [[ -n "$temporary_file" ]]; then
    rm -f -- "$temporary_file"
  fi
}
trap cleanup EXIT

fail() {
  echo "RokBot setup failed: $*" >&2
  exit 1
}

ensure_curl() {
  command -v curl >/dev/null 2>&1 || fail "'curl' is required."
}

ensure_openssl() {
  command -v openssl >/dev/null 2>&1 || fail "'openssl' is required."
}

required_files=("$COMPOSE_FILE" "$ENV_EXAMPLE")
if [[ "$offline" == true ]]; then
  for filename in "${required_files[@]}"; do
    if [[ ! -f "$filename" && ( "$SCRIPT_DIR" == "$PWD" || ! -f "${SCRIPT_DIR}/${filename}" ) ]]; then
      fail "--offline requires local ${filename}; copy it into the working directory first."
    fi
  done
elif [[ "$skip_existing" == false ]]; then
  ensure_curl
fi

command -v docker >/dev/null 2>&1 || fail "'docker' is required."
docker compose version >/dev/null 2>&1 || fail "the Docker Compose plugin is required."

# Strip CRLF, inline # comments outside quotes, and matching outer quotes safely in Bash 3.2+.
strip_env_line_comments_and_quotes() {
  local raw_line="$1"
  local i c quote="" out=""
  raw_line="${raw_line%$'\r'}"
  for ((i = 0; i < ${#raw_line}; i++)); do
    c="${raw_line:i:1}"
    if [[ -n "$quote" ]]; then
      if [[ "$quote" == '"' && "$c" == '\' ]] && ((i + 1 < ${#raw_line})); then
        out+="$c"
        i=$((i + 1))
        out+="${raw_line:i:1}"
        continue
      fi
      out+="$c"
      [[ "$c" == "$quote" ]] && quote=""
    elif [[ "$c" == "'" || "$c" == '"' ]]; then
      quote="$c"
      out+="$c"
    elif [[ "$c" == "#" ]]; then
      break
    else
      out+="$c"
    fi
  done
  printf '%s' "$out"
}

unquote_env_value() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if (( ${#value} >= 2 )) && [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
    value="${value:1:${#value}-2}"
    value="${value//\\\"/\"}"
    value="${value//\\\\/\\}"
  elif (( ${#value} >= 2 )) && [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

# Optional proxy knobs from an existing .env (operators often set them there for
# containers). Do not override values already present in the shell. Treat each
# HTTP/HTTPS/NO_PROXY pair as one family so either case in the shell wins.
# Within .env, later assignments for a family win (shell presence is snapshotted
# before the file is read). Comment stripping is quote-aware so `#` inside
# matching quotes is kept; this is not a full dotenv parser.
load_proxy_vars_from_env_file() {
  local file="$1"
  local line key value
  local shell_http=0 shell_https=0 shell_no=0
  [[ -f "$file" ]] || return 0
  [[ -n "${HTTP_PROXY+x}" || -n "${http_proxy+x}" ]] && shell_http=1
  [[ -n "${HTTPS_PROXY+x}" || -n "${https_proxy+x}" ]] && shell_https=1
  [[ -n "${NO_PROXY+x}" || -n "${no_proxy+x}" ]] && shell_no=1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=$(strip_env_line_comments_and_quotes "$line")
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?(HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    key="${BASH_REMATCH[2]}"
    value=$(unquote_env_value "${BASH_REMATCH[3]}")
    local trimmed_proxy="$value"
    trimmed_proxy="${trimmed_proxy#"${trimmed_proxy%%[![:space:]]*}"}"
    [[ -n "$trimmed_proxy" ]] || value=""
    case "$key" in
      HTTP_PROXY|http_proxy)
        if ((shell_http)); then
          continue
        fi
        unset -v HTTP_PROXY http_proxy
        ;;
      HTTPS_PROXY|https_proxy)
        if ((shell_https)); then
          continue
        fi
        unset -v HTTPS_PROXY https_proxy
        ;;
      NO_PROXY|no_proxy)
        if ((shell_no)); then
          continue
        fi
        unset -v NO_PROXY no_proxy
        ;;
    esac
    export "${key}=${value}"
  done <"$file"
}

# curl uses lowercase http_proxy for http:// URLs; many Mainland hosts only export HTTP_PROXY.
sync_curl_proxy_env() {
  if [[ -n "${HTTP_PROXY+x}" && -z "${http_proxy+x}" ]]; then
    export http_proxy="$HTTP_PROXY"
  fi
  if [[ -n "${HTTPS_PROXY+x}" && -z "${https_proxy+x}" ]]; then
    export https_proxy="$HTTPS_PROXY"
  fi
  if [[ -n "${NO_PROXY+x}" && -z "${no_proxy+x}" ]]; then
    export no_proxy="$NO_PROXY"
  fi
}

prepare_proxy_env() {
  load_proxy_vars_from_env_file "$ENV_FILE"
  sync_curl_proxy_env
}
prepare_proxy_env

get_env_value_from_file() {
  local file="$1"
  local target_key="$2"
  local line value found=""
  [[ -f "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=$(strip_env_line_comments_and_quotes "$line")
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      if [[ "${BASH_REMATCH[2]}" == "$target_key" ]]; then
        value=$(unquote_env_value "${BASH_REMATCH[3]}")
        found="$value"
      fi
    fi
  done <"$file"
  printf '%s' "$found"
}

has_nonempty_env_key() {
  local file="$1"
  local target_key="$2"
  local line value last_nonempty=1
  [[ -f "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=$(strip_env_line_comments_and_quotes "$line")
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      if [[ "${BASH_REMATCH[2]}" == "$target_key" ]]; then
        value=$(unquote_env_value "${BASH_REMATCH[3]}")
        value="${value#"${value%%[![:space:]]*}"}"
        value="${value%"${value##*[![:space:]]}"}"
        if [[ -n "$value" ]]; then
          last_nonempty=0
        else
          last_nonempty=1
        fi
      fi
    fi
  done <"$file"
  return "$last_nonempty"
}

curl_download() {
  local url="$1"
  local out="$2"
  local attempt
  local max_attempts=3

  if [[ "$url" == file://* ]]; then
    curl -fsSL "$url" -o "$out"
    return $?
  fi

  if curl --help all 2>/dev/null | grep -q -- '--retry-all-errors'; then
    curl -fsSL --proto-redir =https --retry 3 --retry-delay 2 --retry-all-errors "$url" -o "$out"
    return $?
  fi

  attempt=1
  while [[ "$attempt" -le "$max_attempts" ]]; do
    if curl -fsSL --proto-redir =https "$url" -o "$out"; then
      return 0
    fi
    if [[ "$attempt" -eq "$max_attempts" ]]; then
      return 1
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  return 1
}

download() {
  local filename="$1"
  local url="${DOWNLOAD_BASE}/${filename}"

  if [[ "$skip_existing" == true ]]; then
    if [[ -e "$filename" ]]; then
      echo "Using local ${filename}"
      return 0
    fi
    if [[ "$SCRIPT_DIR" != "$PWD" && -f "${SCRIPT_DIR}/${filename}" ]]; then
      temporary_file=$(mktemp "./${filename}.tmp.XXXXXX")
      cp -- "${SCRIPT_DIR}/${filename}" "$temporary_file"
      chmod 644 "$temporary_file"
      mv -- "$temporary_file" "$filename"
      temporary_file=""
      echo "Copied local ${filename} from ${SCRIPT_DIR}"
      return 0
    fi
  fi
  if [[ "$offline" == true ]]; then
    fail "--offline cannot download missing ${filename}; copy it into the working directory first."
  fi

  ensure_curl
  temporary_file=$(mktemp "./${filename}.tmp.XXXXXX")
  if ! curl_download "$url" "$temporary_file"; then
    fail "could not download ${filename} from ${url}. Set HTTP_PROXY/HTTPS_PROXY in the shell or .env (NO_PROXY for localhost), or pre-place the file and use --local / --offline."
  fi
  chmod 644 "$temporary_file"
  mv -- "$temporary_file" "$filename"
  temporary_file=""
}

create_env() {
  local line stripped key raw_val trimmed_val has_box_token=0
  umask 077
  temporary_file=$(mktemp "./${ENV_FILE}.tmp.XXXXXX")

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    stripped=$(strip_env_line_comments_and_quotes "$line")
    if [[ "$stripped" =~ ^[[:space:]]*(export[[:space:]]+)?(ROKBOT_BOX_TOKEN)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      raw_val=$(unquote_env_value "${BASH_REMATCH[3]}")
      trimmed_val="${raw_val#"${raw_val%%[![:space:]]*}"}"
      trimmed_val="${trimmed_val%"${trimmed_val##*[![:space:]]}"}"
      has_box_token=1
      if [[ -n "$trimmed_val" ]]; then
        printf '%s\n' "$line"
      else
        printf 'ROKBOT_BOX_TOKEN=local\n'
      fi
    elif [[ "$stripped" =~ ^[[:space:]]*(export[[:space:]]+)?(ROKBOT_[A-Za-z0-9_]*_SECRET)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      key="${BASH_REMATCH[2]}"
      raw_val=$(unquote_env_value "${BASH_REMATCH[3]}")
      trimmed_val="${raw_val#"${raw_val%%[![:space:]]*}"}"
      trimmed_val="${trimmed_val%"${trimmed_val##*[![:space:]]}"}"
      if [[ -n "$trimmed_val" ]]; then
        printf '%s\n' "$line"
      else
        ensure_openssl
        printf '%s=%s\n' "$key" "$(openssl rand -hex 24)"
      fi
    else
      printf '%s\n' "$line"
    fi
  done < "$ENV_EXAMPLE" > "$temporary_file"

  if (( ! has_box_token )); then
    printf 'ROKBOT_BOX_TOKEN=local\n' >> "$temporary_file"
  fi

  chmod 600 "$temporary_file"
  mv -- "$temporary_file" "$ENV_FILE"
  temporary_file=""
  echo "Created .env (mode 0600)."
}

append_missing_env_line() {
  local key="$1"
  local value="$2"
  [[ ! -s "$ENV_FILE" || -z "$(tail -c 1 "$ENV_FILE")" ]] || printf '\n' >> "$ENV_FILE"
  printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  echo "Added ${key} to .env."
}

# Required tokens or *_SECRET placeholders left empty/missing in an existing .env.
# Append them so existing lines/comments stay untouched, re-runs remain idempotent,
# and .env permissions are tightened to 0600.
add_missing_secrets() {
  local line key secret_keys="" seen_keys=" "
  chmod 600 "$ENV_FILE"
  if ! has_nonempty_env_key "$ENV_FILE" "ROKBOT_BOX_TOKEN"; then
    append_missing_env_line "ROKBOT_BOX_TOKEN" "local"
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=$(strip_env_line_comments_and_quotes "$line")
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?(ROKBOT_[A-Za-z0-9_]*_SECRET)[[:space:]]*= ]]; then
      key="${BASH_REMATCH[2]}"
      if [[ "$seen_keys" != *" ${key} "* ]]; then
        seen_keys+="${key} "
        secret_keys+="${key}"$'\n'
      fi
    fi
  done < "$ENV_FILE"
  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    if ! has_nonempty_env_key "$ENV_FILE" "$key"; then
      ensure_openssl
      append_missing_env_line "$key" "$(openssl rand -hex 24)"
    fi
  done <<< "$secret_keys"
}

validate_required_secrets() {
  if ! docker compose --env-file "$ENV_FILE" "${compose_files[@]}" -f - config --environment <<'YAML' | awk '
    BEGIN {
      required["ROKBOT_BOX_TOKEN"] = 1
      sq = sprintf("%c", 39)
    }
    {
      line = $0
      sub(/^[[:space:]]*(export[[:space:]]+)?/, "", line)
      if (line !~ /^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/) next
      name = line
      sub(/[[:space:]]*=.*/, "", name)
      if (!(name in required)) next
      seen[name]++

      value = line
      sub(/^[^=]*=[[:space:]]*/, "", value)
      if (length(value) >= 2) {
        first = substr(value, 1, 1)
        last = substr(value, length(value), 1)
        if ((first == "\"" && last == "\"") || (first == sq && last == sq)) {
          value = substr(value, 2, length(value) - 2)
        }
      }
      gsub(/[[:space:]]/, "", value)
      last_nonempty[name] = (value != "" ? 1 : 0)
    }
    END {
      for (name in required) {
        if (seen[name] < 1 || last_nonempty[name] != 1) exit 1
      }
    }
  '
services:
  host:
    environment:
      _ROKBOT_VALIDATE_BOX_TOKEN: ${ROKBOT_BOX_TOKEN:?Set ROKBOT_BOX_TOKEN in .env}
YAML
  then
    fail "set every required secret in .env to a non-empty value."
  fi
}

# Warn when .env contains keys not referenced by the Compose file (excluding COMPOSE_* and
# operator/CLI credentials consumed by host-admin.mjs rather than container env).
warn_unpassed_settings() {
  local key unpassed=""
  while IFS= read -r key; do
    case "$key" in
      COMPOSE_*|ROKBOT_ADMIN_PASSWORD|ROKBOT_SETUP_KEY)
        continue
        ;;
    esac
    grep -qw -e "$key" "$COMPOSE_FILE" ${override_present:+"$OVERRIDE_FILE"} || unpassed+=" $key"
  done < <(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' "$ENV_FILE" | sort -u)
  [[ -n "$unpassed" ]] || return 0
  echo "Warning: no container receives these .env settings:${unpassed}." >&2
  echo "Add them to ${OVERRIDE_FILE} if you want containers to receive them." >&2
}

remove_replaced_images() {
  local ref repo id tag repos=" "
  while IFS= read -r ref; do
    repo="${ref%@*}"
    [[ "${repo##*/}" != *:* ]] || repo="${repo%:*}"
    repo="${repo#docker.io/}"
    repos+="${repo#library/} "
  done < <(docker compose --env-file "$ENV_FILE" "${compose_files[@]}" config --images 2>/dev/null)
  [[ "$repos" != " " ]] || return 0
  while read -r id repo tag; do
    [[ "$tag" == "<none>" && "$repos" == *" ${repo} "* ]] || continue
    docker image rm "$id" >/dev/null 2>&1 || true
  done < <(docker image ls --no-trunc --format '{{.ID}} {{.Repository}} {{.Tag}}' 2>/dev/null)
}

for filename in "${required_files[@]}"; do
  download "$filename"
done

compose_files=(-f "$COMPOSE_FILE")
override_present=""
if [[ -f "$OVERRIDE_FILE" ]]; then
  compose_files+=(-f "$OVERRIDE_FILE")
  override_present=1
  echo "Using ${OVERRIDE_FILE}."
fi

if [[ -e "$ENV_FILE" ]]; then
  echo "Keeping existing .env."
  add_missing_secrets
else
  create_env
fi

validate_required_secrets
docker compose --env-file "$ENV_FILE" "${compose_files[@]}" config --quiet || fail "docker compose configuration validation failed."
warn_unpassed_settings

if [[ "$prepare_only" == true ]]; then
  echo "RokBot files are ready. Edit .env, then run: bash install-images.sh"
  exit 0
fi

prepare_proxy_env
if [[ "$pull_never" == true ]]; then
  echo "Skipping image pull (--pull-never / --offline); images must already be on this Docker host."
else
  if ! docker compose --env-file "$ENV_FILE" "${compose_files[@]}" pull; then
    fail "could not pull images. Shell HTTP_PROXY often does not reach the Docker daemon. Configure daemon proxy/registry-mirrors, override ROKBOT_HOST_IMAGE / ROKBOT_BOX_IMAGE in .env to a reachable mirror, or preload images then compose up with --pull never."
  fi
fi

# `--wait` without `--wait-timeout` can hang on older Compose or stay silent on slow boots.
compose_up_help=$(docker compose up --help 2>/dev/null || true)
up_pull_args=()
if [[ "$pull_never" == true ]]; then
  if grep -q -- '--pull' <<<"$compose_up_help"; then
    up_pull_args=(--pull never)
  else
    echo "cannot enforce pull-never on this Compose version; startup fails if an image is missing locally" >&2
  fi
fi
# bash 3.2 + set -u: "${arr[@]}" aborts when arr is empty.
if grep -q -- '--wait-timeout' <<<"$compose_up_help"; then
  echo "Waiting for healthy services."
  docker compose --env-file "$ENV_FILE" "${compose_files[@]}" up -d ${up_pull_args[@]+"${up_pull_args[@]}"} --wait --wait-timeout 300
else
  docker compose --env-file "$ENV_FILE" "${compose_files[@]}" up -d ${up_pull_args[@]+"${up_pull_args[@]}"}
fi
remove_replaced_images

public_url="${ROKBOT_PUBLIC_URL:-$(get_env_value_from_file "$ENV_FILE" "ROKBOT_PUBLIC_URL" || true)}"
listen_addr="${ROKBOT_LISTEN_ADDRESS:-$(get_env_value_from_file "$ENV_FILE" "ROKBOT_LISTEN_ADDRESS" || true)}"
if [[ -z "$listen_addr" ]]; then
  listen_addr="${ROKBOT_BIND:-$(get_env_value_from_file "$ENV_FILE" "ROKBOT_BIND" || true)}"
fi
listen_addr="${listen_addr:-127.0.0.1}"
case "$listen_addr" in
  0.0.0.0|::|"[::]")
    display_host="127.0.0.1"
    ;;
  *)
    display_host="$listen_addr"
    ;;
esac
public_port="${ROKBOT_PUBLIC_PORT:-$(get_env_value_from_file "$ENV_FILE" "ROKBOT_PUBLIC_PORT" || true)}"
if [[ -z "$public_port" ]]; then
  public_port="${ROKBOT_PORT:-$(get_env_value_from_file "$ENV_FILE" "ROKBOT_PORT" || true)}"
fi
public_port="${public_port:-18080}"
if [[ "$display_host" == *:* && "$display_host" != \[*\] ]]; then
  display_host="[${display_host}]"
fi
local_url="http://${display_host}:${public_port}"
access_url="${public_url:-$local_url}"
access_url="${access_url%/}"
web_public_url="${ROKBOT_WEB_PUBLIC_URL:-$(get_env_value_from_file "$ENV_FILE" "ROKBOT_WEB_PUBLIC_URL" || true)}"
web_port="${ROKBOT_WEB_PUBLIC_PORT:-$(get_env_value_from_file "$ENV_FILE" "ROKBOT_WEB_PUBLIC_PORT" || true)}"
web_port="${web_port:-18081}"
web_access_url="${web_public_url:-http://${display_host}:${web_port}}"
web_access_url="${web_access_url%/}/web/"

echo ""
echo "RokBot is running."
echo "  Local URL:        ${local_url}"
if [[ -n "$public_url" ]]; then
  echo "  Public URL:       ${access_url}"
fi
echo "  Admin Console:    ${access_url}/admin"
echo "  Web Client:       ${web_access_url}"
echo "  Env Config:       ${PWD}/${ENV_FILE} (mode 0600: ports, image tags, proxy settings, ROKBOT_BOX_TOKEN; optional CLI vars)"
echo ""
echo "First-time onboarding:"
echo "  1. Retrieve the one-time setup key from the running Host container:"
echo "     docker compose --env-file .env -f ${COMPOSE_FILE} exec -T host cat /data/setup-key"
echo "  2. Open ${access_url}/admin, enter the setup key, and set your admin password."
echo "  3. Pair your desktop or mobile app at ${access_url}/admin?view=devices (or sign in with your admin password)."
echo "  4. Configure AI models in-app (ROKBOT_ALLOW_DEVICE_MODEL_CONFIG=1) or at ${access_url}/admin?view=model."
echo "  5. Manage 4-platform (Android/iOS/macOS/Windows) auto-updates at ${access_url}/admin?view=updates."
