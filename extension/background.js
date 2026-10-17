// Service worker: side panel wiring, model calls, and the Origin-header rule.
import { buildPrompt } from "./lib/prompts.js";
import { callModel, LLMError } from "./lib/llm.js";
import { loadSettings } from "./lib/settings.js";

const WA = "https://web.whatsapp.com/";
const isWhatsApp = (url) => typeof url === "string" && url.startsWith(WA);

// ---- side panel: only on WhatsApp tabs ----------------------------------

async function configureTab(tabId, url) {
  try {
    if (isWhatsApp(url)) {
      await chrome.sidePanel.setOptions({
        tabId,
        path: `sidepanel/panel.html?tab=${tabId}`,
        enabled: true,
      });
    } else {
      await chrome.sidePanel.setOptions({ tabId, enabled: false });
    }
  } catch (e) {
    // tab closed meanwhile
  }
}

async function init() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  await chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) await configureTab(t.id, t.url);
  await updateOriginRule();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === "complete") configureTab(tabId, tab.url);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`target:${tabId}`).catch(() => {});
});

// ---- Ollama refuses browser-extension origins by default -----------------
// Strip the Origin header from this extension's own requests to the model
// endpoint, so Ollama behind a tunnel accepts them without OLLAMA_ORIGINS.

const ORIGIN_RULE_ID = 1;

async function updateOriginRule() {
  const { endpoint } = await loadSettings();
  const removeRuleIds = [ORIGIN_RULE_ID];
  let addRules = [];
  try {
    if (endpoint) {
      const u = new URL(endpoint);
      addRules = [
        {
          id: ORIGIN_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [{ header: "origin", operation: "remove" }],
          },
          condition: {
            urlFilter: `|${u.protocol}//${u.host}/`,
            initiatorDomains: [chrome.runtime.id],
            resourceTypes: ["xmlhttprequest", "other"],
          },
        },
      ];
    }
  } catch {
    addRules = [];
  }
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (e) {
    console.warn("Could not update Origin rule", e);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) updateOriginRule();
});

// ---- messages -------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "open-target" && sender.tab) {
    const tabId = sender.tab.id;
    // open() must run before any await to keep the click's user gesture.
    const opening = (async () => chrome.sidePanel.open({ tabId }))();
    const storing = chrome.storage.session.set({ [`target:${tabId}`]: { ...msg.payload, at: Date.now() } });
    Promise.allSettled([opening, storing]).then(([o]) =>
      sendResponse({ ok: true, opened: o.status === "fulfilled" }),
    );
    return true;
  }

  if (msg?.type === "draft") {
    draft(msg)
      .then((drafts) => sendResponse({ ok: true, drafts }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err instanceof LLMError ? err.message : `Unexpected error: ${err?.message || err}`,
        }),
      );
    return true;
  }
  return false;
});

async function draft({ chat, mode, intent, previousDrafts }) {
  const settings = await loadSettings();
  const draftCount = Math.max(1, Math.min(5, Number(settings.draftCount) || 3));
  const { system, user } = buildPrompt({
    prompts: settings.prompts,
    mode,
    chat,
    intent: (intent || "").trim(),
    draftCount,
    previousDrafts,
  });
  return callModel({ ...settings, draftCount }, system, user);
}
