// Mute: Herdr's attention sounds off (settings.json sounds.enabled), which grove-toast also
// reads to drop agents' notifications. Settings > Alerts shows and changes the same switch.

import { settings, appHome, readTextFile, writeTextFile } from "herdr";

export const muted = () => settings()?.sounds?.enabled === false;

export async function toggleMute() {
  const path = `${appHome()}/settings.json`;
  const text = await readTextFile(path);
  const s = text ? JSON.parse(text) : {};
  s.sounds = { ...(s.sounds ?? {}), enabled: s.sounds?.enabled === false };
  await writeTextFile(path, JSON.stringify(s, null, 2) + "\n", text);
}
