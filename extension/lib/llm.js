// Client for the self-hosted model: Ollama native API, or any OpenAI-compatible API.

export class LLMError extends Error {}

/** Pull a list of drafts out of the model's reply, tolerating sloppy output. */
export function parseDrafts(raw, expected) {
  let text = String(raw || "").trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  text = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();

  const candidates = [text];
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) candidates.push(obj[0]);
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) candidates.push(arr[0]);

  for (const cand of candidates) {
    let data;
    try {
      data = JSON.parse(cand);
    } catch {
      continue;
    }
    let items = null;
    if (Array.isArray(data)) {
      items = data;
    } else if (data && typeof data === "object") {
      for (const key of ["drafts", "replies", "suggestions", "options"]) {
        if (Array.isArray(data[key])) {
          items = data[key];
          break;
        }
      }
      const vals = Object.values(data);
      if (!items && vals.length === 1 && Array.isArray(vals[0])) items = vals[0];
    }
    if (items && items.length) {
      const drafts = [];
      for (const item of items) {
        if (typeof item === "string" && item.trim()) drafts.push(item.trim());
        else if (item && typeof item === "object") {
          const v = item.text || item.draft || item.reply;
          if (typeof v === "string" && v.trim()) drafts.push(v.trim());
        }
      }
      if (drafts.length) return drafts.slice(0, expected);
    }
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  if (lines.length) return lines.slice(0, expected);
  throw new LLMError("The model returned an empty reply.");
}

export function buildHeaders(headerList = []) {
  const headers = { "Content-Type": "application/json" };
  for (const h of headerList) {
    const name = (h.name || "").trim();
    if (name) headers[name] = (h.value || "").trim();
  }
  return headers;
}

export async function callModel(settings, system, user, { fetchImpl = fetch, images = [] } = {}) {
  const base = (settings.endpoint || "").replace(/\/+$/, "");
  if (!base) throw new LLMError("Set the AI endpoint in Settings first.");
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  let url;
  let body;
  if (settings.api === "openai") {
    url = `${base}/v1/chat/completions`;
    if (images.length) {
      messages[1].content = [
        { type: "text", text: user },
        ...images.map((b64) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } })),
      ];
    }
    body = { model: settings.model, messages, temperature: Number(settings.temperature) };
  } else {
    url = `${base}/api/chat`;
    if (images.length) messages[1].images = images;
    body = {
      model: settings.model,
      messages,
      stream: false,
      format: "json",
      options: { temperature: Number(settings.temperature) },
    };
    if (settings.think === "true") body.think = true;
    if (settings.think === "false") body.think = false;
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(5, Number(settings.timeout) || 120) * 1000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      headers: buildHeaders(settings.headers),
      body: JSON.stringify(body),
      signal: controller.signal,
      credentials: "omit",
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new LLMError(`The model did not answer within ${timeoutMs / 1000}s.`);
    }
    throw new LLMError(
      "Could not reach the model server. Check the endpoint URL and that the " +
        "extension has permission for it (Settings → Save asks for it).",
    );
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 401 || resp.status === 403) {
    const snippet = (await safeText(resp)).slice(0, 200);
    throw new LLMError(
      `The model server refused the request (HTTP ${resp.status}). ` +
        "Check the Cloudflare Access headers. If Ollama itself refused it, add " +
        "OLLAMA_ORIGINS=chrome-extension://* to the Ollama container's environment." +
        (snippet ? ` Server said: ${snippet}` : ""),
    );
  }
  if (resp.status >= 400) {
    const snippet = (await safeText(resp)).slice(0, 300).replace(/\s+/g, " ");
    throw new LLMError(`Model server error HTTP ${resp.status}: ${snippet}`);
  }
  const ctype = resp.headers.get("content-type") || "";
  if (!ctype.includes("json")) {
    throw new LLMError(
      "The model server returned a web page instead of JSON (often a Cloudflare " +
        "Access login page). Check the service token headers and the Access policy.",
    );
  }
  const data = await resp.json();
  let content;
  try {
    content = settings.api === "openai" ? data.choices[0].message.content : data.message.content;
  } catch {
    throw new LLMError("Unexpected response format from the model server.");
  }
  return parseDrafts(content, Number(settings.draftCount) || 3);
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}
