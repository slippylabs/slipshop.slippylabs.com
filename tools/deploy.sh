#!/usr/bin/env bash
# Publish SlipShop to /var/www/slipshop.slippylabs.com.
#
# Adapted from SlipStudio's deploy.sh, and it keeps all four of the properties
# that script learned the hard way:
#
#  * THE JS TREE GOES UNDER js/b<N>/. An ES-module import carries no query
#    string, so bumping ?v= on the entry script does nothing for the sixty
#    modules it pulls in, and the edge serves the previous ones for hours.
#    N is the commit count, so it moves on every release.
#  * THE TWO NEWEST BUILDS ARE KEPT, so a page loaded mid-deploy does not 404
#    halfway through its import graph.
#  * EVERYTHING IS STAGED OUTSIDE /var/www AND MOVED IN. The estate's inotify
#    gzip-static watcher races `rm -rf` inside /var/www, and `rm -rf` exits 0
#    with nothing on stderr while leaving orphaned .gz files behind.
#  * A DIRTY TREE IS REFUSED, so the build number means something.
#
# style.css is NOT under js/b<N>/ -- it ships at the docroot and is busted by
# the ?v= in index.html, which has to be bumped by hand with any CSS change.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST=/var/www/slipshop.slippylabs.com
BUILD="b$(git -C "$SRC" rev-list --count HEAD)"

if [ -n "$(git -C "$SRC" status --porcelain 2>/dev/null)" ]; then
  echo "!! uncommitted changes -- commit first so the build number means something" >&2
  git -C "$SRC" status --short >&2
  exit 1
fi

STAGE=$(sudo mktemp -d /var/tmp/slipshop-deploy.XXXXXX)
cleanup() { sudo rm -rf "$STAGE" 2>/dev/null || true; }
trap cleanup EXIT

sudo mkdir -p "$DST/js"

# --- the module tree, under its build number ---
sudo mkdir -p "$STAGE/$BUILD"
sudo cp -r "$SRC/js/." "$STAGE/$BUILD/"
if [ -d "$DST/js/$BUILD" ]; then sudo mv "$DST/js/$BUILD" "$STAGE/old-$BUILD"; fi
sudo mv "$STAGE/$BUILD" "$DST/js/$BUILD"

# --- index.html, with its script src rewritten to this build ---
sudo python3 - "$SRC/index.html" "$STAGE/index.html" "$BUILD" <<'PY'
import re, sys
src, dst, build = sys.argv[1], sys.argv[2], sys.argv[3]
html = open(src).read()
before = html
html = re.sub(r'src="js/(?!b\d+/)([^"]*?)(\?v=\d+)?"', lambda m: f'src="js/{build}/{m.group(1)}"', html)
if html == before:
    print("!! nothing rewritten -- is the module script tag still src=\"js/...\"?", file=sys.stderr)
    sys.exit(1)
open(dst, "w").write(html)
PY
sudo cp "$STAGE/index.html" "$DST/index.html"

# --- the rest of the docroot ---
sudo cp "$SRC/style.css" "$DST/style.css"
[ -f "$SRC/og-image.png" ] && sudo cp "$SRC/og-image.png" "$DST/og-image.png"

# --- prune: anything that is not a build dir, and all but the newest two ---
mapfile -t olds < <(sudo find "$DST/js" -maxdepth 1 -mindepth 1 -type d -printf '%f\n' | grep -E '^b[0-9]+$' | sort -t b -k2 -n | head -n -2)
for d in "${olds[@]:-}"; do
  [ -n "$d" ] || continue
  sudo mv "$DST/js/$d" "$STAGE/prune-$d"
done
sudo find "$DST/js" -maxdepth 1 -mindepth 1 -not -name 'b[0-9]*' -exec mv {} "$STAGE/" \; 2>/dev/null || true

sudo chown -R root:root "$DST"
sudo find "$DST" -type d -exec chmod 755 {} +
sudo find "$DST" -type f -exec chmod 644 {} +

# Pre-compress the stylesheet for gzip_static, as every other tool site does.
sudo gzip -9 -k -f "$DST/style.css"
sudo chown root:root "$DST/style.css.gz"
sudo chmod 644 "$DST/style.css.gz"

# The gzip watcher debounces 5 s; give it time, then check nothing is stale.
sleep 8
if [ -x "$HOME/tools/bin/check-stale-gz.sh" ]; then
  if ! "$HOME/tools/bin/check-stale-gz.sh" --quiet; then
    echo "!! stale or orphaned .gz under /var/www -- run ~/tools/bin/check-stale-gz.sh --fix" >&2
    exit 1
  fi
fi

echo "deployed $BUILD to $DST"
echo "builds kept: $(sudo ls "$DST/js" | tr '\n' ' ')"
