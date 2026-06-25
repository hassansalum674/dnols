export const REPLY_INTENT = Object.freeze({
  APPROVE: "approve",
  DECLINE: "decline",
  COUNTER: "counter",
  ACCEPT: "accept",
  DECLINE_COUNTER: "decline_counter",
  PAID: "paid",
  RECEIVED: "received",
  DISPUTE: "dispute",
  MESSAGE: "message",
  UNKNOWN: "unknown"
});

const KEYWORD_INTENTS = new Map([
  ["YES", REPLY_INTENT.APPROVE],
  ["NO", REPLY_INTENT.DECLINE],
  ["COUNTER", REPLY_INTENT.COUNTER],
  ["ACCEPT", REPLY_INTENT.ACCEPT],
  ["DECLINE", REPLY_INTENT.DECLINE_COUNTER],
  ["PAID", REPLY_INTENT.PAID],
  ["RECEIVED", REPLY_INTENT.RECEIVED],
  ["DISPUTE", REPLY_INTENT.DISPUTE]
]);

const APPROVAL_PHRASES = [
  /\b(?:yes|yep|yeah|ok(?:ay)?|proceed|approve|approved|go ahead|do it|confirm)\b/i,
  /\b(?:ndiyo|sawa|kubali|nakubali|fanya|endelea|thibitisha)\b/i
];

const DECLINE_PHRASES = [
  /\b(?:no|nope|reject|decline|declined|cancel|stop|do not|don't)\b/i,
  /\b(?:hapana|kataa|sikubali|usiende|usifanye|acha)\b/i
];

const COUNTER_PHRASES = [
  /\b(?:counter|too expensive|price is high|price is low|too low|too cheap|raise|increase|add|reduce|discount|negotiate)\b/i,
  /\b(?:bei|ghali|ndogo|ongeza|niongeze|punguza|jadili|majadiliano)\b/i,
  /\b(?:can we do|make it|what about|instead)\b/i,
  /(?:\$|usd|tzs|kes|shillings?)\s*\d/i,
  /\d[\d,]*(?:\.\d+)?\s*(?:\$|usd|tzs|kes|shillings?)\b/i
];

export function parseSmsReply(rawText) {
  const text = String(rawText ?? "").trim();
  if (!text) {
    return { intent: REPLY_INTENT.UNKNOWN, keyword: "", message: "" };
  }

  const firstToken = text.split(/\s+/)[0].toUpperCase().replace(/[^A-Z]/g, "");

  if (firstToken === "MSG") {
    const message = text.slice(text.toUpperCase().indexOf("MSG") + 3).trim();
    if (!message) {
      return { intent: REPLY_INTENT.UNKNOWN, keyword: "MSG", message: "" };
    }
    return { intent: REPLY_INTENT.MESSAGE, keyword: "MSG", message };
  }

  const intent = KEYWORD_INTENTS.get(firstToken);
  if (intent) {
    return { intent, keyword: firstToken, message: "" };
  }

  const naturalIntent = classifyNaturalReply(text);
  if (naturalIntent !== REPLY_INTENT.UNKNOWN) {
    return {
      intent: naturalIntent,
      keyword: firstToken,
      message: naturalIntent === REPLY_INTENT.COUNTER || naturalIntent === REPLY_INTENT.MESSAGE ? text : ""
    };
  }

  return { intent: REPLY_INTENT.UNKNOWN, keyword: firstToken, message: "" };
}

function classifyNaturalReply(text) {
  const normalized = normalizeForMatching(text);
  const approval = matchesAny(APPROVAL_PHRASES, normalized);
  const decline = matchesAny(DECLINE_PHRASES, normalized);
  const counter = matchesAny(COUNTER_PHRASES, normalized);

  if (counter && !approval && !decline) return REPLY_INTENT.COUNTER;
  if (approval && !decline && !counter) return REPLY_INTENT.APPROVE;
  if (decline && !approval && !counter) return REPLY_INTENT.DECLINE;
  if (counter) return REPLY_INTENT.COUNTER;

  // TODO: If we expose the existing Groq helper as a small safe classifier,
  // call it here for ambiguous owner language after these deterministic rules.
  return REPLY_INTENT.MESSAGE;
}

function matchesAny(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

function normalizeForMatching(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s$,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
