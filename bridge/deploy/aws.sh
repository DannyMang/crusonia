#!/usr/bin/env bash
# Runs the Crusonia iMessage bridge on one AWS Lightsail instance: the $5/month nano_3_0 bundle (512 MB, 2 vCPU,
# 20 GB, public IPv4 included), Ubuntu 24.04, tagged project=crusonia.
#
# No SSH and no open ports, ever. The bridge is outbound-only, so the instance's firewall is closed completely and
# everything happens in a first-boot launch script: install Docker, clone this repo at a pinned commit, build the
# bridge image, run it (--restart always, read-only root filesystem when it works), and optionally send the one test
# message. Changing code or secrets = `recreate` (the bridge keeps no state on the box).
#
#   bridge/deploy/aws.sh plan               read-only: what exists and what `up` would do (default)
#   bridge/deploy/aws.sh up                 create the instance (refuses if it exists), lock it down
#   bridge/deploy/aws.sh recreate           delete the instance, then `up` (rotate secrets, ship a new commit)
#   bridge/deploy/aws.sh status             instance state, open ports, metadata settings
#   bridge/deploy/aws.sh down --yes         delete the instance
#
# Inputs (environment):
#   GIT_REF             commit to run (a full SHA pushed to GitHub); required for up/recreate
#   CREDS_FILE          file with SPECTRUM_PROJECT_ID=, SPECTRUM_PROJECT_SECRET=, OWNER_PHONE= lines
#   BRIDGE_SECRET_FILE  file with a BRIDGE_SECRET= line (the same value goes on the Worker)
#   SEND_TEST_MESSAGE   1 = after the bridge connects, text OWNER_PHONE once: "Crusonia is connected. Reply help for commands."
#   WORKER_URL          default https://crusonia.veri-web.workers.dev
#   AWS_PROFILE / AWS_REGION (default us-east-1), AZ (default us-east-1a), INSTANCE (default crusonia-bridge)
#
# Secrets: only SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, OWNER_PHONE, BRIDGE_SECRET and WORKER_URL reach the box.
# They travel inside the launch script (a mode-600 temp file here, deleted right after the API call), are written to
# a root-only env file (mode 600) that Docker reads, and are never printed. Trade-off: Lightsail keeps the launch script
# as instance data and processes on the box can read it from the metadata service, so the metadata service requires
# IMDSv2 tokens with a hop limit of 1 (the container cannot reach it). Rotate by recreating the instance.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
AZ="${AZ:-${REGION}a}"
INSTANCE="${INSTANCE:-crusonia-bridge}"
BUNDLE="${BUNDLE:-nano_3_0}"
BLUEPRINT="${BLUEPRINT:-ubuntu_24_04}"
WORKER_URL="${WORKER_URL:-https://crusonia.veri-web.workers.dev}"
REPO_URL="${REPO_URL:-https://github.com/DannyMang/crusonia.git}"
REPO_API="${REPO_API:-https://api.github.com/repos/DannyMang/crusonia}"
TEST_TEXT="Crusonia is connected. Reply help for commands."

ls_() { aws lightsail --region "$REGION" "$@"; }
say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

instance_state() { ls_ get-instance --instance-name "$INSTANCE" --query 'instance.state.name' --output text 2>/dev/null || echo "absent"; }

check_inputs() {
  [[ "${GIT_REF:-}" =~ ^[0-9a-f]{40}$ ]] || die "set GIT_REF to the full commit SHA to run"
  curl -fsS -o /dev/null --max-time 15 "$REPO_API/commits/$GIT_REF" || die "commit $GIT_REF is not on GitHub (push it first)"
  [[ -r "${CREDS_FILE:-}" ]] || die "set CREDS_FILE to the file with the Spectrum credentials and OWNER_PHONE"
  [[ -r "${BRIDGE_SECRET_FILE:-}" ]] || die "set BRIDGE_SECRET_FILE to the file with BRIDGE_SECRET="
  for k in SPECTRUM_PROJECT_ID SPECTRUM_PROJECT_SECRET; do
    [[ "$(grep -c "^$k=." "$CREDS_FILE")" -ge 1 ]] || die "$k missing in CREDS_FILE"
  done
  grep -qE '^OWNER_PHONE=\+[1-9][0-9]{6,14}$' "$CREDS_FILE" || die "OWNER_PHONE missing in CREDS_FILE or not E.164"
  grep -qE '^BRIDGE_SECRET=.{32,}$' "$BRIDGE_SECRET_FILE" || die "BRIDGE_SECRET missing or shorter than 32 characters"
  if grep -qE '^(SPECTRUM_PROJECT_ID|SPECTRUM_PROJECT_SECRET|OWNER_PHONE|BRIDGE_SECRET)=.*[[:space:]"'"'"'$`\\]' "$CREDS_FILE" "$BRIDGE_SECRET_FILE"; then
    die "a value contains spaces, quotes or shell characters; Docker env files take raw values"
  fi
}

