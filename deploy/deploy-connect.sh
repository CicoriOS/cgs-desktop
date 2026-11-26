#!/usr/bin/env bash
# Serve the /connect PWA (dist-connect, built with `vite build --mode connect`) from the reverse proxies' nginx, in front of
# the NewAPI upstream, and roll back by itself when anything fails.
#
# Usage: deploy/deploy-connect.sh [HOST_KEY...]     no argument = every host below
#        HOST_KEY: ai-cicori | ai-cnklp
# The page is served from the same origin as the API (cookies, /api/remote/ticket, the /relay WebSocket stay same-origin and
# keep going to the upstream); only /connect/ is answered by nginx itself.
#
# Per host, on the host, in one script (it survives a dropped ssh connection):
#   1. unpack the build next to the live one and swap it in (the old one is kept as connect.old.<tag>)
#   2. write /etc/nginx/snippets/cgs-connect.conf and include it in each listed server block (once, before `location / {`)
#   3. nginx -t, reload, then check from the host itself: /connect/ is the page, an asset is served, /api/status still
#      reaches the upstream
# Any failure restores the previous build and every nginx file touched, tests and reloads nginx again, and exits non-zero.
set -euo pipefail

cd "$(dirname "$0")/.."
DIST=dist-connect

# key  ssh-target  "server-block files"  "name:port the host answers on, for the local checks"
declare -A TARGET=( [ai-cicori]=root@156.233.228.244 [ai-cnklp]=root@8.148.184.212 )
declare -A CONFS=(
  [ai-cicori]="ai.cicori.com.conf apia.bmpss.top.conf"
  [ai-cnklp]="ai.cnklp.cn.conf"
)
declare -A CHECKS=(
  [ai-cicori]="ai.cicori.com:443 apia.bmpss.top:443"
  [ai-cnklp]="ai.cnklp.cn:47443"
)

