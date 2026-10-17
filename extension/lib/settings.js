// Settings live in chrome.storage.local on this computer only.

export const SETTINGS_DEFAULTS = {
  endpoint: "",
  api: "ollama", // "ollama" | "openai"
  model: "gemma4:e4b",
  headers: [], // [{name, value}] e.g. CF-Access-Client-Id / CF-Access-Client-Secret
  think: "", // "" (model default) | "true" | "false"
  temperature: 0.6,
  timeout: 120,
  draftCount: 3,
  contextCount: 20,
  myNames: "", // comma-separated names/nicknames that count as mentioning you
  highlight: true,
  prompts: {}, // overrides for PROMPT_DEFAULTS keys
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...SETTINGS_DEFAULTS, ...(stored.settings || {}) };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

export function originPattern(endpoint) {
  const u = new URL(endpoint);
  return `${u.protocol}//${u.host}/*`;
}