env_lines() { # exactly the five settings the bridge needs, plus non-secret config
  grep -E '^(SPECTRUM_PROJECT_ID|SPECTRUM_PROJECT_SECRET|OWNER_PHONE)=' "$CREDS_FILE"
  grep -E '^BRIDGE_SECRET=' "$BRIDGE_SECRET_FILE" | head -n 1
  # PORT: the loopback health server, on an uncommon port since the container shares the host's network.
  printf 'WORKER_URL=%s\nSPECTRUM_MODE=live\nBRIDGE_VERSION=%s\nPORT=18733\n' "$WORKER_URL" "${GIT_REF:0:12}"
}

bootstrap_body() { # the first-boot script (bash, as root). Never echoes the env file. Validated by deploy/test-bootstrap.sh.
  cat <<EOF
set -euo pipefail
export HOME=/root # cloud-init runs launch scripts without HOME; git and docker want one
umask 077 # secrets stay private; only the code checkout below is made world-readable
log() { echo "\$(date -u +%FT%TZ) \$*"; }
# Progress beacons: unsigned POSTs the target Worker answers 401 but logs with the query string, so first boot can be
# followed in \`wrangler tail\` without SSH. They carry step names only.
beacon() { curl -fsS -m 10 -o /dev/null -X POST "$WORKER_URL/webhooks/photon/poll?bootstrap=\$1&v=${GIT_REF:0:7}" >/dev/null 2>&1 || true; }
trap 'beacon "failed_line_\$LINENO"' ERR
log "bootstrap start (commit ${GIT_REF:0:12})"
beacon start
if [ ! -f /swapfile ]; then # 512 MB box: swap for the image build
  { fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile &&
    echo '/swapfile none swap sw 0 0' >> /etc/fstab && log "swap on"; } || log "no swap (continuing)"
fi
export DEBIAN_FRONTEND=noninteractive
# First boot races unattended-upgrades for the apt lock: wait for it instead of failing.
APT="apt-get -o DPkg::Lock::Timeout=600 -o Acquire::Retries=3"
\$APT update -y
\$APT install -y --no-install-recommends docker.io git ca-certificates curl
# Recent docker CLIs refuse 'docker build' without the buildx plugin; the legacy builder is the fallback below.
\$APT install -y --no-install-recommends docker-buildx || log "docker-buildx not available; using the legacy builder"
systemctl enable --now docker
log "docker \$(docker version --format '{{.Server.Version}}')"
beacon docker_ready
install -d -m 700 -o root -g root /opt/crusonia-bridge
# Root-only env file: dockerd (root) reads it; the bridge inside the container runs as the unprivileged bun user.
( umask 077; cat > /opt/crusonia-bridge/bridge.env <<'ENVEOF'
$(env_lines)
ENVEOF
)
chmod 600 /opt/crusonia-bridge/bridge.env
# The code (and only the code) must be readable by the container's unprivileged user.
( umask 022
  rm -rf /opt/crusonia-bridge/repo
  git clone --quiet "$REPO_URL" /opt/crusonia-bridge/repo
  git -C /opt/crusonia-bridge/repo checkout --quiet --detach "$GIT_REF" )
beacon cloned
IMAGE="crusonia-bridge:${GIT_REF:0:12}"
# Host networking for the build and the container: the bridge only dials out (and its health server listens on
# 127.0.0.1), so this skips Docker's NAT and DNS entirely. Legacy builder first; BuildKit as the fallback.
DOCKER_BUILDKIT=0 docker build --network host -q -t "\$IMAGE" /opt/crusonia-bridge/repo/bridge >/dev/null ||
  docker build --network host -q -t "\$IMAGE" /opt/crusonia-bridge/repo/bridge >/dev/null
log "image built"
beacon image_built
run() {
  docker rm -f crusonia-bridge >/dev/null 2>&1 || true
  docker run -d --name crusonia-bridge --restart always --network host --env-file /opt/crusonia-bridge/bridge.env \\
    --cap-drop ALL --security-opt no-new-privileges --memory 300m --pids-limit 200 \\
    --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 "\$@" "\$IMAGE" >/dev/null
}
# Health is read into a variable first: piping into 'grep -q' can SIGPIPE docker exec and fail under pipefail.
connected() {
  local out
  for _ in \$(seq 1 24); do
    sleep 5
    out="\$(docker exec crusonia-bridge bun src/cli.ts health 2>/dev/null || true)"
    case "\$out" in *'"state":"connected"'*) return 0 ;; esac
  done
  return 1
}
run --read-only --tmpfs /tmp:rw,size=64m
if connected; then log "bridge connected (read-only root filesystem)"; beacon connected_ro; else
  log "not connected with a read-only root filesystem; retrying writable"
  beacon retry_writable
  run
  if connected; then log "bridge connected"; beacon connected_rw; else
    log "bridge NOT connected; see: docker logs crusonia-bridge"
    beacon not_connected
    # Why, as URL-safe text (long digit runs masked): container state, then its last log lines.
    beacon "state_\$(docker inspect -f '{{.State.Status}}-exit{{.State.ExitCode}}-oom{{.State.OOMKilled}}-restarts{{.RestartCount}}' crusonia-bridge 2>&1 | tr -c 'A-Za-z0-9_.-' '_' | head -c 120)"
    beacon "log_\$(docker logs --tail 3 crusonia-bridge 2>&1 | sed -E 's/[0-9]{7,}/N/g' | tr -c 'A-Za-z0-9_.:-' '_' | head -c 600)"
  fi
