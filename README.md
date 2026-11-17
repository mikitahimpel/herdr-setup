# Herdr setup

My Herdr desktop layouts, their themes and mods, keys and settings:

- `sleeve`: the everyday layout.
- `grove`: a Rex-style sidebar. Groups are spaces (one per repo and machine, at the repo's
  main checkout), tabs sit under a line per branch they work in, sub-agents fold into a
  count. + (⌘N) asks where the new session starts; right-click + or a row for Codex, a
  terminal and the rest. The bell (⌘⇧M) mutes agents' sounds and notifications. Switch
  with ctrl-shift-l.
- `skills/herdr-placement`: how agents start tasks so they land in that layout (a tab per
  task in the repo's space, in its worktree).

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
versions as `<name>.bak-<time>`, links the skills into `~/.claude/skills`, then switches
Herdr to the `sleeve` layout.

## Update

- On the Mac with the changes: run `./export.sh`, then commit and push.
- On the other Mac: `git pull`, then `./install.sh`.

## Claude after a reboot

herdr-core keeps panes alive while the window is closed, but a reboot or logout ends
their programs: each pane comes back as a shell in its last folder. `sleeve-resume`
remembers which panes ran Claude Code and in which session. When one comes back as a
shell, a card at the top offers to run `claude --resume <session>` there with the same
`--model` and permission flags. Panes where Claude simply exited are not offered.

## Sidebar

`sleeve-spaces` draws machine → repo → space → tab, worked out from git alone
(`tree.js`, tested by `node tree.test.mjs`). A space whose tabs work on different
branches lists them under one row per branch. Resting on a row opens a card with the
full name, the agent's state, the branch, folder, uncommitted files and last commit.
While scrolling, the rows a part of the tree hangs under stay on top.
`Cmd-Shift-E` moves the keyboard into the list: arrows move and fold, Enter goes there,
Esc goes back.

## Ask Claude

`Cmd-Shift-N`, "Ask Claude…" at the top of the + menu or in the palette, or "Ask Claude
here…" on a space's or tab's right-click menu: one line for a question or a problem.
It starts in the space the text names (else the shown one; ↑/↓ picks another). Enter
starts Claude in a new tab there; Cmd-Enter in a new worktree of that space's repo.

Right-click menus also have "Copy ID": a name and its hc address, such as
`perf-tabs (t5j)`, to tell an agent in Herdr which one you mean.

## Screenshots into a terminal

Dragging a screenshot thumbnail into a terminal pastes nothing, because macOS keeps that
file in a protected folder. `sleeve-drop` shows a drop target while such a drag is on,
and `sleeve-pane` copies the file somewhere readable and pastes its path.

## What's left out

Runtime state stays on each Mac: spaces, window position, sidebar width and the image cache. Herdr's own mods aren't here because Herdr installs them.
