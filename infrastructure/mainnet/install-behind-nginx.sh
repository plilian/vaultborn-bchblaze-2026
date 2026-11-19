#!/usr/bin/env bash
# Installs VaultBorn on a server that already runs nginx for other sites, without touching them.
#
# It creates or changes ONLY:
#   $APP                      the game's own folder (default /opt/vaultborn), already uploaded
#   Docker project "vaultborn" two containers on their own network; the game listens on 127.0.0.1 only
#   $ACME                     an empty folder for certificate checks (default /var/www/vaultborn-acme)
#   one nginx site file       $NGINX/sites-available/vaultborn-<domain>.conf (+ its link in sites-enabled)
#   one certificate           for <domain>, obtained with the server's existing certbot
# It never edits another site, never restarts nginx (only "reload", and only after "nginx -t" passed), opens no
# firewall port, and installs no package. If a step fails, what it added to nginx is removed again.
#
#   DOMAIN=play.example.org bash install-behind-nginx.sh           install or update
#   DOMAIN=play.example.org bash install-behind-nginx.sh remove    take the game off this server again
set -euo pipefail

DOMAIN=${DOMAIN:?set DOMAIN to the host name of the game}
APP=${APP:-/opt/vaultborn}
NGINX=${NGINX:-/etc/nginx}
ACME=${ACME:-/var/www/vaultborn-acme}
LE=${LE:-/etc/letsencrypt}
COMPOSE_FILE="$APP/infrastructure/mainnet/compose.behind-proxy.yaml"

say() { printf '== %s\n' "$*"; }
stop() { printf 'STOPPED: %s\n' "$*" >&2; exit 1; }

[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$ ]] || stop "\"$DOMAIN\" is not a host name. Nothing was changed."
for tool in docker nginx certbot ss; do command -v "$tool" >/dev/null 2>&1 || stop "$tool is not installed on this server. Nothing was changed."; done
docker compose version >/dev/null 2>&1 || stop "docker compose is not available. Nothing was changed."

if [ -d "$NGINX/sites-available" ] && [ -d "$NGINX/sites-enabled" ]; then
  SITE="$NGINX/sites-available/vaultborn-$DOMAIN.conf"; LINK="$NGINX/sites-enabled/vaultborn-$DOMAIN.conf"
else
  SITE="$NGINX/conf.d/vaultborn-$DOMAIN.conf"; LINK=""
