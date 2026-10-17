// Content script for web.whatsapp.com.
// Reads ONLY the chat that is open, and only when you click. It never presses send.
(() => {
  "use strict";
  if (window.__waAssistantLoaded) return;
  window.__waAssistantLoaded = true;

  // WhatsApp changes its page structure from time to time. All selectors live
  // here so a breakage can be fixed in one place.
  const SEL = {
    main: "#main",
    header: "#main header",
    titleCandidates: [
      '#main [data-testid="conversation-info-header-chat-title"]',
      '#main header [data-testid="conversation-info-header-chat-title"]',
      '#main header span[dir="auto"][title]',
      '#main header span[dir="auto"]',
    ],
    row: "[data-id]",
    // Older WhatsApp builds mark direction with these classes...
    bubbleIn: ".message-in",
    bubbleOut: ".message-out",
    // ...newer ones only have a bubble "tail" on the first message of a run.
    tailIn: '[data-testid="tail-in"]',
    tailOut: '[data-testid="tail-out"]',
    container: '[data-testid="msg-container"]',
    panel: '[data-testid="conversation-panel-messages"]',
    meta: "[data-pre-plain-text]",
    textSpan: "span.selectable-text",
    quoted: 'div[role="button"]',
    composer: [
      '#main [data-testid="conversation-compose-box-input"]',
      '#main footer div[contenteditable="true"][role="textbox"]',
      '#main footer div[contenteditable="true"]',
    ],
  };
  const OLD_ROW_ID = /^(true|false)_/;

  // A message row: has a data-id, and either the old "true_/false_" id format
  // or (newer WhatsApp) a message bubble / text inside it.
  function isMessageRow(el) {
    const id = el?.getAttribute?.("data-id");
    if (!id) return false;
    if (OLD_ROW_ID.test(id)) return true;
    return !!(el.querySelector("[data-pre-plain-text]") || el.querySelector('[data-testid="msg-container"]'));
  }

  let settings = { myNames: "", highlight: true, contextCount: 20, sendImages: true };
  const IMG_MAX = 1024; // longest side, in pixels, of images sent to the AI
  const IMG_LIMIT = 2; // images per message

  function loadSettings() {
    try {
      chrome.storage.local.get("settings", (s) => {
        settings = { ...settings, ...(s.settings || {}) };
        scheduleHighlight();
      });
    } catch {
      /* extension was reloaded; this old script is orphaned */
    }
  }
  loadSettings();
  try {
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === "local" && c.settings) loadSettings();
    });
  } catch {}

  // ---------------------------------------------------------------- reading

  function $(sel, root = document) {
    return root.querySelector(sel);
  }

  function chatTitle() {
    for (const s of SEL.titleCandidates) {
      const el = $(s);
      const t = el && (el.getAttribute("title") || el.textContent || "").trim();
      if (t) return t;
    }
    return "";
  }

  // Visible text, keeping emoji (WhatsApp renders them as <img alt="😀">).
  function textOf(el) {
    let out = "";
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) out += child.nodeValue;
        else if (child.nodeName === "IMG") out += child.getAttribute("alt") || "";
        else if (child.nodeName === "BR") out += "\n";
        else if (child.nodeType === Node.ELEMENT_NODE) walk(child);
      }
    };
    walk(el);
    return out.replace(/⁨|⁩/g, "").trim();
  }

  function messageRows() {
    const main = $(SEL.main);
    if (!main) return [];
    const all = [...main.querySelectorAll(SEL.row)].filter(isMessageRow);
    // Drop rows nested inside another row (e.g. quoted previews).
    return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
  }

  function bubbleOf(row) {
    return $(SEL.bubbleIn, row) || $(SEL.bubbleOut, row) || $(SEL.container, row) || row;
  }

  /** true = sent by me. Tries explicit markers first, then which side the bubble is on. */
  function isMine(row) {
    const id = row.getAttribute("data-id") || "";
    if (id.startsWith("true_")) return true;
    if (id.startsWith("false_")) return false;
    if ($(SEL.bubbleOut, row) || $(SEL.tailOut, row)) return true;
    if ($(SEL.bubbleIn, row) || $(SEL.tailIn, row)) return false;
    const bubble = bubbleOf(row).getBoundingClientRect();
    const area = ($(SEL.panel) || $(SEL.main)).getBoundingClientRect();
    if (!bubble.width || !area.width) return false;
    return bubble.left - area.left > area.right - bubble.right;
  }

  function parseRow(row) {
    const id = row.getAttribute("data-id");
    const mine = isMine(row);
    const isGroupRow = /@g\.us/.test(id);
    const meta = $(SEL.meta, row);
    let sender = "";
    let text = "";
    let quotedAuthor = "";
    let quotedText = "";

    if (meta) {
      const pre = meta.getAttribute("data-pre-plain-text") || "";
      const m = pre.match(/\]\s*(.*?):\s*$/);
      if (m) sender = m[1].trim();
      const quoted = $(SEL.quoted, meta);
      if (quoted) {
        const spans = quoted.querySelectorAll('span[dir="auto"], span.quoted-mention');
        if (spans.length) quotedAuthor = textOf(spans[0]);
        const q = quoted.querySelector("span.quoted-mention") || spans[spans.length - 1];
        if (q) quotedText = textOf(q);
      }
      const spans = [...meta.querySelectorAll(SEL.textSpan)].filter(
        (s) => !(quoted && quoted.contains(s)),
      );
      text = spans.map(textOf).filter(Boolean).join("\n");
      if (!text) text = textOf(meta).replace(quotedAuthor, "").replace(quotedText, "").trim();
    }
    const imageCount = imageElements(row).length;
    if (imageCount) text = text ? `[image] ${text}` : "[image]";
    if (!text) text = "[media or non-text message]";
    return {
      id,
      mine,
      isGroupRow,
      sender: mine ? "Me" : sender || "Them",
      text,
      quotedAuthor,
      quotedText,
      imageCount,
    };
  }

  // ---------------------------------------------------------------- images

  // Quoted-reply previews (which can contain a small thumbnail of the quoted
  // photo). Photos themselves also sit in a clickable role="button" area, so
  // only blocks that look like quotes are excluded.
  function quotedBlocks(row) {
    return [...row.querySelectorAll('[role="button"]')].filter(
      (b) => b.querySelector(".quoted-mention") || b.closest("[data-pre-plain-text]"),
    );
  }

  function bigEnough(el) {
    const r = el.getBoundingClientRect();
    return r.width >= 60 && r.height >= 60;
  }

  /** Photos inside a message (not emoji, avatars or quoted previews). */
  function imageElements(row) {
    const quoted = quotedBlocks(row);
    const inQuote = (el) => quoted.some((q) => q.contains(el));
    const out = [...row.querySelectorAll("img")].filter((img) => !inQuote(img) && bigEnough(img));
    if (out.length) return out;
    // Some builds draw the photo as a CSS background instead of an <img>.
    for (const el of row.querySelectorAll('[style*="background-image"]')) {
      const m = /url\(["']?(.*?)["']?\)/.exec(el.style.backgroundImage || "");
      if (m && !inQuote(el) && bigEnough(el)) out.push({ src: m[1] });
    }
    return out;
  }

  function drawToJpeg(source, w, h) {
    const scale = Math.min(1, IMG_MAX / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // transparent PNGs become white, not black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
  }

  async function imageToBase64(img) {
    if (!(img instanceof HTMLImageElement)) {
      const el = new Image();
      el.src = img.src;
      img = el;
    }
    try {
      if (img.decode) await img.decode().catch(() => {});
      if (img.naturalWidth) return drawToJpeg(img, img.naturalWidth, img.naturalHeight);
    } catch {
      /* canvas refused (cross-origin image); try fetching the bytes instead */
    }
    try {
      const blob = await (await fetch(img.currentSrc || img.src)).blob();
      const bmp = await createImageBitmap(blob);
      return drawToJpeg(bmp, bmp.width, bmp.height);
    } catch {
      return null;
    }
  }

  async function imagesOf(row) {
    if (!row || settings.sendImages === false) return [];
    const out = [];
    for (const img of imageElements(row).slice(0, IMG_LIMIT)) {
      const b64 = await imageToBase64(img);
      if (b64) out.push(b64);
    }
    return out;
  }

  function rowById(id) {
    return messageRows().find((r) => r.getAttribute("data-id") === id) || null;
  }

  function forContext(m) {
    let text = m.text;
    if (m.quotedAuthor && m.quotedText) {
      text = `(replying to ${m.quotedAuthor}: "${m.quotedText.slice(0, 120)}") ${text}`;
    }
    return { sender: m.sender, text, mine: m.mine, imageCount: m.imageCount || 0 };
  }

  /** Read the open chat. targetRow = the message to answer (null for a new message). */
  function readChat(targetRow, { latest = false } = {}) {
    const rows = messageRows();
    const parsed = rows.map(parseRow);
    const isGroup = chatIsGroup(parsed);
    const title = chatTitle();
    if (!isGroup && title) {
      for (const m of parsed) if (!m.mine && m.sender === "Them") m.sender = title;
    }
    let idx = -1;
    if (targetRow) idx = rows.indexOf(targetRow);
    else if (latest) {
      for (let i = parsed.length - 1; i >= 0; i--) {
        if (!parsed[i].mine) {
          idx = i;
          break;
        }
      }
    }
    const limit = Math.max(1, Math.min(100, Number(settings.contextCount) || 20));
    let target = null;
    let history;
    if (idx >= 0) {
      target = forContext(parsed[idx]);
      target.id = parsed[idx].id;
      history = parsed.slice(Math.max(0, idx - limit), idx);
    } else {
      history = parsed.slice(-limit);
    }
    return {
      title,
      isGroup,
      target,
      messages: history.map(forContext),
    };
  }

  // Newer WhatsApp ids don't say whether a chat is a group, so a chat counts as a
  // group when the old marker is there or more than one other person has written.
  function chatIsGroup(parsed) {
    if (parsed.some((m) => m.isGroupRow)) return true;
    const senders = new Set(parsed.filter((m) => !m.mine && m.sender !== "Them").map((m) => m.sender));
    return senders.size > 1;
  }

  // ------------------------------------------------- "for me" highlighting

  function names() {
    return (settings.myNames || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function isForMe(m, nameList) {
    if (m.mine) return false;
    if (m.quotedAuthor && /^you$/i.test(m.quotedAuthor.trim())) return true;
    return nameList.some((n) => {
      const ascii = /^[\w].*[\w]$|^\w$/.test(n);
      const re = ascii
        ? new RegExp(`(^|[^\\w])@?${escapeRe(n)}(?![\\w])`, "i")
        : new RegExp(escapeRe(n), "i");
      return re.test(m.text);
    });
  }

  let highlightTimer = null;
  function scheduleHighlight() {
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(highlight, 400);
  }

  function highlight() {
    const rows = messageRows();
    const nameList = names();
    const parsed = rows.map(parseRow);
    const group = chatIsGroup(parsed);
    rows.forEach((row, i) => {
      const on = settings.highlight && group && isForMe(parsed[i], nameList);
      row.classList.toggle("wa-asst-forme", !!on);
    });
  }

  new MutationObserver(scheduleHighlight).observe(document.body, { childList: true, subtree: true });

  // ------------------------------------------------------- hover button

  const btn = document.createElement("button");
  btn.className = "wa-asst-btn";
  btn.type = "button";
  btn.textContent = "✎ Draft";
  btn.title = "Draft a reply to this message";
  btn.style.display = "none";
  document.documentElement.appendChild(btn);

  const toast = document.createElement("div");
  toast.className = "wa-asst-toast";
  toast.style.display = "none";
  document.documentElement.appendChild(toast);

  function showToast(msg) {
    toast.textContent = msg;
    toast.style.display = "block";
    clearTimeout(showToast.t);
    showToast.t = setTimeout(() => (toast.style.display = "none"), 4000);
  }

  let hoverRow = null;
  let hideTimer = null;

  function placeButton(row) {
    const rect = bubbleOf(row).getBoundingClientRect();
    if (!rect.width) return;
    const incoming = !isMine(row);
    btn.style.display = "block";
    const w = btn.offsetWidth || 64;
    const left = incoming ? rect.right + 6 : rect.left - w - 6;
    btn.style.left = `${Math.max(4, Math.min(window.innerWidth - w - 4, left))}px`;
    btn.style.top = `${Math.max(4, rect.top + 2)}px`;
  }

  document.addEventListener(
    "mouseover",
    (e) => {
      if (e.target === btn) {
        clearTimeout(hideTimer);
        return;
      }
      let row = e.target.closest && e.target.closest(`${SEL.main} ${SEL.row}`);
      // Quoted previews can carry their own data-id; use the outer message row.
      while (row && !isMessageRow(row)) row = row.parentElement?.closest(`${SEL.main} ${SEL.row}`);
      if (row) {
        clearTimeout(hideTimer);
        hoverRow = row;
        placeButton(row);
      } else if (btn.style.display !== "none") {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          btn.style.display = "none";
          hoverRow = null;
        }, 350);
      }
    },
    true,
  );
  document.addEventListener("scroll", () => (btn.style.display = "none"), true);

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!hoverRow) return;
    const row = hoverRow;
    const payload = readChat(row);
    btn.style.display = "none";
    try {
      // Text first (keeps the click's permission to open the panel), images follow.
      chrome.runtime.sendMessage({ type: "open-target", payload }, (res) => {
        if (chrome.runtime.lastError) {
          showToast("Reply Assistant was updated. Reload this page (F5) to use it.");
          return;
        }
        if (res && res.opened === false) {
          showToast("Click the Reply Assistant icon in the toolbar to open the panel.");
        }
        if (payload.target?.imageCount) {
          imagesOf(row).then((images) => {
            if (images.length) {
              chrome.runtime.sendMessage({ type: "target-images", id: payload.target.id, images });
            }
          });
        }
      });
    } catch {
      showToast("Reply Assistant was updated. Reload this page (F5) to use it.");
    }
  });

  // ------------------------------------------------------- inserting

  function composer() {
    for (const s of SEL.composer) {
      const el = $(s);
      if (el) return el;
    }
    return null;
  }

  function insertText(text) {
    const box = composer();
    if (!box) return { ok: false, reason: "no-composer" };
    box.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(box);
    sel.removeAllRanges();
    sel.addRange(range);

    // A paste is handled well by WhatsApp's editor (keeps line breaks).
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch {}
    const norm = (s) => s.replace(/\s+/g, " ").trim();
    if (!norm(box.textContent || "").includes(norm(text).slice(0, 40))) {
      range.selectNodeContents(box);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("insertText", false, text);
    }
    const ok = norm(box.textContent || "").includes(norm(text).slice(0, 40));
    return ok ? { ok: true } : { ok: false, reason: "insert-failed" };
  }

  // ------------------------------------------------- messages from the panel

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (msg?.type === "read-latest") {
        if (!$(SEL.main)) return sendResponse({ ok: false, reason: "no-chat" });
        const payload = readChat(null, { latest: true });
        const row = payload.target && rowById(payload.target.id);
        imagesOf(payload.target?.imageCount ? row : null).then((images) => {
          if (images.length) payload.target.images = images;
          sendResponse({ ok: true, payload });
        });
        return true;
      } else if (msg?.type === "read-new") {
        if (!$(SEL.main)) return sendResponse({ ok: false, reason: "no-chat" });
        sendResponse({ ok: true, payload: readChat(null) });
      } else if (msg?.type === "insert") {
        const current = chatTitle();
        if (!msg.force && msg.expectedChat && current && current !== msg.expectedChat) {
          return sendResponse({ ok: false, reason: "chat-changed", current });
        }
        sendResponse(insertText(msg.text));
      } else if (msg?.type === "ping") {
        sendResponse({ ok: true, title: chatTitle() });
      }
    } catch (err) {
      sendResponse({ ok: false, reason: String(err?.message || err) });
    }
    return false;
  });

  // Exposed for tests only.
  window.__waAssistant = { readChat, parseRow, messageRows, isForMe, insertText, chatTitle, isMine };
})();
