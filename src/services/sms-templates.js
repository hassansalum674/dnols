export const SMS_TYPE = Object.freeze({
  NEW_DEAL_REQUEST: "new_deal_request",
  DEAL_ACCEPTED: "deal_accepted",
  DEAL_DECLINED: "deal_declined",
  COUNTER_OFFER: "counter_offer",
  PAYMENT_INCOMING: "payment_incoming",
  DEAL_COMPLETE: "deal_complete",
  FEE_INVOICE_BUYER: "fee_invoice_buyer",
  FEE_INVOICE_SELLER: "fee_invoice_seller",
  HUMAN_ESCALATION: "human_escalation",
  DEAL_REMINDER: "deal_reminder",
  WELCOME: "welcome",
  DISPUTE_OPENED: "dispute_opened",
  NOT_UNDERSTOOD: "not_understood"
});

export const SMS_SENDER_ID = "DNOLS";
export const SMS_MAX_LENGTH = 160;

const FEE_RATE = 0.01;

export function renderSmsTemplate(type, data = {}) {
  const builder = TEMPLATE_BUILDERS[type];
  if (!builder) {
    throw new Error(`Unknown SMS template type: ${type}`);
  }
  return enforceLength(sanitizeSmsText(builder(data)));
}

const TEMPLATE_BUILDERS = {
  [SMS_TYPE.NEW_DEAL_REQUEST]: (d) =>
    [
      "DNOLS: New deal request",
      "",
      `From: ${field(d.buyerName, 18, "Buyer")}`,
      field(d.serviceDescription, 28, "Service request"),
      `Amount: $${amount(d.amount)}`,
      `Deadline: ${field(d.deadline, 14, "TBD")}`,
      "",
      "Reply YES, NO or COUNTER",
      `Ref: ${ref(d.dealId)}`
    ].join("\n"),

  [SMS_TYPE.DEAL_ACCEPTED]: (d) =>
    [
      "DNOLS: Deal accepted",
      "",
      `${field(d.sellerName, 18, "Seller")} accepted your request.`,
      `$${amount(d.amount)} - ${field(d.serviceDescription, 22, "service")}`,
      "",
      "Reply PAID when you send payment.",
      `Ref: ${ref(d.dealId)}`
    ].join("\n"),

  [SMS_TYPE.DEAL_DECLINED]: (d) =>
    [
      "DNOLS: Deal declined",
      "",
      `${field(d.sellerName, 18, "Seller")} could not fulfill this request. Your agent is searching for alternatives.`,
      `Ref: ${ref(d.dealId)}`
    ].join("\n"),

  [SMS_TYPE.COUNTER_OFFER]: (d) =>
    [
      "DNOLS: Counter offer received",
      "",
      `${field(d.sellerName, 18, "Seller")} proposes:`,
      `$${amount(d.newAmount ?? d.amount)} - ${field(d.newTerms, 24, "new terms")}`,
      "",
      "Reply ACCEPT or DECLINE",
      `Ref: ${ref(d.dealId)}`
    ].join("\n"),

  [SMS_TYPE.PAYMENT_INCOMING]: (d) =>
    [
      "DNOLS: Payment incoming",
      "",
      `${field(d.buyerName, 18, "Buyer")} confirmed payment sent.`,
      `$${amount(d.amount)} - Ref: ${ref(d.dealId)}`,
      "",
      "Reply RECEIVED when goods delivered."
    ].join("\n"),

  [SMS_TYPE.DEAL_COMPLETE]: (d) =>
    [
      "DNOLS: Deal complete",
      "",
      `${ref(d.dealId)} successfully closed.`,
      "Both parties confirmed.",
      "",
      "Fee invoice sent separately.",
      "Well done."
    ].join("\n"),

  [SMS_TYPE.FEE_INVOICE_BUYER]: (d) => feeInvoice(d),
  [SMS_TYPE.FEE_INVOICE_SELLER]: (d) => feeInvoice(d),

  [SMS_TYPE.HUMAN_ESCALATION]: (d) =>
    [
      "DNOLS: Agent needs your help",
      "",
      "Your agent could not complete",
      `negotiation for ${ref(d.dealId)}.`,
      "",
      "Login to handle manually:",
      `dnols.app/deals/${ref(d.dealId)}`
    ].join("\n"),

  [SMS_TYPE.DEAL_REMINDER]: (d) =>
    [
      "DNOLS: Awaiting your response",
      "",
      `Deal ${ref(d.dealId)} is waiting.`,
      "Please reply YES, NO or COUNTER.",
      "",
      `dnols.app/deals/${ref(d.dealId)}`
    ].join("\n"),

  [SMS_TYPE.WELCOME]: (d) =>
    [
      "DNOLS: Agent activated",
      "",
      `Welcome ${field(d.businessName, 24, "partner")}.`,
      "Your agent is live and ready.",
      "",
      "First deal notifications will",
      "arrive here. dnols.app"
    ].join("\n"),

  [SMS_TYPE.DISPUTE_OPENED]: (d) =>
    [
      "DNOLS: Dispute opened",
      "",
      `${ref(d.dealId)} has been flagged.`,
      "Our team will review within 24hrs.",
      "",
      "Do not make any payments until",
      `resolved. dnols.app/deals/${ref(d.dealId)}`
    ].join("\n"),

  [SMS_TYPE.NOT_UNDERSTOOD]: (d) =>
    [
      "DNOLS: Not understood",
      "",
      "Reply YES, NO, COUNTER, PAID,",
      "RECEIVED or DISPUTE.",
      `Help: dnols.app/help/${ref(d.dealId)}`
    ].join("\n")
};

function feeInvoice(d) {
  return [
    "DNOLS: Service fee due",
    "",
    `Deal ${ref(d.dealId)} complete.`,
    `Fee: $${amount(feeAmount(d))} (1%)`,
    "",
    `Pay via M-Pesa: ${field(d.payNumber, 16, "see app")}`,
    `Ref: ${ref(d.dealId)}`,
    `Or: dnols.app/pay/${ref(d.dealId)}`
  ].join("\n");
}

export function feeAmount(d = {}) {
  const explicit = Number(d.feeAmount);
  if (Number.isFinite(explicit) && explicit > 0) return roundMoney(explicit);
  const base = Number(d.amount);
  if (!Number.isFinite(base) || base <= 0) return 0;
  return roundMoney(base * FEE_RATE);
}

export function sanitizeSmsText(value) {
  return String(value ?? "")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/[\u2026]/g, "...")
    .replace(/[^\x20-\x7E\n]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function enforceLength(text) {
  if (text.length <= SMS_MAX_LENGTH) return text;
  return text.slice(0, SMS_MAX_LENGTH).trimEnd();
}

function field(value, maxLength, fallback = "") {
  const text = sanitizeSmsText(value).replace(/\n+/g, " ").trim() || fallback;
  return text.length > maxLength ? text.slice(0, maxLength).trimEnd() : text;
}

function amount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "0";
  return String(roundMoney(number));
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function ref(value) {
  const text = sanitizeSmsText(value).replace(/[^A-Za-z0-9-]/g, "").trim();
  return (text || "PENDING").slice(0, 18);
}
