/**
 * Themes (`themes`): more themes for Settings → Look, beside Dovre's own. A theme here is only
 * palette tokens (`Pack.themes`, pack API 2.4): Dovre checks each one's contrast and writes its
 * styles itself, so this pack has no pages, no styles and no settings. Add it and pick one on Look;
 * take it away and the page wears the system's theme again.
 */
import type { Pack, PackTheme } from "dovre/pack.ts";

export const THEMES: PackTheme[] = [
  {
    // Moss on stone: grey-green paper, forest ink.
    id: "moss",
    label: "Moss",
    about: "green light",
    scheme: "light",
    tokens: {
      "--bg": "#f1f4ee", "--sky": "#e4eadf", "--surface": "#fcfdfa", "--surface-2": "#f4f7f1", "--hover": "#e9eee4",
      "--ink": "#18231a", "--ink-2": "#3a4a3d", "--ink-3": "#55655a",
      "--line": "#dfe6da", "--line-2": "#c5d0c0", "--control": "#788779",
      "--accent": "#1f6650", "--accent-ink": "#ffffff", "--accent-soft": "#e0eee8", "--accent-line": "#b3d1c5",
      "--ok": "#2f6b29", "--ok-soft": "#e2efdd", "--warn": "#8a5200", "--warn-soft": "#f6eed9", "--bad": "#ab1d39", "--bad-soft": "#f7e2e5",
      "--ridge-farthest": "#e2e9dd", "--ridge-far": "#c9d6c4", "--ridge-near": "#93a892", "--ridge-deep": "#748a75", "--ridge-edge": "#566a58",
      "--snow": "#fcfdfa", "--night": "#d9e2d4", "--star": "#fcfdfa", "--flag-bot": "#98a898",
    },
  },
  {
    // Paper: plain white and near-black, for bright rooms and projectors.
    id: "paper",
    label: "Paper",
    about: "high contrast light",
    scheme: "light",
    tokens: {
      "--bg": "#ffffff", "--sky": "#f2f2f2", "--surface": "#ffffff", "--surface-2": "#f6f6f6", "--hover": "#ececec",
      "--ink": "#000000", "--ink-2": "#262626", "--ink-3": "#454545",
      "--line": "#d9d9d9", "--line-2": "#b3b3b3", "--control": "#6b6b6b",
      "--accent": "#0b4a78", "--accent-ink": "#ffffff", "--accent-soft": "#e1ecf5", "--accent-line": "#a9c5dc",
      "--ok": "#235c1e", "--ok-soft": "#e3efe1", "--warn": "#7a4800", "--warn-soft": "#f7eeda", "--bad": "#9c1230", "--bad-soft": "#f8e1e5",
      "--ridge-farthest": "#ededed", "--ridge-far": "#d6d6d6", "--ridge-near": "#a3a3a3", "--ridge-deep": "#858585", "--ridge-edge": "#5c5c5c",
      "--snow": "#ffffff", "--night": "#e3e3e3", "--star": "#ffffff", "--flag-bot": "#a3a3a3",
    },
  },
  {
    // Dusk: the hour after sunset, violet-blue with lilac ink.
    id: "dusk",
    label: "Dusk",
    about: "violet dark",
    scheme: "dark",
    tokens: {
      "--bg": "#12101c", "--sky": "#181526", "--surface": "#1b182a", "--surface-2": "#211d33", "--hover": "#28233d",
      "--ink": "#ece9f5", "--ink-2": "#c0bbd3", "--ink-3": "#9c96b3",
      "--line": "#2c2742", "--line-2": "#3c3657", "--control": "#756f8f",
      "--accent": "#b3a5f2", "--accent-ink": "#120d24", "--accent-soft": "#27213f", "--accent-line": "#463c70",
      "--ok-soft": "#18281f", "--warn-soft": "#2d2418", "--bad-soft": "#331a24",
      "--ridge-farthest": "#1a1729", "--ridge-far": "#231f38", "--ridge-near": "#372f55", "--ridge-deep": "#221d37", "--ridge-edge": "#7d70a8",
      "--snow": "#d8d2ea", "--night": "#0c0a14", "--star": "#e6e0f5", "--flag-bot": "#5f567d", "--sun": "#d8d2ea",
    },
  },
  {
    // Granite: neutral grey with no blue in it, for screens that already run cool.
    id: "granite",
    label: "Granite",
    about: "grey dark",
    scheme: "dark",
    tokens: {
      "--bg": "#141414", "--sky": "#1a1a1a", "--surface": "#1e1e1e", "--surface-2": "#242424", "--hover": "#2b2b2b",
      "--ink": "#ededed", "--ink-2": "#c2c2c2", "--ink-3": "#9e9e9e",
      "--line": "#2e2e2e", "--line-2": "#3f3f3f", "--control": "#767676",
      "--accent-soft": "#1c2b36", "--accent-line": "#33526a",
      "--ok-soft": "#1b2a1c", "--warn-soft": "#2e2616", "--bad-soft": "#341c20",
      "--ridge-farthest": "#1b1b1b", "--ridge-far": "#252525", "--ridge-near": "#3a3a3a", "--ridge-deep": "#232323", "--ridge-edge": "#808080",
      "--snow": "#d6d6d6", "--night": "#0c0c0c", "--star": "#e6e6e6", "--flag-bot": "#666666", "--sun": "#d6d6d6",
    },
  },
];

export function createThemesPack(): Pack {
  return {
    manifest: {
      api: "2.4",
      version: "0.1.0",
      id: "themes",
      name: "Themes",
      description: "More themes for Settings → Look: Moss, Paper, Dusk and Granite",
      domain: "general",
      execution: "any",
    },
    themes: THEMES,
  };
}

export const themesPack = createThemesPack();
