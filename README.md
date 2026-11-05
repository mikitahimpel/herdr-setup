# Herdr setup

My Herdr desktop layout: the `sleeve` layout and theme, its 14 mods, keys and settings.

## Install on another Mac

1. Install Herdr and open it once, so it creates `~/.config/herdr-app`.
2. Install the tools it uses:

   ```sh
   brew install difftastic
   ```

   `agent-history` powers conversation search. It comes from
   [wayback](https://github.com/mikitahimpel/wayback) and must be on your `PATH`.
   Without it, the search popup still lists recent conversations.
   `python3` is needed too, for the session preview and the Images panel.

3. Clone this repo and run `./install.sh`.

The script replaces `keys.json`, `programs.json` and `settings.json`, keeping the old
versions as `<name>.bak-<time>`, then switches Herdr to the `sleeve` layout.

## Update

- On the Mac with the changes: run `./export.sh`, then commit and push.
- On the other Mac: `git pull`, then `./install.sh`.

## What's left out

Runtime state stays on each Mac: spaces, window position, sidebar width and the image cache. Herdr's own mods aren't here because Herdr installs them.
