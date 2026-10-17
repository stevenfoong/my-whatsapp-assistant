import { PROMPT_DEFAULTS, PROMPT_KEYS } from "../lib/prompts.js";
import { SETTINGS_DEFAULTS, loadSettings, saveSettings, originPattern } from "../lib/settings.js";

const $ = (id) => document.getElementById(id);
const FIELDS = ["endpoint", "api", "model", "think", "temperature", "timeout", "draftCount", "contextCount", "myNames"];

const PROMPT_TITLES = {
  about_me: "About me",
  style: "Style",
  rules: "Rules",
  mode_reply: "Reply mode",
  mode_ack: "Acknowledge mode",
  mode_gather: "Gather info mode",
  mode_custom: "Custom mode (your note)",
  mode_new: "New message mode",
};

function setStatus(text, kind = "") {
  const el = $("status");
  el.hidden = !text;
  el.className = `status ${kind}`;
  el.textContent = text || "";
}

function addHeaderRow(name = "", value = "") {
  const node = $("headerTpl").content.firstElementChild.cloneNode(true);
  const n = node.querySelector(".h-name");
  const v = node.querySelector(".h-value");
  n.value = name;
  v.value = value;
  node.querySelector(".h-show").addEventListener("click", (e) => {
    v.type = v.type === "password" ? "text" : "password";
    e.target.textContent = v.type === "password" ? "Show" : "Hide";
  });
  node.querySelector(".h-del").addEventListener("click", () => node.remove());
  $("headers").appendChild(node);
}

function readHeaders() {
  return [...document.querySelectorAll(".header-row")]
    .map((r) => ({ name: r.querySelector(".h-name").value.trim(), value: r.querySelector(".h-value").value.trim() }))
    .filter((h) => h.name);
}

function buildPromptFields(saved) {
  const box = $("prompts");
  box.innerHTML = "";
  for (const key of PROMPT_KEYS) {
    const label = document.createElement("label");
    label.textContent = PROMPT_TITLES[key] || key;
    const ta = document.createElement("textarea");
    ta.id = `p_${key}`;
    ta.rows = Math.max(key === "about_me" || key === "style" ? 6 : 3, Math.ceil(PROMPT_DEFAULTS[key].length / 85) + 1);
    ta.placeholder = PROMPT_DEFAULTS[key];
    ta.value = saved[key] || "";
    label.appendChild(ta);
    box.appendChild(label);
  }
}

function collect() {
  const s = { ...SETTINGS_DEFAULTS };
  for (const f of FIELDS) s[f] = $(f).value.trim();
  for (const f of ["temperature", "timeout", "draftCount", "contextCount"]) {
    const n = Number(s[f]);
    s[f] = Number.isFinite(n) && s[f] !== "" ? n : SETTINGS_DEFAULTS[f];
  }
  s.model = s.model || SETTINGS_DEFAULTS.model;
  s.endpoint = s.endpoint.replace(/\/+$/, "");
  s.highlight = $("highlight").checked;
  s.headers = readHeaders();
  s.prompts = {};
  for (const key of PROMPT_KEYS) {
    const v = $(`p_${key}`).value.trim();
    if (v) s.prompts[key] = v;
  }
  return s;
}

async function fill() {
  const s = await loadSettings();
  for (const f of FIELDS) $(f).value = s[f] ?? "";
  $("highlight").checked = !!s.highlight;
  $("headers").innerHTML = "";
  for (const h of s.headers || []) addHeaderRow(h.name, h.value);
  buildPromptFields(s.prompts || {});
}

/** Save; asks Chrome for access to the endpoint (must run inside the click). */
function save() {
  const s = collect();
  let pattern;
  try {
    pattern = originPattern(s.endpoint);
  } catch {
    setStatus("Enter a valid endpoint URL, e.g. https://gemma.example.com", "error");
    return Promise.resolve(false);
  }
  return chrome.permissions
    .request({ origins: [pattern] })
    .then(async (granted) => {
      await saveSettings(s);
      if (!granted) {
        setStatus("Saved, but Chrome access to the endpoint was not granted, so drafting will fail. Save again and click Allow.", "warn");
        return false;
      }
      setStatus("Saved.");
      return true;
    })
    .catch(async (err) => {
      await saveSettings(s);
      setStatus(`Saved, but couldn't request access: ${err.message}`, "warn");
      return false;
    });
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  save();
});

$("test").addEventListener("click", async () => {
  const ok = await save();
  if (!ok) return;
  setStatus("Testing… (the first request can take a while if the model is loading)");
  const res = await chrome.runtime.sendMessage({
    type: "draft",
    mode: "ack",
    intent: "",
    chat: {
      title: "Connection test",
      isGroup: false,
      messages: [],
      target: { sender: "Alex", text: "Hi, can you reset my VPN access? It stopped working this morning." },
    },
  });
  if (res?.ok) setStatus(`Connected. Sample draft: ${res.drafts[0]}`);
  else setStatus(res?.error || "Test failed.", "error");
});

$("addHeader").addEventListener("click", () => addHeaderRow());
$("addCf").addEventListener("click", () => {
  const have = readHeaders().map((h) => h.name.toLowerCase());
  if (!have.includes("cf-access-client-id")) addHeaderRow("CF-Access-Client-Id", "");
  if (!have.includes("cf-access-client-secret")) addHeaderRow("CF-Access-Client-Secret", "");
});

fill();