fi
if [ "${SEND_TEST_MESSAGE:-0}" = "1" ] && [ ! -f /opt/crusonia-bridge/.test-message-sent ]; then
  out="\$(docker exec crusonia-bridge bun src/cli.ts notify test:connected "$TEST_TEXT" 2>&1 || true)"
  case "\$out" in
    "200 "*) touch /opt/crusonia-bridge/.test-message-sent; log "test message sent"; beacon test_sent ;;
    *) log "test message FAILED: \$(printf '%s' "\$out" | head -c 300)"; beacon "test_failed_\$(printf '%s' "\$out" | head -c 3)" ;;
  esac
fi
log "bootstrap done"
beacon done
EOF
}

launch_script() {
  # Lightsail runs launch scripts with /bin/sh (its examples have no shebang), so the outer layer is POSIX sh: it writes
  # the real (bash) bootstrap to /run, which is RAM-backed, runs it, and deletes it.
  cat <<EOF
#!/bin/sh
umask 077
cat > /run/crusonia-bootstrap.sh <<'CRUSONIA_BOOTSTRAP'
#!/bin/bash
exec >>/var/log/crusonia-bootstrap.log 2>&1
$(bootstrap_body)
CRUSONIA_BOOTSTRAP
/bin/bash /run/crusonia-bootstrap.sh
status=\$?
rm -f /run/crusonia-bootstrap.sh
exit \$status
EOF
}

