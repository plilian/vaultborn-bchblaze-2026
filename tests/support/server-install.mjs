// Runs infrastructure/mainnet/install-behind-nginx.sh against a make-believe server: temporary folders in place of
// /opt/vaultborn, /etc/nginx and /etc/letsencrypt, and stand-in "docker", "nginx", "certbot", "systemctl", "ss" and
// "curl" commands that write down what they were asked to do. It shows what the script changes and what it leaves
// alone; it does not show that a real server accepts it.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function makeServer({ empty = false, sites = { 'crm.example.com.conf': 'server { listen 80; listen [::]:80; listen 443 ssl; listen [::]:443 ssl; server_name crm.example.com; }\n', '00-other': 'server { listen 80; server_name other.example.org www.other.example.org; }\n' }, busyPorts = [4173, 4273] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'vb-server-'));
  const paths = { base, app: join(base, 'opt', 'vaultborn'), nginx: join(base, 'etc', 'nginx'), acme: join(base, 'www', 'acme'), le: join(base, 'etc', 'letsencrypt'), bin: join(base, 'bin'), calls: join(base, 'calls.log'), flags: join(base, 'flags') };
  for (const folder of [join(paths.app, 'infrastructure', 'mainnet'), join(paths.nginx, 'sites-available'), join(paths.nginx, 'sites-enabled'), join(paths.nginx, 'conf.d'), join(paths.le, 'accounts', 'acme', 'directory', 'id'), paths.bin, paths.flags]) mkdirSync(folder, { recursive: true });
  // "empty": the game's folder does not exist yet, as on a server before the first upload.
  if (empty) spawnSync('rm', ['-rf', paths.app]);
  else {
    for (const file of ['compose.behind-proxy.yaml', 'install-behind-nginx.sh']) cpSync(join(root, 'infrastructure', 'mainnet', file), join(paths.app, 'infrastructure', 'mainnet', file));
    writeFileSync(join(paths.app, '.env.mainnet'), 'VAULTBORN_NETWORK=mainnet\n');
  }
  const env = { PATH: paths.bin + ':' + process.env.PATH, APP: paths.app, NGINX: paths.nginx, ACME: paths.acme, LE: paths.le, FAKE_CALLS: paths.calls, FAKE_FLAGS: paths.flags, FAKE_NGINX: paths.nginx, FAKE_LE: paths.le };
  writeFileSync(join(paths.le, 'accounts', 'acme', 'directory', 'id', 'regr.json'), '{}');
  for (const [name, text] of Object.entries(sites)) writeFileSync(join(paths.nginx, 'sites-enabled', name), text);
  const command = (name, body) => { writeFileSync(join(paths.bin, name), '#!/usr/bin/env bash\necho "' + name + ' $*" >> "$FAKE_CALLS"\n' + body + '\n'); chmodSync(join(paths.bin, name), 0o755); };
  // nginx: "-t" fails when a flag file says so, or when a site of the stated kind is present; "-T" prints every enabled file.
  command('nginx', `case "$1" in
  -t) [ -e "$FAKE_FLAGS/nginx-broken" ] && { echo "nginx: configuration file test failed" >&2; exit 1; }
      if [ -e "$FAKE_FLAGS/nginx-rejects-https" ] && grep -Rqs "listen 443" "$FAKE_NGINX/sites-enabled"/vaultborn-* 2>/dev/null; then echo "nginx: [emerg] made-up refusal of the HTTPS site" >&2; exit 1; fi
      if [ -e "$FAKE_FLAGS/nginx-rejects-site" ] && ls "$FAKE_NGINX/sites-enabled"/vaultborn-* >/dev/null 2>&1; then echo "nginx: [emerg] made-up refusal" >&2; exit 1; fi
      echo "syntax is ok" >&2; exit 0;;
  -T) [ -e "$FAKE_FLAGS/nginx-ignores-folder" ] && exit 0
      for f in "$FAKE_NGINX/sites-enabled"/*; do echo "# configuration file $f:"; cat "$f"; done;;
  -v) echo "nginx version: nginx/1.28.3" >&2;;
esac`);
  command('docker', `if [ "$1" = compose ] && [ "$2" = version ]; then echo "Docker Compose version v5"; exit 0; fi
case " $* " in
  *" exec "*) [ -e "$FAKE_FLAGS/game-down" ] && exit 1; exit 0;;
  *" build "*) [ -e "$FAKE_FLAGS/build-fails" ] && { echo "made-up build failure" >&2; exit 1; }; echo "port=$VAULTBORN_PORT" >> "$FAKE_CALLS"; exit 0;;
  *) exit 0;;
esac`);
  command('certbot', `[ -e "$FAKE_FLAGS/certbot-fails" ] && { echo "made-up: the name does not point at this server" >&2; exit 1; }
domain=""; while [ $# -gt 0 ]; do [ "$1" = "-d" ] && domain="$2"; shift; done
mkdir -p "$FAKE_LE/live/$domain"; echo cert > "$FAKE_LE/live/$domain/fullchain.pem"; echo key > "$FAKE_LE/live/$domain/privkey.pem"`);
  command('systemctl', 'exit 0');
  command('ss', busyPorts.map(port => `echo "LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:*"`).join('\n'));
  // "site-slow": the first two checks fail, as right after an nginx reload; "site-silent": every check fails.
  command('curl', `[ -e "$FAKE_FLAGS/site-silent" ] && { echo "curl: (60) SSL: no alternative certificate subject name matches" >&2; exit 60; }
if [ -e "$FAKE_FLAGS/site-slow" ]; then n=$(cat "$FAKE_FLAGS/site-slow"); echo $((n+1)) > "$FAKE_FLAGS/site-slow"; [ "\${n:-0}" -ge 2 ] || exit 7; fi
echo '{"ok":true,"network":"mainnet"}'`);
  // The installer waits between checks; here it does not.
  command('sleep', 'exit 0');
  const run = (domain, mode = 'install') => {
    const result = spawnSync('bash', [join(paths.app, 'infrastructure', 'mainnet', 'install-behind-nginx.sh'), mode], { encoding: 'utf8',
      env: { ...env, DOMAIN: domain } });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  const flag = (name, on = true) => { const file = join(paths.flags, name); if (on) writeFileSync(file, ''); else if (existsSync(file)) spawnSync('rm', ['-f', file]); };
  const calls = () => existsSync(paths.calls) ? readFileSync(paths.calls, 'utf8').trim().split('\n') : [];
  const enabled = () => readdirSync(join(paths.nginx, 'sites-enabled')).sort();
  const site = domain => { const file = join(paths.nginx, 'sites-available', 'vaultborn-' + domain + '.conf'); return existsSync(file) ? readFileSync(file, 'utf8') : null; };
  return { paths, env, run, flag, calls, enabled, site, others: Object.keys(sites) };
}
