// End-to-end: real Chromium + the extension, a mock WhatsApp page and a mock Ollama.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
// Current WhatsApp Web structure, plus the older one (served with ?legacy=1).
const MOCK_HTML = fs.readFileSync(path.join(here, "mock-whatsapp.html"), "utf8");
const LEGACY_HTML = fs.readFileSync(path.join(here, "mock-whatsapp-legacy.html"), "utf8");
const EXECUTABLE = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";

let server;
let llmUrl;
const requests = [];
let llmMode = "ok";
const SHOTS = process.env.SHOTS; // set to a folder to save screenshots for review
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

let context;
let sw;
let extId;
let wa;
let panel;
let tabId;

function startMockOllama() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const origin = req.headers.origin || "";
        requests.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
        // Real Ollama rejects browser-extension origins unless OLLAMA_ORIGINS allows them.
        if (origin.startsWith("chrome-extension://")) {
          res.writeHead(403, { "content-type": "text/plain" });
          return res.end("Forbidden");
        }
        if (llmMode === "error") {
          res.writeHead(500, { "content-type": "text/plain" });
          return res.end("model not found");
        }
        const n = requests.length;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          message: { content: JSON.stringify({ drafts: [`Draft one #${n}`, `Draft two #${n}`, `Draft three #${n}`] }) },
        }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      llmUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

function copyExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-ext-"));
  fs.cpSync(path.join(root, "extension"), dir, { recursive: true });
  // Tests can't click Chrome's permission prompt, so pre-grant the mock server.
  const mf = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  mf.host_permissions.push("http://127.0.0.1/*");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(mf, null, 2));
  return dir;
}

async function waitFor(fn, { timeout = 8000, interval = 100 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out (last: ${last})`);
}

before(async () => {
  await startMockOllama();
  const extDir = copyExtension();
  context = await chromium.launchPersistentContext("", {
    executablePath: EXECUTABLE,
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--headless=new"],
  });
  await context.route("https://web.whatsapp.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: route.request().url().includes("legacy=1") ? LEGACY_HTML : MOCK_HTML,
    }),
  );
  sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  extId = new URL(sw.url()).host;
  // Extension APIs appear on the worker a moment after it starts.
  await waitFor(() => sw.evaluate(() => !!(globalThis.chrome && chrome.storage && chrome.storage.local)));

  await sw.evaluate(async (endpoint) => {
    await chrome.storage.local.set({
      settings: { endpoint, myNames: "Steven", contextCount: 20, draftCount: 3, think: "false", headers: [{ name: "CF-Access-Client-Id", value: "test-id" }] },
    });
  }, llmUrl);
  // Give the service worker a moment to install the Origin-stripping rule.
  await waitFor(() => sw.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).length === 1));

  wa = await context.newPage();
  await wa.goto("https://web.whatsapp.com/");
  await wa.waitForSelector(".wa-asst-btn", { state: "attached" });
  tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "https://web.whatsapp.com/*" }))[0].id);
  panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 800 });
  await panel.goto(`chrome-extension://${extId}/sidepanel/panel.html?tab=${tabId}`);
});

after(async () => {
  await context?.close();
  server?.close();
});

test("group messages aimed at me are highlighted", async () => {
  await waitFor(() => wa.$$eval(".wa-asst-forme", (els) => els.length === 2));
  const ids = await wa.$$eval(".wa-asst-forme", (els) => els.map((e) => e.dataset.id));
  assert.ok(ids.some((i) => i.endsWith("04")), "quoted reply to me");
  assert.ok(ids.some((i) => i.endsWith("05")), "names me");
});

test("hover Draft button loads the message into the panel", async () => {
  await wa.bringToFront();
  await wa.hover('[data-id$="05"] [data-testid="msg-container"]');
  const btn = wa.locator(".wa-asst-btn");
  await btn.waitFor({ state: "visible" });
  await btn.click();
  await waitFor(async () => (await panel.locator("#targetText").textContent()) === "Steven the AWS server is down");
  assert.equal(await panel.locator("#targetSender").textContent(), "Clark");
  assert.equal(await panel.locator("#chatTitle").textContent(), "IT Support Group");
  assert.equal(await panel.locator("#chatKind").textContent(), "Group");
  assert.equal(requests.length, 0, "no model call before choosing a mode");
  await shot(panel, "1-panel-target");
  await shot(wa, "0-whatsapp-highlight");
});

test("Gather info drafts with full context and no Origin header", async () => {
  await panel.locator('#modeButtons button[data-mode="gather"]').click();
  await panel.locator(".draft textarea").first().waitFor();
  const drafts = await panel.locator(".draft textarea").evaluateAll((els) => els.map((e) => e.value));
  await shot(panel, "2-panel-drafts");
  assert.equal(drafts.length, 3);
  const req = requests.at(-1);
  assert.equal(req.url, "/api/chat");
  assert.equal(req.headers.origin, undefined, "Origin header must be stripped for Ollama");
  assert.equal(req.headers["cf-access-client-id"], "test-id");
  const user = req.body.messages[1].content;
  assert.match(user, /Ann Lee: Good morning everyone 😀/);
  assert.match(user, /Me: VPN access for the new staff is ready\./);
  // No tail and no class on this one: direction comes from the bubble being on the right.
  assert.match(user, /Me: Please restart your laptop first\./);
  assert.match(user, /Bruce Wayne: \(replying to You: "VPN access for the new staff is ready\."\) Thanks! One of them still cannot connect\./);
  assert.match(user, /Target message from Clark:\nSteven the AWS server is down/);
  assert.doesNotMatch(user, /Lunch at 1pm/, "messages after the target are not included");
  assert.match(user, /competent, experienced engineer/);
  assert.equal(req.body.think, false);
});

