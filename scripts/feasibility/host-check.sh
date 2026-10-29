#!/usr/bin/env bash
# Read-only inventory. Does not establish approval, isolation, or compatibility.
set -u
export LC_ALL=C

if [ "$#" -gt 3 ]; then
  printf 'Usage: bash host-check.sh [install-directory [data-directory [workspace-directory]]]\n' >&2
  exit 2
fi

section() { printf '\n[%s]\n' "$1"; }
version() {
  if command -v "$1" >/dev/null 2>&1; then
    "$1" --version 2>&1 | head -n 2
  else
    printf '%s: unavailable\n' "$1"
  fi
}

printf 'T3 minimal feasibility inventory v1\n'
printf 'No Codex credential/config inspection, downloads, model requests, file writes, or setting changes.\n'
printf 'Review output before sharing. Local executable wrappers may have their own behavior.\n'
section platform
uname -srm
if [ -r /etc/os-release ]; then
  sed -n '/^ID=/p; /^VERSION_ID=/p; /^PRETTY_NAME=/p' /etc/os-release
fi
if command -v getconf >/dev/null 2>&1; then
  getconf GNU_LIBC_VERSION 2>/dev/null || true
fi
section 'installed package versions (no package-manager transactions)'
if command -v rpm >/dev/null 2>&1; then
  rpm -q glibc libstdc++ libatomic ca-certificates git bash firefox chromium google-chrome-stable 2>&1 || true
else
  printf 'rpm: unavailable (RPM package inventory skipped)\n'
fi
section 'existing executable versions'
for executable in node bun codex git; do version "$executable"; done
section 'existing Docker daemon (local Unix socket only; no containers started)'
if command -v docker >/dev/null 2>&1; then
  # A configured remote context is not permission to contact another machine.
  docker_endpoint=${DOCKER_HOST:-}
  if [ -n "${DOCKER_CONTEXT:-}" ] || [ -z "$docker_endpoint" ]; then
    docker_endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null) || docker_endpoint=
  fi
  case "$docker_endpoint" in
    unix://*)
      docker version --format 'client={{.Client.Version}} server={{if .Server}}{{.Server.Version}} os={{.Server.Os}} arch={{.Server.Arch}}{{end}}' 2>/dev/null || printf 'daemon_version=unavailable\n'
      docker info --format 'os_type={{.OSType}} architecture={{.Architecture}} kernel={{.KernelVersion}} storage_driver={{.Driver}} cgroup_version={{.CgroupVersion}} security_options={{json .SecurityOptions}}' 2>/dev/null || printf 'daemon_info=unavailable\n'
      ;;
    *) printf 'daemon_query=skipped (endpoint is not a confirmed local Unix socket)\n' ;;
  esac
else
  printf 'docker: unavailable\n'
fi
section 'CPU instruction flags (selected only)'
if [ -r /proc/cpuinfo ]; then
  awk '/^(flags|Features)[[:space:]]*:/ {
    for (i=3; i<=NF; i++)
      if ($i ~ /^(sse4_2|avx|avx2|bmi1|bmi2|asimd|atomics|crc32)$/) printf "%s ", $i;
    print ""; exit
  }' /proc/cpuinfo
else
  printf 'unavailable\n'
fi

directory_check() {
  label=$1
  directory=$2
  section "$label directory (path omitted)"
  if [ ! -d "$directory" ]; then
    printf 'directory_exists=no; choose an existing intended parent directory\n'
    return
  fi
  for permission in r w x; do
    case "$permission" in
      r) if [ -r "$directory" ]; then result=yes; else result=no; fi ;;
      w) if [ -w "$directory" ]; then result=yes; else result=no; fi ;;
      x) if [ -x "$directory" ]; then result=yes; else result=no; fi ;;
    esac
    printf '%s_access=%s\n' "$permission" "$result"
  done
  df -Pk "$directory" 2>/dev/null | awk 'NR==2 {print "filesystem_available_KiB=" $4}'
  if command -v findmnt >/dev/null 2>&1; then
    printf 'mount_options='
    # Filesystem options may contain credentials or network addresses.
    findmnt -n -o OPTIONS -T "$directory" 2>/dev/null | awk '
      BEGIN { FS=","; separator="" }
      {
        for (i=1; i<=NF; i++) {
          option=$i
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", option)
          if (option ~ /^(rw|ro|exec|noexec|suid|nosuid|dev|nodev)$/) {
            printf "%s%s", separator, option
            separator=","
          }
        }
      }
      END { if (separator == "") printf "unknown"; print "" }
    '
  else
    printf 'mount_options=unknown\n'
  fi
}
directory_check install "${1:-.}"
directory_check data "${2:-.}"
directory_check workspace "${3:-.}"
section 'process limits'
printf 'open_files_limit='; ulimit -n
section 'remaining deployment evidence'
printf '%s\n' \
  'Confirm OS maintenance status, runtime support, and artifact requirements.' \
  'Confirm Docker/Compose availability, engine support, image-load policy, and daemon locality.' \
  'The packaged workflow runs the existing Codex installation on the host with its current controls.' \
  'Confirm the browser version, browser/server host topology, and loopback reachability.' \
  'Confirm approved means of denying wrapper/browser outbound traffic separately from Codex.' \
  'Confirm filesystem quota/free space, executable policy, and all authorized workspace roots.' \
  'This inventory does not run app-server, inspect Codex credentials/configuration, bind a port, or test egress.' \
  'Directory x_access means traversal only; it does not prove executable launch permission.'
