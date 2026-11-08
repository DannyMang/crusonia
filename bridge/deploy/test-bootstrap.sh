#!/usr/bin/env bash
# Validates the first-boot script from aws.sh locally, without AWS: runs the exact bootstrap_body in a privileged
# ubuntu:24.04 container (Docker in Docker; systemctl is a shim that starts dockerd), then prints the bridge's health
# and the env file's permissions. /var/lib/docker is a volume so the inner dockerd is not overlay-on-overlay.
#
#   GIT_REF=<pushed sha> CREDS_FILE=<file with SPECTRUM_PROJECT_ID/SECRET> bridge/deploy/test-bootstrap.sh
#
# It connects to Photon with the real project credentials but can never text anyone: OWNER_PHONE is replaced by a
# fictional number (so the owner's messages are ignored), the test message is off, and the bridge polls a URL that
# hands out no notices (WORKER_URL, default the production Worker with a throwaway BRIDGE_SECRET).
# PLATFORM=linux/amd64 matches Lightsail's CPU (emulated on Apple silicon); the default is the host's.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ -r "${CREDS_FILE:-}" ]] || { echo "set CREDS_FILE" >&2; exit 1; }
work="$(mktemp -d)"
chmod 700 "$work"
cleanup() { docker rm -f crusonia-bootstrap-test >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

(umask 077
  grep -E '^(SPECTRUM_PROJECT_ID|SPECTRUM_PROJECT_SECRET)=' "$CREDS_FILE" > "$work/creds.env"
  echo 'OWNER_PHONE=+15550001111' >> "$work/creds.env"
  printf 'BRIDGE_SECRET=%s\n' "$(openssl rand -hex 32)" > "$work/secret.env")

export CREDS_FILE="$work/creds.env" BRIDGE_SECRET_FILE="$work/secret.env" SEND_TEST_MESSAGE=0
export WORKER_URL="${TEST_WORKER_URL:-https://crusonia.veri-web.workers.dev}"
AWS_SH_LIB=1 source "$here/aws.sh"
check_inputs
(umask 077; { echo '#!/bin/bash'; bootstrap_body; } > "$work/bootstrap.sh")

cat > "$work/systemctl" <<'EOF'
#!/bin/sh
# Test shim: `systemctl enable --now docker` starts dockerd in the background; everything else is a no-op.
if [ "$*" = "enable --now docker" ]; then
  # cgroup v2 nesting, as in the docker:dind entrypoint (a real box runs systemd and needs none of this).
  if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    mkdir -p /sys/fs/cgroup/init
    xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || :
    sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || :
  fi
  dockerd >/var/log/dockerd.log 2>&1 &
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done
  echo "dockerd did not start" >&2; exit 1
fi
exit 0
EOF
chmod 755 "$work/systemctl"

platform=()
[[ -n "${PLATFORM:-}" ]] && platform=(--platform "$PLATFORM")
docker run --rm --privileged --cgroupns=private --name crusonia-bootstrap-test ${platform[@]+"${platform[@]}"} -v "$work:/test:ro" -v /var/lib/docker ubuntu:24.04 bash -c '
  install -m 755 /test/systemctl /usr/local/bin/systemctl
  # Like a real first boot: no HOME (cloud-init) and umask 077 from the launch script.
  (umask 077; env -u HOME -u USER bash /test/bootstrap.sh); status=$?
  echo "--- bootstrap exit: $status"
  echo "--- env file: $(stat -c "%a %U:%G" /opt/crusonia-bridge/bridge.env 2>/dev/null); dir: $(stat -c "%a %U:%G" /opt/crusonia-bridge); code: $(stat -c "%a" /opt/crusonia-bridge/repo/bridge/src/index.ts)"
  echo "--- container: $(docker inspect -f "{{.State.Status}} restarts={{.RestartCount}} readonly={{.HostConfig.ReadonlyRootfs}}" crusonia-bridge 2>/dev/null)"
  echo "--- health: $(docker exec crusonia-bridge bun src/cli.ts health 2>&1 | sed "s/^200 //" | head -c 600)"
  echo "--- last log lines:"; docker logs --tail 5 crusonia-bridge 2>&1 | sed -E "s/\+[0-9]{8,}/+***/g"
  exit $status'
