#!/usr/bin/env bash
#
# Turn a fresh Ubuntu or Oracle Linux machine into the rxpos server.
#
# Run as root on the new host:
#
#   DATABASE_URL="postgresql://..." ./setup-server.sh
#
# Optional:
#   HOSTNAME_OVERRIDE=pharmacy.example.com   a real domain, if you have one
#   NODE_VERSION=24.14.1                     a different Node
#
# Every step is idempotent, so running it again is how you update the machine.
#
set -euo pipefail

APP_DIR=/srv/rxpos
APP_USER=rxpos
NODE_VERSION="${NODE_VERSION:-24.14.1}"
REPO="${REPO:-git@github.com:lartey55234-ux/rxpos.git}"
DEPLOY_KEY="${DEPLOY_KEY:-/root/.ssh/rxpos_deploy}"
PORT="${PORT:-4173}"

: "${DATABASE_URL:?Set DATABASE_URL to the PostgreSQL connection string}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=amd64 ;;
  *) echo "Unsupported architecture: $(uname -m)"; exit 1 ;;
esac

# ---------------------------------------------------------------------------
# A name to answer on. Without a domain, sslip.io resolves <ip>.sslip.io back to
# that address, which is enough for Let's Encrypt to issue a real certificate.
# ---------------------------------------------------------------------------
IP=$(curl -fsS --max-time 15 https://api.ipify.org)
HOST="${HOSTNAME_OVERRIDE:-${IP}.sslip.io}"
say "This server will answer on https://${HOST}"

# ---------------------------------------------------------------------------
# Node, from the official build so the distribution's old version is irrelevant.
# ---------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null)" != "v${NODE_VERSION}" ]; then
  say "Installing Node ${NODE_VERSION} (${ARCH})"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md
  rm -f /tmp/node.tar.xz
fi
say "Node $(node -v)"

# ---------------------------------------------------------------------------
# Caddy terminates TLS and gets the certificate on its own.
# ---------------------------------------------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
  say "Installing Caddy"
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=${ARCH}" -o /usr/local/bin/caddy
  chmod +x /usr/local/bin/caddy
fi
say "Caddy $(caddy version | head -1)"

# ---------------------------------------------------------------------------
# A service account that owns the code, and the key it uses to fetch it.
# ---------------------------------------------------------------------------
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "/home/$APP_USER/.ssh"
install -o "$APP_USER" -g "$APP_USER" -m 600 "$DEPLOY_KEY" "/home/$APP_USER/.ssh/id_ed25519"

say "Fetching the code"
export GIT_SSH_COMMAND="ssh -i /home/$APP_USER/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/home/$APP_USER/.ssh/known_hosts"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --prune origin
  git -C "$APP_DIR" reset --hard origin/main
else
  git clone "$REPO" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

say "Installing dependencies and building the counter"
sudo -u "$APP_USER" env HOME="/home/$APP_USER" bash -c "cd $APP_DIR && npm ci --include=dev --no-audit --no-fund && npm run build"

# ---------------------------------------------------------------------------
# Configuration. The connection string carries a password, so it lives in a
# root-owned file rather than in the unit or the shell history.
# ---------------------------------------------------------------------------
say "Writing /etc/rxpos.env"
cat > /etc/rxpos.env <<EOF
NODE_ENV=production
DATABASE_URL=${DATABASE_URL}
PORT=${PORT}
HOST=127.0.0.1
SEED_DEMO=0
EOF
chmod 600 /etc/rxpos.env

say "Installing the service"
cat > /etc/systemd/system/rxpos.service <<EOF
[Unit]
Description=rxpos pharmacy point of sale
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=/etc/rxpos.env
ExecStart=/usr/local/bin/node --disable-warning=ExperimentalWarning scripts/serve.ts
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

say "Installing Caddy's service and site"
cat > /etc/systemd/system/caddy.service <<EOF
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
Restart=on-failure
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

mkdir -p /etc/caddy /var/lib/caddy
cat > /etc/caddy/Caddyfile <<EOF
${HOST} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:${PORT}
}
EOF

# ---------------------------------------------------------------------------
# Open 80 and 443. On Oracle Cloud this is only half the job: the VCN security
# list has to allow them too, which is done in the console.
# ---------------------------------------------------------------------------
say "Opening the firewall"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-service=https >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi
# Oracle's images also ship iptables rules that drop everything but SSH.
if command -v iptables >/dev/null 2>&1 && [ -f /etc/iptables/rules.v4 ]; then
  iptables -I INPUT 5 -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
  iptables -I INPUT 5 -p tcp --dport 443 -j ACCEPT 2>/dev/null || true
fi

systemctl daemon-reload
systemctl enable --now rxpos >/dev/null 2>&1
systemctl restart rxpos
systemctl enable --now caddy >/dev/null 2>&1
systemctl restart caddy

sleep 4
say "The app answered:"
curl -fsS --max-time 10 "http://127.0.0.1:${PORT}/healthz" || echo "  (not yet — check: journalctl -u rxpos -n 50)"

say "Done"
cat <<EOF

  https://${HOST}
  health: https://${HOST}/healthz

  Logs      journalctl -u rxpos -f
  Update    cd ${APP_DIR} && git pull && npm ci --include=dev && npm run build && systemctl restart rxpos
  Or just   run this script again
EOF