[ -f "$DIST/index-connect.html" ] || { echo "no $DIST/index-connect.html: run 'bun --bun run vite build --mode connect' first" >&2; exit 2; }
keys=("$@"); [ ${#keys[@]} -gt 0 ] || keys=(ai-cicori ai-cnklp)
for k in "${keys[@]}"; do [ -n "${TARGET[$k]:-}" ] || { echo "unknown host key: $k" >&2; exit 2; }; done

TAG=$(date +%Y%m%d-%H%M%S)
ARCHIVE=$(mktemp /tmp/cgs-connect.XXXXXX.tgz)
trap 'rm -f "$ARCHIVE"' EXIT
tar -C "$DIST" -czf "$ARCHIVE" .

failed=0
for k in "${keys[@]}"; do
  host=${TARGET[$k]}
  echo "=== $k ($host)"
  ssh -o BatchMode=yes "$host" true
  scp -q "$ARCHIVE" "$host:/tmp/cgs-connect.$TAG.tgz"
  # shellcheck disable=SC2029  # expanded here on purpose
  if ! ssh -o BatchMode=yes "$host" "TAG=$TAG CONFS='${CONFS[$k]}' CHECKS='${CHECKS[$k]}' bash -s" <<'REMOTE'
set -uo pipefail
trap '' HUP
ROOT=/var/www/cgs
NEW=$ROOT/connect.new.$TAG
OLD=$ROOT/connect.old.$TAG
LIVE=$ROOT/connect
CONFDIR=/etc/nginx/conf.d
SNIPPET=/etc/nginx/snippets/cgs-connect.conf
SWAPPED=0
declare -a TOUCHED=()

log() { echo "[connect $TAG] $*"; }

rollback() {
  log "FAILED, rolling back"
  for f in "${TOUCHED[@]}"; do cp -p "$f.bak-connect-$TAG" "$f" && log "restored $f"; done
  if [ $SWAPPED = 1 ]; then
    rm -rf "$LIVE"
    [ -d "$OLD" ] && mv "$OLD" "$LIVE" && log "previous build restored"
  fi
  if nginx -t >/dev/null 2>&1; then systemctl reload nginx && log "nginx reloaded with the previous configuration"; else log "NGINX CONFIGURATION DOES NOT PASS nginx -t AFTER THE ROLLBACK; look at it by hand"; fi
  rm -rf "$NEW" /tmp/cgs-connect.$TAG.tgz
  exit 1
}
fail() { log "$*"; rollback; }

mkdir -p "$ROOT" /etc/nginx/snippets || fail "cannot create $ROOT"
mkdir "$NEW" && tar -xzf /tmp/cgs-connect.$TAG.tgz -C "$NEW" || fail "cannot unpack the build"
[ -f "$NEW/index-connect.html" ] || fail "the build has no index-connect.html"
# the build tool leaves 0700/0600 modes; nginx's worker must read it
find "$NEW" -type d -exec chmod 755 {} + && find "$NEW" -type f -exec chmod 644 {} + || fail "cannot set modes"
# files must sit under <root>/connect/ because nginx joins root and the request path
mkdir "$ROOT/.tmp-$TAG" && mv "$NEW" "$ROOT/.tmp-$TAG/connect" || fail "cannot stage the build"
NEW=$ROOT/.tmp-$TAG

# From here on a failure must put the previous build back (a first deploy has none: rollback then just removes the new one).
SWAPPED=1
[ -d "$LIVE" ] && { mv "$LIVE" "$OLD" || fail "cannot move the live build aside"; }
mv "$NEW/connect" "$LIVE" || fail "cannot install the build"
rmdir "$NEW"

cat > "$SNIPPET" <<'EOF' || fail "cannot write $SNIPPET"
# CGS Connect PWA, served by nginx itself; everything else still goes to the upstream. Managed by deploy-connect.sh.
location = /connect { return 301 /connect/; }
location /connect/ {
    root /var/www/cgs;
    try_files $uri /connect/index-connect.html;
    add_header Cache-Control "no-cache" always;
    add_header X-Content-Type-Options "nosniff" always;
}
location /connect/assets/ {
    root /var/www/cgs;
    try_files $uri =404;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    add_header X-Content-Type-Options "nosniff" always;
}
EOF

for c in $CONFS; do
  f=$CONFDIR/$c
  [ -f "$f" ] || fail "$f does not exist"
  cp -p "$f" "$f.bak-connect-$TAG" || fail "cannot back up $f"
  TOUCHED+=("$f")
  if grep -q "snippets/cgs-connect.conf" "$f"; then log "$c already includes the snippet"; continue; fi
  awk -v inc="    include $SNIPPET;" '!done && /^[[:space:]]*location \/ \{/ { print inc; done=1 } { print }' "$f.bak-connect-$TAG" > "$f" || fail "cannot edit $f"
  grep -q "snippets/cgs-connect.conf" "$f" || fail "$c has no \`location / {\` to put the include before"
done

nginx -t >/tmp/nginx-t.$TAG 2>&1 || { cat /tmp/nginx-t.$TAG; fail "nginx -t rejects the configuration"; }
systemctl reload nginx || fail "nginx did not reload"

for check in $CHECKS; do
  name=${check%%:*}; port=${check##*:}
  base="https://$name:$port"
  R="--resolve $name:$port:127.0.0.1 -sk -m 10"
  # `reload` returns before the new workers answer; give them a few seconds before judging.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    page=$(curl $R -o /tmp/connect-page.$TAG -w '%{http_code} %{content_type}' "$base/connect/")
    case "$page" in "200 text/html"*) break ;; esac
    sleep 1
  done
  case "$page" in "200 text/html"*) ;; *)
    curl $R -o /dev/null -D - "$base/connect/" | head -12
    nginx -T 2>/dev/null | grep -n "cgs-connect\|server_name $name" | head
    fail "$base/connect/ answered '$page'" ;;
  esac
  grep -q "/connect/assets/" /tmp/connect-page.$TAG || fail "$base/connect/ is not the PWA page"
  asset=$(grep -o '/connect/assets/[^"]*\.js' /tmp/connect-page.$TAG | head -1)
  [ "$(curl $R -o /dev/null -w '%{http_code}' "$base$asset")" = 200 ] || fail "$base$asset is not served"
  [ "$(curl $R -o /dev/null -w '%{http_code}' "$base/connect/?device=1")" = 200 ] || fail "$base/connect/?device=1 is not served"
  api=$(curl $R -o /dev/null -w '%{http_code}' "$base/api/status")
  [ "$api" = 200 ] || fail "$base/api/status answered $api: the upstream is no longer reached"
  log "ok: $base/connect/ (page, $asset, /api/status)"
done

rm -f /tmp/cgs-connect.$TAG.tgz /tmp/connect-page.$TAG /tmp/nginx-t.$TAG
# keep only the newest previous build
ls -dt $ROOT/connect.old.* 2>/dev/null | tail -n +2 | xargs -r rm -rf
log "deployed"
REMOTE
  then
    echo "!!! $k failed and was rolled back" >&2
    failed=1
  fi
done
exit $failed
