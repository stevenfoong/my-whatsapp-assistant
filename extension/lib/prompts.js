// Prompt templates. Same structure as the Telegram bot, so prompts can be shared.
// Everything here can be overridden from the Settings page.

export const MODE_LABELS = {
  reply: "Reply",
  ack: "Acknowledge",
  gather: "Gather info",
  custom: "Custom",
  new: "New message",
};

export const PROMPT_DEFAULTS = {
  about_me:
    "I am the person whose replies you draft. Assume a professional who works " +
    "with colleagues and clients over chat.",
  style:
    "Polite, warm and concise. Sound like a real person typing in a chat app, " +
    "not an email. No greetings like 'Dear', no sign-offs, no emojis unless the " +
    "conversation already uses them.",
  rules:
    "Reply in the same language (or language mix) the other person used. " +
    "Never invent facts, dates, prices or commitments that are not in the " +
    "conversation or in my instructions. If something is unknown, say it will be " +
    "checked rather than making it up. Keep each draft short enough for a chat message.",
  mode_reply:
    "Draft a natural, helpful reply to the target message, taking the whole " +
    "conversation into account.",
  mode_ack:
    "Draft an acknowledgement that shows I understood the specific request: restate " +
    "the key point in my own words (what is needed, for whom, by when if mentioned) " +
    "and say what happens next (e.g. I will check and share an ETA). Do NOT write " +
    "generic replies like 'noted', 'ok', 'will update' on their own.",
  mode_gather:
    "The message reports a problem or request without enough detail. Draft a reply " +
    "that asks only the questions a competent, experienced engineer would ask for " +
    "THIS specific problem, to diagnose or act on it. Skip trivial checks that do not " +
    "fit the context (e.g. 'is it plugged in' for a cloud server). Ask at most 3-5 " +
    "focused questions, grouped naturally, and keep it friendly.",
  mode_custom:
    "Draft a reply that says what I intend to say (my intent is given below), " +
    "phrased politely and fitting the conversation. My intent is a rough note: " +
    "keep its meaning, but rewrite it fully in my style, even if the note itself " +
    "is casual, short or ungrammatical.",
  mode_new:
    "Draft a NEW message that I will post to start a conversation or make an " +
    "announcement in this chat. It is not a reply to anyone. Convey my intent " +
    "(given below) clearly and completely, using the recent conversation only as " +
    "background. If the intent is a request, say what is needed and by when if given.",
};

export const PROMPT_KEYS = Object.keys(PROMPT_DEFAULTS);

/** Merge saved prompt overrides over the defaults (blank values fall back). */
export function effectivePrompts(saved = {}) {
  const out = { ...PROMPT_DEFAULTS };
  for (const key of PROMPT_KEYS) {
    const v = saved[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim();
  }
  return out;
}

function line(m) {
  return `${m.mine ? "Me" : m.sender || "Unknown"}: ${m.text}`;
}

/**
 * Build the system and user prompts.
 * chat: { title, isGroup, messages: [{sender, text, mine}], target: {sender, text} | null }
 */
export function buildPrompt({ prompts, mode, chat, intent, draftCount, previousDrafts }) {
  const p = effectivePrompts(prompts);
  const system =
    "You draft chat replies on my behalf. I will review and send them myself.\n\n" +
    `About me:\n${p.about_me}\n\n` +
    `My style:\n${p.style}\n\n` +
    `Rules:\n${p.rules}\n\n` +
    `Respond ONLY with JSON of the form {"drafts": ["...", "..."]} containing ` +
    `exactly ${draftCount} different drafts. No markdown, no explanation.`;

  const task = p[`mode_${mode}`] || p.mode_reply;
  const parts = [];
  if (chat.title) parts.push(`Chat: ${chat.title}${chat.isGroup ? " (group chat)" : ""}`);
  const history = (chat.messages || []).map(line).join("\n");
  parts.push("Conversation so far (oldest first; 'Me' is me):\n" + (history || "(no earlier messages)"));
  if (mode !== "new" && chat.target) {
    parts.push(`Target message from ${chat.target.sender || "them"}:\n${chat.target.text}`);
  }
  parts.push(`Task: ${task}`);
  if (intent) parts.push(`My intent: ${intent}`);
  if (previousDrafts && previousDrafts.length) {
    parts.push(
      "Give fresh alternatives, different from these earlier drafts:\n" +
        previousDrafts.map((d) => `- ${d}`).join("\n"),
    );
  }
  return { system, user: parts.join("\n\n") };
}
