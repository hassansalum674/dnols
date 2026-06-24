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

  return { intent: REPLY_INTENT.UNKNOWN, keyword: firstToken, message: "" };
}
