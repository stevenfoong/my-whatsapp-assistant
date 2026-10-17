import { MODE_LABELS } from "../lib/prompts.js";

const $ = (id) => document.getElementById(id);
const tabId = Number(new URLSearchParams(location.search).get("tab")) || null;

const state = {
  chat: null, // { title, isGroup, target, messages }
  isNew: false,
  lastRequest: null, // { mode, intent }
  drafts: [],
  busy: false,
};

// ------------------------------------------------------------- tab helpers

async function activeTabId() {
  if (tabId) return tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function toContent(message) {
  const id = await activeTabId();
  if (!id) throw new Error("no-tab");
  return chrome.tabs.sendMessage(id, message);
}

// ------------------------------------------------------------- rendering

function setStatus(html, kind = "") {
  const el = $("status");
  if (!html) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.className = `status ${kind}`;
  el.innerHTML = html;
  if (kind === "error" || kind === "warn") el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function setBusy(busy) {
  state.busy = busy;
  for (const b of document.querySelectorAll("#actionCard button, #regenerate, #useLatest, #useNew")) {
    b.disabled = busy;
  }
}

function renderChat() {
  const c = state.chat;
  $("chatTitle").textContent = c?.title || "No chat selected";
  $("chatKind").hidden = !c;
  $("chatKind").textContent = c?.isGroup ? "Group" : "Chat";
  $("emptyHint").hidden = !!c;
  $("targetBox").hidden = !(c && c.target && !state.isNew);
  $("newBox").hidden = !(c && state.isNew);
  $("actionCard").hidden = !c;
  if (c?.target) {
    $("targetSender").textContent = c.target.sender || "them";
    $("targetText").textContent = c.target.text;
  }
  renderImages();
  $("modeButtons").hidden = state.isNew;
  $("intentLabel").textContent = state.isNew
    ? "What do you want to say?"
    : "Or say what you want to reply";
  $("intent").placeholder = state.isNew
    ? "e.g. remind everyone the VPN maintenance is tonight 11pm, about 15 minutes downtime"
    : "e.g. will check tonight and update tomorrow morning";
  $("draftCustom").textContent = state.isNew ? "Draft message" : "Draft from my note";
}

function renderImages() {
  const t = state.chat?.target;
  const images = t?.images || [];
  const expected = t?.imageCount || 0;
  $("imageBox").hidden = !(t && !state.isNew && (images.length || expected));
  const box = $("targetImages");
  box.innerHTML = "";
  for (const b64 of images) {
    const img = document.createElement("img");
    img.alt = "Image from the message";
    img.src = `data:image/jpeg;base64,${b64}`;
    box.appendChild(img);
  }
  $("includeImages").closest("label").hidden = images.length === 0;
  $("imageNote").hidden = images.length > 0;
  const justOpened = state.chat?.at && Date.now() - state.chat.at < 4000;
  if (!images.length && justOpened) {
    $("imageNote").textContent = "Reading the image…";
    clearTimeout(renderImages.timer);
    renderImages.timer = setTimeout(renderImages, 4000);
  } else {
    $("imageNote").textContent =
      "This message has an image, but it couldn't be read, so only the text is used. Open the photo " +
      "in WhatsApp once (so the full image loads), then click Draft again. Image sending can be " +
      "turned off in Settings.";
  }
}

// Bring new drafts into view and flash them briefly so they're easy to notice.
function revealResults() {
  const box = $("results");
  if (box.hidden) return;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
  box.classList.remove("flash");
  void box.offsetWidth; // restart the animation
  box.classList.add("flash");
  const first = box.querySelector(".draft textarea");
  if (first) first.focus({ preventScroll: true });
}

function renderDrafts() {
  const box = $("drafts");
  box.innerHTML = "";
  $("results").hidden = state.drafts.length === 0;
  if (!state.drafts.length) return;
  const req = state.lastRequest;
  $("resultsLabel").textContent = req ? MODE_LABELS[req.mode] || req.mode : "";
  const tpl = $("draftTpl");
  state.drafts.forEach((text, i) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    const ta = node.querySelector("textarea");
    ta.value = text;
    ta.rows = Math.min(8, Math.max(2, Math.ceil(text.length / 42)));
    ta.addEventListener("input", () => (state.drafts[i] = ta.value));
    node.querySelector(".copy").addEventListener("click", (e) => copyDraft(ta.value, e.target));
    node.querySelector(".insert").addEventListener("click", () => insertDraft(ta.value));
    box.appendChild(node);
  });
}

// ------------------------------------------------------------- actions

function loadChat(chat, { isNew = false } = {}) {
  state.chat = chat;
  state.isNew = isNew || !chat?.target;
  state.drafts = [];
  state.lastRequest = null;
  $("intent").value = "";
  for (const b of document.querySelectorAll("#modeButtons button")) b.classList.remove("active");
  setStatus("");
  renderChat();
  renderDrafts();
}

async function readFromPage(kind) {
  setStatus("");
  try {
    const res = await toContent({ type: kind });
    if (!res?.ok) {
      setStatus(res?.reason === "no-chat" ? "Open a chat in WhatsApp first." : "Couldn't read the chat.", "warn");
      return;
    }
    if (kind === "read-latest" && !res.payload.target) {
      loadChat(res.payload, { isNew: true });
      setStatus("No incoming messages found in view, so this will be a new message.", "warn");
      return;
    }
    loadChat(res.payload, { isNew: kind === "read-new" });
  } catch {
    setStatus("Can't reach WhatsApp Web in this tab. Reload the WhatsApp page (F5) and try again.", "warn");
  }
}

async function runDraft(mode, intent, { fresh = false } = {}) {
  if (!state.chat || state.busy) return;
  if ((mode === "custom" || mode === "new") && !intent.trim()) {
    setStatus("Type what you want to say first.", "warn");
    $("intent").focus();
    return;
  }
  for (const b of document.querySelectorAll("#modeButtons button")) {
    b.classList.toggle("active", b.dataset.mode === mode);
  }
  state.lastRequest = { mode, intent };
  setBusy(true);
  setStatus(`<span class="spinner"></span>Drafting (${esc(MODE_LABELS[mode])})…`);
  $("status").scrollIntoView({ behavior: "smooth", block: "nearest" });
  try {
    const res = await chrome.runtime.sendMessage({
      type: "draft",
      chat: state.chat,
      mode,
      intent,
      previousDrafts: fresh ? state.drafts : null,
      includeImages: $("includeImages").checked,
    });
    if (!res?.ok) {
      setStatus(esc(res?.error || "Something went wrong."), "error");
      return;
    }
    state.drafts = res.drafts;
    setStatus("");
    renderDrafts();
    revealResults();
  } catch (err) {
    setStatus(esc(`Something went wrong: ${err?.message || err}`), "error");
  } finally {
    setBusy(false);
  }
}

async function copyDraft(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = old), 1200);
  } catch {
    setStatus("Couldn't copy. Select the text and press Ctrl+C.", "warn");
  }
}