cmd_plan() {
  aws sts get-caller-identity --query 'Arn' --output text >/dev/null || die "AWS CLI is not authenticated"
  say "region $REGION ($AZ), instance $INSTANCE, bundle $BUNDLE, blueprint $BLUEPRINT"
  ls_ get-bundles --query "bundles[?bundleId=='$BUNDLE'].[bundleId,price,ramSizeInGb,diskSizeInGb,publicIpv4AddressCount]" --output text |
    awk '{ printf "bundle: %s  $%s/month  %s GB RAM  %s GB disk  %s public IPv4\n", $1, $2, $3, $4, $5 }' >&2
  [[ -n "$(ls_ get-blueprints --query "blueprints[?blueprintId=='$BLUEPRINT'].blueprintId" --output text)" ]] || die "blueprint $BLUEPRINT not available"
  local state; state="$(instance_state)"
  say "instance: ${state/absent/none (up would create it, tags project=crusonia)}"
  say "firewall after up: no open ports; metadata: IMDSv2 required, hop limit 1"
  if [[ -n "${GIT_REF:-}${CREDS_FILE:-}${BRIDGE_SECRET_FILE:-}" ]]; then check_inputs && say "inputs: complete (commit ${GIT_REF:0:12}; values not shown)"; fi
}

cmd_up() {
  cmd_plan
  check_inputs
  [[ "$(instance_state)" == absent ]] || die "instance $INSTANCE exists; use recreate"
  UP_TMP="$(mktemp -d)"; chmod 700 "$UP_TMP"
  local tmp="$UP_TMP"
  trap 'rm -rf "${UP_TMP:-}"' EXIT
  (umask 077; launch_script > "$tmp/launch.sh")
  ls_ create-instances --instance-names "$INSTANCE" --availability-zone "$AZ" --blueprint-id "$BLUEPRINT" \
    --bundle-id "$BUNDLE" --ip-address-type ipv4 --user-data "file://$tmp/launch.sh" \
    --tags key=project,value=crusonia >/dev/null
  rm -rf "$tmp"
  say "created instance $INSTANCE (commit ${GIT_REF:0:12})"
  for _ in $(seq 1 60); do [[ "$(instance_state)" =~ ^(pending|running)$ ]] && break; sleep 2; done
  lock_down
  for _ in $(seq 1 60); do [[ "$(instance_state)" == running ]] && break; sleep 5; done
  say "instance running; first boot takes ~3-5 minutes (Docker install, image build, connect)"
}

lock_down() {
  # Lightsail opens 22 and 80 to everyone on new instances: close every port.
  for _ in $(seq 1 20); do
    ls_ put-instance-public-ports --instance-name "$INSTANCE" --port-infos '[]' >/dev/null 2>&1 && break
    sleep 3
  done
  say "firewall: all ports closed"
  for _ in $(seq 1 20); do
    ls_ update-instance-metadata-options --instance-name "$INSTANCE" --http-tokens required \
      --http-put-response-hop-limit 1 --http-endpoint enabled >/dev/null 2>&1 && break
    sleep 3
  done
  say "metadata service: IMDSv2 required, hop limit 1"
}

cmd_status() {
  say "instance $INSTANCE: $(instance_state)"
  [[ "$(instance_state)" == absent ]] && return 0
  local ports; ports="$(ls_ get-instance-port-states --instance-name "$INSTANCE" --query 'length(portStates)' --output text)"
  say "open ports: $ports"
  ls_ get-instance --instance-name "$INSTANCE" \
    --query 'instance.[bundleId,blueprintId,metadataOptions.httpTokens,metadataOptions.httpPutResponseHopLimit,tags[?key==`project`].value|[0]]' --output text |
    awk '{ printf "bundle %s, %s, IMDS tokens %s, hop limit %s, tag project=%s\n", $1, $2, $3, $4, $5 }' >&2
}

cmd_down() {
  [[ "${1:-}" == --yes ]] || die "this deletes the instance; run: $0 down --yes"
  if [[ "$(instance_state)" != absent ]]; then
    ls_ delete-instance --instance-name "$INSTANCE" >/dev/null
    for _ in $(seq 1 60); do [[ "$(instance_state)" == absent ]] && break; sleep 5; done
    say "deleted instance $INSTANCE"
  fi
}

[[ "${AWS_SH_LIB:-}" == 1 ]] && return 0 2>/dev/null

case "${1:-plan}" in
  plan) cmd_plan ;;
  up) cmd_up ;;
  recreate) cmd_plan; check_inputs; cmd_down --yes; cmd_up ;;
  status) cmd_status ;;
  down) cmd_down "${2:-}" ;;
  *) sed -n '2,30p' "$0"; exit 2 ;;
esac
