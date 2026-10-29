#!/usr/bin/env bash
set -euo pipefail
project_root=$(cd "$(dirname "$0")/../.." && pwd)
output=${1:-"$project_root/minimal/audit/output/$(date -u +%Y%m%dT%H%M%SZ)"}
mkdir -p "$output"
output=$(cd "$output" && pwd)
if [ -n "$(ls -A "$output")" ]; then
  printf 'Choose a new empty evidence directory; prior results are preserved.\n' >&2
  exit 2
fi
docker build -f "$project_root/minimal/audit/Dockerfile" -t t3code-local-audit "$project_root/minimal/audit"
docker image inspect t3code-local-audit --format '{"id":"{{.Id}}","os":"{{.Os}}","arch":"{{.Architecture}}"}' > "$output/image.json"
docker run --rm --network none --read-only --user "$(id -u):$(id -g)" \
  --cap-drop ALL --security-opt no-new-privileges --entrypoint dpkg-query \
  t3code-local-audit -W '-f=${binary:Package}=${Version}\n' strace chromium > "$output/tools.txt"
docker run --rm --network none --read-only --user "$(id -u):$(id -g)" \
  --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m \
  --mount "type=bind,src=$project_root,dst=/app,readonly" \
  --mount "type=bind,src=$output,dst=/audit-output" \
  t3code-local-audit -ff -ttt -s 256 -e trace=network,process \
  -e raw=sendto,sendmsg,sendmmsg,recvfrom,recvmsg,recvmmsg \
  -o /audit-output/trace node /app/minimal/audit/exercise.mjs
node "$project_root/minimal/audit/summarize.mjs" "$output"
printf 'Evidence: %s\n' "$output"