async function insertDraft(text, force = false) {
  try {
    const res = await toContent({ type: "insert", text, expectedChat: state.chat?.title, force });
    if (res?.ok) {
      setStatus("Inserted into the message box. Review it in WhatsApp and press Enter to send.");
      return;
    }
    if (res?.reason === "chat-changed") {
      setStatus(
        `WhatsApp now shows <b>${esc(res.current)}</b>, not <b>${esc(state.chat.title)}</b>.` +
          `<div class="row"><button id="insertAnyway" class="small">Insert into ${esc(res.current)} anyway</button></div>`,
        "warn",
      );
      $("insertAnyway").addEventListener("click", () => insertDraft(text, true));
      return;
    }
    if (res?.reason === "no-composer") {
      setStatus("Couldn't find the message box. Open the chat in WhatsApp first.", "warn");
      return;
    }
    setStatus("Couldn't insert automatically. Use Copy and paste it instead.", "warn");
  } catch {
    setStatus("Can't reach WhatsApp Web in this tab. Reload the WhatsApp page (F5) and try again.", "warn");
  }
}

// ------------------------------------------------------------- wiring

for (const b of document.querySelectorAll("#modeButtons button")) {
  b.addEventListener("click", () => runDraft(b.dataset.mode, ""));
}
$("draftCustom").addEventListener("click", () =>
  runDraft(state.isNew ? "new" : "custom", $("intent").value),
);
$("intent").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("draftCustom").click();
});
$("regenerate").addEventListener("click", () => {
  if (state.lastRequest) runDraft(state.lastRequest.mode, state.lastRequest.intent, { fresh: true });
});
$("useLatest").addEventListener("click", () => readFromPage("read-latest"));
$("useNew").addEventListener("click", () => readFromPage("read-new"));
$("openSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());

async function loadStoredTarget() {
  const id = await activeTabId();
  if (!id) return;
  const key = `target:${id}`;
  const stored = await chrome.storage.session.get(key);
  if (stored[key]) loadChat(stored[key]);
  chrome.storage.onChanged.addListener((changes, area) => {
    const next = changes[key]?.newValue;
    if (area !== "session" || !next) return;
    if (state.chat && next.at && next.at === state.chat.at) {
      // Same message, images arrived a moment later: keep drafts and notes.
      state.chat = next;
      renderImages();
    } else {
      loadChat(next);
    }
  });
}

renderChat();
loadStoredTarget();