fi
compose() { VAULTBORN_PORT="$PORT" docker compose -p vaultborn -f "$COMPOSE_FILE" "$@" </dev/null; }
# The addresses the existing sites listen on for a port, so that the game's site is reachable exactly like them
# ("" is every IPv4 address; "[::]" is IPv6; anything else is one specific address).
listen_lines() { # port, suffix
  { echo ""; cat "$NGINX"/sites-enabled/* "$NGINX"/conf.d/*.conf 2>/dev/null | sed 's/#.*//' | grep -oE "(^|[;{[:space:]])listen[[:space:]]+[^;]+" | awk '{print $2}' | grep -E "(^|:)$1\$" | sed -E "s/:?$1\$//; s/^(0\.0\.0\.0|\*)\$//" || true; } | sort -u |
    while IFS= read -r address; do printf '    listen %s%s%s;\n' "$address" "${address:+:}" "$1$2"; done
}
reload_nginx() { nginx -t >/dev/null 2>&1 && systemctl reload nginx; }
remove_site() { rm -f "$SITE"; [ -z "$LINK" ] || rm -f "$LINK"; }

if [ "${1:-install}" = "remove" ]; then
  PORT=$(cat "$APP/port" 2>/dev/null || echo 4273)
  say "Stopping the game's containers"; compose down 2>/dev/null || true
  say "Removing the game's nginx site"; remove_site; reload_nginx || true
  say "Removed. The folder $APP (database and keys) and the certificate were left in place; delete them yourself if you want."
  exit 0
fi

[ -f "$APP/.env.mainnet" ] || stop "$APP/.env.mainnet is missing. Nothing was changed."
[ -f "$COMPOSE_FILE" ] || stop "$COMPOSE_FILE is missing. Nothing was changed."
# Only root may look into the game's folder on this server; the containers get the data folder handed in by Docker.
chmod 700 "$APP"

# The web server must be healthy before anything is added, or a later failure could not be told apart from an old one.
nginx -t >/dev/null 2>&1 || stop "nginx reports a problem in its present configuration (run \"nginx -t\"). Nothing was changed."
# The host name must not belong to another site on this server.
others=$(grep -RlsE "server_name[^;]*[[:space:]]$(printf '%s' "$DOMAIN" | sed 's/\./\\./g')([[:space:]]|;)" "$NGINX/sites-enabled" "$NGINX/conf.d" 2>/dev/null | grep -v "/vaultborn-$DOMAIN.conf$" || true)
[ -z "$others" ] || stop "another site on this server already answers for $DOMAIN ($others). Nothing was changed."

# A free local port, chosen once and kept.
if [ -s "$APP/port" ]; then PORT=$(cat "$APP/port"); else
  PORT=""
  listening=$(ss -H -ltn 2>/dev/null | awk '{print $4}')
  [ -n "$listening" ] || stop "the list of open ports could not be read. Nothing was changed."
  for candidate in $(seq 4273 4373); do
    if ! grep -Eq "[:.]$candidate\$" <<<"$listening"; then PORT=$candidate; break; fi
  done
  [ -n "$PORT" ] || stop "no free local port between 4273 and 4373. Nothing was changed."
  echo "$PORT" > "$APP/port"
fi
[[ "$PORT" =~ ^[0-9]+$ ]] || stop "the stored port is not a number."

say "Starting the game and its attestors (Docker project vaultborn, 127.0.0.1:$PORT)"
compose build vaultborn || stop "the game could not be built on this server (see the lines above; the server must be able to download the Node.js image and the game's packages). The web server was not touched."
compose up -d || stop "the game's containers could not be started (see the lines above). The web server was not touched."
healthy=""
for attempt in $(seq 1 40); do
  if compose exec -T vaultborn node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>r.json()).then(b=>process.exit(b.ok&&b.network==='mainnet'?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then healthy=yes; break; fi
  sleep 5
done
if [ -z "$healthy" ]; then compose logs --tail 30 vaultborn || true; stop "the game did not start. The web server was not touched."; fi
say "The game answers on Mainnet inside the server"

http_site() { cat <<SITE
# VaultBorn. Written by install-behind-nginx.sh; remove with "install-behind-nginx.sh remove".
server {
$(listen_lines 80 "")
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root $ACME; }
    location / { return 301 https://\$host\$request_uri; }
}
SITE
}
https_site() { http_site; cat <<SITE
server {
$(listen_lines 443 " ssl")
    server_name $DOMAIN;
    ssl_certificate $LE/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key $LE/live/$DOMAIN/privkey.pem;
    client_max_body_size 1m;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Frame-Options "DENY" always;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection "";
        # The live game state is a long-lived stream and must not be buffered or cut.
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
SITE
}
write_site() { "$1" > "$SITE"; [ -z "$LINK" ] || ln -sfn "$SITE" "$LINK"; }

mkdir -p "$ACME/.well-known/acme-challenge"
chmod -R a+rX "$ACME"
if [ ! -s "$LE/live/$DOMAIN/fullchain.pem" ]; then
  say "Adding the game's site to nginx (certificate check only)"
  write_site http_site
  if ! nginx -t >/dev/null 2>&1; then
    problem=$(nginx -t 2>&1 | tail -3 || true); remove_site
    stop "nginx did not accept the new site, so it was removed again and nginx was not reloaded: $problem"
  fi
  # nginx must actually read the new file; if its configuration does not include this folder, stop here.
  loaded=$(nginx -T 2>/dev/null || true)
  if [[ "$loaded" != *"vaultborn-$DOMAIN.conf"* ]]; then remove_site; stop "nginx on this server does not load site files from $(dirname "${LINK:-$SITE}"), so the site was removed again. Nothing else was changed."; fi
  systemctl reload nginx
  say "Requesting the certificate for $DOMAIN"
  # The server's existing certificate account is used. Only a server that has none gets one, without an e-mail address.
  register=""; [ -n "$(find "$LE/accounts" -name regr.json 2>/dev/null | head -1)" ] || register="--register-unsafely-without-email"
  if ! certbot certonly --webroot -w "$ACME" -d "$DOMAIN" --non-interactive --agree-tos $register --keep-until-expiring --deploy-hook "systemctl reload nginx" > "$APP/certbot.log" 2>&1; then
    remove_site; reload_nginx || true
    tail -8 "$APP/certbot.log" >&2 || true
    stop "no certificate could be obtained for $DOMAIN (see the lines above). The name must point at this server; free shared names such as sslip.io are sometimes refused because too many people request certificates for them, and a name of your own domain avoids that. The site was removed from nginx again; the game keeps running on 127.0.0.1:$PORT only."
  fi
fi

say "Switching the game's site to HTTPS"
previous=""; [ -f "$SITE" ] && previous=$(cat "$SITE")
write_site https_site
if ! nginx -t >/dev/null 2>&1; then
  problem=$(nginx -t 2>&1 | tail -3 || true)
  if [ -n "$previous" ]; then printf '%s\n' "$previous" > "$SITE"; else remove_site; fi
  reload_nginx || true
  stop "nginx did not accept the HTTPS site, so the previous state was restored: $problem"
fi
systemctl reload nginx

say "Checking https://$DOMAIN from the server itself"
if command -v curl >/dev/null 2>&1; then
  answer=$(curl -fsS --max-time 15 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" 2>&1 || true)
  [[ "$answer" == *'"network":"mainnet"'* ]] || stop "the site is installed, but https://$DOMAIN/api/health did not answer as expected."
fi
say "INSTALLED: https://$DOMAIN (game on 127.0.0.1:$PORT, site file $SITE)"