test("Insert puts the (edited) draft into the message box without sending", async () => {
  const first = panel.locator(".draft textarea").first();
  await first.fill("Thank you for informing us. Which instance is affected?");
  await panel.locator(".draft .insert").first().click();
  await waitFor(async () =>
    (await wa.locator("footer [contenteditable]").textContent()).includes("Which instance is affected?"),
  );
  assert.match(await panel.locator("#status").textContent(), /press Enter to send/);
});

test("Insert warns when a different chat is open", async () => {
  await wa.evaluate(() => {
    const t = document.querySelector('[data-testid="conversation-info-header-chat-title"]');
    t.textContent = "Family";
    document.querySelector("footer [contenteditable]").textContent = "";
  });
  await panel.locator(".draft .insert").nth(1).click();
  await panel.locator("#insertAnyway").waitFor();
  assert.equal(await wa.locator("footer [contenteditable]").textContent(), "");
  await panel.locator("#insertAnyway").click();
  await waitFor(async () => (await wa.locator("footer [contenteditable]").textContent()).includes("Draft two"));
  await wa.evaluate(() => {
    const t = document.querySelector('[data-testid="conversation-info-header-chat-title"]');
    t.textContent = "IT Support Group";
  });
});

test("Custom note drafts in one step", async () => {
  await panel.locator("#intent").fill("will check tonight");
  const before = requests.length;
  await panel.locator("#draftCustom").click();
  await waitFor(() => requests.length === before + 1);
  assert.match(requests.at(-1).body.messages[1].content, /My intent: will check tonight/);
  assert.match(requests.at(-1).body.messages[1].content, /Target message from Clark/);
});

test("Regenerate asks for fresh alternatives", async () => {
  await panel.locator(".draft textarea").first().waitFor();
  await panel.locator("#regenerate").click();
  await waitFor(() => /different from these earlier drafts/.test(requests.at(-1).body.messages[1].content));
});

test("Latest message and New message read the open chat", async () => {
  await panel.locator("#useLatest").click();
  await waitFor(async () => (await panel.locator("#targetText").textContent()) === "Lunch at 1pm?");

  await panel.locator("#useNew").click();
  await panel.locator("#newBox").waitFor({ state: "visible" });
  assert.equal(await panel.locator("#modeButtons").isHidden(), true);
  await panel.locator("#intent").fill("vpn maintenance tonight 11pm");
  await panel.locator("#draftCustom").click();
  await waitFor(() => /NEW message/.test(requests.at(-1).body.messages[1].content));
  const user = requests.at(-1).body.messages[1].content;
  assert.doesNotMatch(user, /Target message/);
  assert.match(user, /Diana: Lunch at 1pm\?/);
});

test("model errors are shown, not swallowed", async () => {
  llmMode = "error";
  await panel.locator("#draftCustom").click();
  await panel.locator("#status.error").waitFor();
  assert.match(await panel.locator("#status").textContent(), /HTTP 500: model not found/);
  await shot(panel, "3-panel-error");
  if (SHOTS) {
    const opts = await context.newPage();
    await opts.setViewportSize({ width: 900, height: 900 });
    await opts.goto(`chrome-extension://${extId}/options/options.html`);
    await opts.locator(".header-row").first().waitFor();
    await shot(opts, "4-options");
    await opts.close();
  }
  llmMode = "ok";
});

test("older WhatsApp page structure still works", async () => {
  const legacy = await context.newPage();
  await legacy.goto("https://web.whatsapp.com/?legacy=1");
  await legacy.waitForSelector(".wa-asst-btn", { state: "attached" });
  await waitFor(() => legacy.$$eval(".wa-asst-forme", (els) => els.length === 2));
  const id = await sw.evaluate(async () => (await chrome.tabs.query({ url: "https://web.whatsapp.com/?legacy=1" }))[0].id);
  const res = await sw.evaluate((tab) => chrome.tabs.sendMessage(tab, { type: "read-latest" }), id);
  assert.equal(res.ok, true);
  assert.equal(res.payload.title, "IT Support Group");
  assert.equal(res.payload.isGroup, true);
  assert.equal(res.payload.target.text, "Lunch at 1pm?");
  assert.ok(res.payload.messages.some((m) => m.mine && m.text.startsWith("VPN access")));
  await legacy.close();
});

test("a photo in the message is shown and sent to the AI as a JPEG", async () => {
  await wa.bringToFront();
  await wa.hover('[data-id$="A1"] [data-testid="msg-container"]');
  const btn = wa.locator(".wa-asst-btn");
  await btn.waitFor({ state: "visible" });
  await btn.click();
  await waitFor(async () => (await panel.locator("#targetText").textContent()) === "[image] Error when I connect");
  await panel.locator("#targetImages img").waitFor();
  await shot(panel, "5-panel-image");

  await panel.locator('#modeButtons button[data-mode="reply"]').click();
  await panel.locator(".draft textarea").first().waitFor();
  const req = requests.at(-1);
  const images = req.body.messages[1].images;
  assert.equal(images.length, 1);
  assert.ok(images[0].startsWith("/9j/"), "sent as JPEG");
  assert.match(req.body.messages[1].content, /includes the attached image/);

  await panel.locator("#includeImages").uncheck();
  const before = requests.length;
  await panel.locator('#modeButtons button[data-mode="ack"]').click();
  await waitFor(() => requests.length === before + 1);
  assert.equal(requests.at(-1).body.messages[1].images, undefined);
  assert.doesNotMatch(requests.at(-1).body.messages[1].content, /attached image/);
});
