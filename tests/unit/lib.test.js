import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, effectivePrompts, PROMPT_DEFAULTS } from "../../extension/lib/prompts.js";
import { parseDrafts, callModel, buildHeaders, LLMError } from "../../extension/lib/llm.js";

const chat = {
  title: "IT Support",
  isGroup: true,
  messages: [
    { sender: "Ann", text: "morning", mine: false },
    { sender: "Me", text: "hi", mine: true },
  ],
  target: { sender: "Bruce", text: "the AWS server is down" },
};

test("prompt includes context, target, task and overrides", () => {
  const { system, user } = buildPrompt({
    prompts: { style: "Very formal.", about_me: "  " },
    mode: "gather", chat, intent: "", draftCount: 3,
  });
  assert.match(system, /Very formal\./);
  assert.match(system, new RegExp(PROMPT_DEFAULTS.about_me.slice(0, 30)));
  assert.match(system, /exactly 3 different drafts/);
  assert.match(user, /Chat: IT Support \(group chat\)/);
  assert.match(user, /Ann: morning\nMe: hi/);
  assert.match(user, /Target message from Bruce:\nthe AWS server is down/);
  assert.match(user, /competent, experienced engineer/);
});

test("new-message mode omits target and includes intent", () => {
  const { user } = buildPrompt({ prompts: {}, mode: "new", chat, intent: "vpn maintenance 11pm", draftCount: 2 });
  assert.doesNotMatch(user, /Target message/);
  assert.match(user, /NEW message/);
  assert.match(user, /My intent: vpn maintenance 11pm/);
});

test("regenerate lists previous drafts", () => {
  const { user } = buildPrompt({ prompts: {}, mode: "reply", chat, draftCount: 2, previousDrafts: ["a", "b"] });
  assert.match(user, /different from these earlier drafts:\n- a\n- b/);
});

test("blank overrides fall back to defaults", () => {
  assert.equal(effectivePrompts({ style: "" }).style, PROMPT_DEFAULTS.style);
});

test("parseDrafts handles json, fences, arrays, objects and lists", () => {
  assert.deepEqual(parseDrafts('{"drafts":["a","b","c"]}', 3), ["a", "b", "c"]);
  assert.deepEqual(parseDrafts('Sure\n```json\n{"drafts":["x"]}\n```', 3), ["x"]);
  assert.deepEqual(parseDrafts('[{"text":"x"},{"reply":"y"}]', 3), ["x", "y"]);
  assert.deepEqual(parseDrafts("<think>hmm</think>1. one\n2) two\n- three", 2), ["one", "two"]);
  assert.deepEqual(parseDrafts('{"drafts":["a","b","c","d"]}', 2), ["a", "b"]);
  assert.throws(() => parseDrafts("  ", 3), LLMError);
});

test("headers skip empty names", () => {
  assert.deepEqual(buildHeaders([{ name: "CF-Access-Client-Id", value: " id " }, { name: "", value: "x" }]), {
    "Content-Type": "application/json",
    "CF-Access-Client-Id": "id",
  });
});

function fakeFetch(handler) {
  return async (url, init) => handler(url, init);
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const base = { endpoint: "https://llm.test/", api: "ollama", model: "gemma4:e4b", headers: [{ name: "CF-Access-Client-Id", value: "i" }], temperature: 0.5, timeout: 5, draftCount: 3, think: "false" };

test("ollama request shape and response", async () => {
  let seen;
  const drafts = await callModel(base, "sys", "user", {
    fetchImpl: fakeFetch((url, init) => {
      seen = { url, init, body: JSON.parse(init.body) };
      return json({ message: { content: '{"drafts":["Got it"]}' } });
    }),
  });
  assert.deepEqual(drafts, ["Got it"]);
  assert.equal(seen.url, "https://llm.test/api/chat");
  assert.equal(seen.init.headers["CF-Access-Client-Id"], "i");
  assert.equal(seen.body.format, "json");
  assert.equal(seen.body.think, false);
  assert.equal(seen.body.stream, false);
});

test("openai mode", async () => {
  const drafts = await callModel({ ...base, api: "openai" }, "s", "u", {
    fetchImpl: fakeFetch((url) => {
      assert.equal(url, "https://llm.test/v1/chat/completions");
      return json({ choices: [{ message: { content: '["a","b"]' } }] });
    }),
  });
  assert.deepEqual(drafts, ["a", "b"]);
});

test("cloudflare login page and 403 are explained", async () => {
  await assert.rejects(
    callModel(base, "s", "u", { fetchImpl: fakeFetch(() => new Response("<html>", { headers: { "content-type": "text/html" } })) }),
    /Cloudflare Access login page/,
  );
  await assert.rejects(
    callModel(base, "s", "u", { fetchImpl: fakeFetch(() => new Response("forbidden", { status: 403 })) }),
    /OLLAMA_ORIGINS/,
  );
});

test("missing endpoint and network errors", async () => {
  await assert.rejects(callModel({ ...base, endpoint: "" }, "s", "u"), /Set the AI endpoint/);
  await assert.rejects(
    callModel(base, "s", "u", { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } }),
    /Could not reach the model server/,
  );
});
