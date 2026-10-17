# WhatsApp Reply Assistant

A Chrome extension for WhatsApp Web that drafts replies with **your own
self-hosted AI** (Ollama / Gemma, or any OpenAI-compatible server) in a side
panel next to your chats.

- Reads **only the chat you have open**, and only when you click.
- **Never sends anything.** "Insert into chat" only fills the message box;
  you review it and press Enter yourself.
- Your messages go only to the endpoint you configure.

## Features

- **✎ Draft button** on every message when you hover over it, in groups and
  one-to-one chats.
- **Highlights** group messages that are probably for you: they say one of your
  names, or reply to one of your messages.
- **Choose first, then draft** (no wasted model calls):
  - **Reply**: a normal reply
  - **Acknowledge**: restates the actual request and the next step, never a bare "noted"
  - **Gather info**: asks the questions an experienced engineer would ask for *that* problem
  - **Your note**: type a rough intent ("will check tonight") and get it in your style
  - **New message**: start a conversation or post an announcement yourself
- **Latest message** button: draft a reply to the newest incoming message without hovering.
- Drafts are **editable**, with **Copy** and **Insert into chat**. If you switched
  to another chat in the meantime, it warns you before inserting.
- **Settings**: endpoint, model, any request headers (one click adds the
  Cloudflare Access service token headers), and every prompt. The prompt keys
  are the same as the Telegram bot's `prompts.yaml`, so you can paste the same text.

## Install

1. Download this repository: **Code → Download ZIP** and unzip it, or
   `git clone https://github.com/stevenfoong/my-whatsapp-assistant`.
   (Each build also produces a ready-made zip under the repo's **Actions** tab.)
2. In Chrome, open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`extension`** folder.
4. Pin the extension (puzzle icon → pin) so its icon is in the toolbar.
5. Reload any open WhatsApp Web tab (F5).

To update later: download or `git pull` again, then press the reload ↻ button on the
extension's card in `chrome://extensions`, and reload WhatsApp Web.

## Set up

1. Click the extension icon, then **⚙** (or right-click the icon → **Options**).
2. **Endpoint URL**: your Ollama base URL, e.g. `https://gemma.example.com`
   (no `/api/chat`). **Model**: e.g. `gemma4:e4b`.
3. **Add Cloudflare Access headers**, then paste your service token's
   Client ID and Client Secret.
4. Set **Thinking** to *Off (faster)* if drafts are slow.
5. Add **Your names in groups** (comma-separated).
6. Paste your **About me** and **Style** text.
7. Click **Save**. Chrome asks for permission to reach your endpoint; click **Allow**.
8. Click **Test connection**.

### Ollama and browser extensions

Ollama normally refuses requests that come from a browser extension (HTTP 403).
The extension removes the `Origin` header from its own requests to your endpoint,
so this works without changing Ollama. If you still get a 403 that mentions
Ollama, add this to the Ollama container's environment and restart it:

```
OLLAMA_ORIGINS=chrome-extension://*
```

## Use

1. Open a chat in WhatsApp Web.
2. Hover over the message you want to answer and click **✎ Draft**.
   The side panel opens with that message. If it doesn't open, click the
   extension icon.
3. Pick **Reply**, **Acknowledge** or **Gather info**. Or type what you want
   to say and click **Draft from my note** (Ctrl+Enter).
4. Edit a draft if needed, then **Insert into chat** (or **Copy**).
   Check the message box in WhatsApp and press Enter to send.

Use **Latest message** to answer the newest incoming message, or **New message**
to write something new to the open chat.

## Privacy and safety

- The extension can only run on `web.whatsapp.com`, plus the one endpoint you allow.
- It reads the open chat only when you click Draft, Latest message or New message.
  Nothing is read in the background, except that the page is scanned for your
  names to show the highlights; that check stays in the browser.
- Settings, including the service token, are stored only in this browser
  (`chrome.storage.local`).
- It never sends messages. WhatsApp sees normal typing in WhatsApp Web.
- Loaded unpacked, it never auto-updates, so the code you run is the code you reviewed.

## When WhatsApp changes its page

WhatsApp Web changes its page structure from time to time. If the Draft button,
the highlights or Insert stop working, the selectors at the top of
`extension/content/whatsapp.js` (`SEL = { ... }`) are the place to fix it.

## Development

```bash
npm ci
npm test               # unit tests (prompts, model client, parsing)
npm run test:e2e       # real Chromium + extension against a mock WhatsApp page and mock Ollama
```

`CHROMIUM_PATH` selects the Chromium binary for the end-to-end tests.
Set `SHOTS=/some/folder` to save screenshots.
