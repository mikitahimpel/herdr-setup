#!/bin/sh
# Copies the setup from this Mac's Herdr folder into the repo.
set -eu
repo=$(cd "$(dirname "$0")" && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
filters="--exclude=.cache --exclude=gpui-kit.d.ts --exclude=jsconfig.json --exclude=.DS_Store --exclude=.toast-original.js"

mkdir -p "$repo/mods" "$repo/layouts" "$repo/themes"
rsync -a --delete $filters "$home"/mods/sleeve-* "$repo/mods/"
for mod in tree top places menu toast pane confirm; do
  rsync -a --delete $filters "$home/mods/grove-$mod" "$repo/mods/"
done
cp "$home"/layouts/sleeve.json "$home"/layouts/sleeve.svg "$home"/layouts/grove.json "$repo/layouts/"
cp "$home"/themes/sleeve.json "$home"/themes/sleeve-paper.json "$home"/themes/grove.json "$repo/themes/"
cp "$home"/keys.json "$home"/programs.json "$home"/settings.json "$repo/"
