#!/usr/bin/env bash
# Jesse fork: pack the built openclaw into a tarball and install on the EC2.
#
# Assumes: `pnpm build` has already run (via sync-upstream.sh or manually).
# Assumes: SSH access to jesse EC2 at $JESSE_EC2_HOST (default 3.146.217.176)
#          using key $JESSE_EC2_KEY (default ~/.ssh/jesse.pem).

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

HOST="${JESSE_EC2_HOST:-3.146.217.176}"
KEY="${JESSE_EC2_KEY:-$HOME/.ssh/jesse.pem}"
SSH="ssh -i $KEY ubuntu@$HOST"

echo "packing..."
rm -f /tmp/openclaw-fork-pack/*.tgz
mkdir -p /tmp/openclaw-fork-pack
npm pack --pack-destination /tmp/openclaw-fork-pack >/dev/null
TGZ=$(ls -t /tmp/openclaw-fork-pack/openclaw-*.tgz | head -1)
if [[ -z "$TGZ" || ! -f "$TGZ" ]]; then
  echo "error: npm pack produced no tarball" >&2
  exit 1
fi
echo "  tarball: $TGZ ($(du -h "$TGZ" | cut -f1))"

echo "shipping to ${HOST}..."
scp -i "$KEY" "$TGZ" "ubuntu@${HOST}:/tmp/openclaw-fork.tgz"

echo "installing on EC2..."
$SSH 'source ~/.nvm/nvm.sh && \
  cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.pre-install-$(date -u +%Y%m%dT%H%M%SZ) && \
  npm install -g /tmp/openclaw-fork.tgz 2>&1 | tail -5 && \
  systemctl --user restart openclaw-gateway && \
  sleep 10 && \
  systemctl --user is-active openclaw-gateway && \
  journalctl --user -u openclaw-gateway -n 20 --no-pager | tail -20'

echo
echo "verify: curl http://127.0.0.1:18789/bluebubbles-webhook (via SSH) and send a test iMessage"
