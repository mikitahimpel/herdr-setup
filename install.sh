#!/bin/sh
# Installs the setup into Herdr. Files it replaces are kept as <name>.bak-<time>.
set -eu
repo=$(cd "$(dirname "$0")" && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
stamp=$(date +%Y%m%d-%H%M%S)

if [ ! -d "$home/mods" ]; then
  echo "Open Herdr once first: $home isn't set up yet." >&2
  exit 1
fi

for tool in agent-history difft gh glab; do
  command -v "$tool" >/dev/null || echo "Missing $tool (see README)."
done

for file in keys.json programs.json settings.json; do
  if [ -f "$home/$file" ] && ! cmp -s "$repo/$file" "$home/$file"; then
    cp "$home/$file" "$home/$file.bak-$stamp"
  fi
  cp "$repo/$file" "$home/$file"
done

mkdir -p "$home/layouts" "$home/themes"
cp "$repo"/themes/*.json "$home/themes/"
cp "$repo"/layouts/* "$home/layouts/"
for mod in "$repo"/mods/*; do
  rsync -a --delete --exclude=.cache --exclude=gpui-kit.d.ts --exclude=jsconfig.json "$mod/" "$home/mods/$(basename "$mod")/"
done

if [ -z "${HERDR_APP_HOME:-}" ] && command -v herdr-app >/dev/null; then
  herdr-app do layout.switch --name sleeve >/dev/null 2>&1 || echo "Pick the sleeve layout in Herdr (ctrl-shift-l)."
fi
echo "Installed into $home."
