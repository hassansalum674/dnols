import { createSmsService } from "./sms.js";
import {
  SMS_MAX_LENGTH,
  SMS_TYPE,
  feeAmount,
  renderSmsTemplate,
  sanitizeSmsText
} from "./sms-templates.js";
import { REPLY_INTENT, parseSmsReply } from "./sms-replies.js";
import { DEAL_EVENT, DEAL_ROLE, advanceDealOnReply, planDealEvent } from "./deal-flow.js";
import { createDealStore, normalizePhone } from "./deal-store.js";
import { nextNegotiationRound, shouldEscalateNegotiation } from "../../public/risk-controls.js";

export const FOUNDER_SMS_TYPE = Object.freeze({
  NEW_DEAL: "founder_new_deal",
  STALLED: "founder_stalled",
  DEAL_CLOSED: "founder_deal_closed",
  FEE_UNPAID: "founder_fee_unpaid",
  DEAL_UPDATE: "founder_deal_update"
});

export function buildDealTemplateData(deal = {}) {
  const buyer = deal.buyer || {};
  const seller = deal.seller || {};
  return {
    dealId: deal.dealId || deal.id || deal.ref || "",
    buyerName: buyer.name || deal.buyerName || "Buyer",
    sellerName: seller.name || deal.sellerName || "Seller",
    businessName: deal.businessName || seller.name || deal.sellerName || "partner",
    serviceDescription: deal.serviceDescription || deal.service || deal.requirements || "Service request",
    amount: deal.amount ?? deal.budgetAmount ?? 0,
    deadline: deal.deadline || deal.dueDate || "TBD",
    newAmount: deal.newAmount ?? deal.counterAmount ?? deal.amount ?? 0,
    newTerms: deal.newTerms || deal.counterTerms || "new terms",
    feeAmount: feeAmount(deal),
    payNumber: deal.payNumber || deal.mpesaNumber || ""
  };
}

export function renderFounderNotification(deal = {}, type = FOUNDER_SMS_TYPE.DEAL_UPDATE, { now = new Date() } = {}) {
  const data = buildFounderTemplateData(deal, now);
  const builders = {
    [FOUNDER_SMS_TYPE.NEW_DEAL]: (d) => [
      "DNOLS ADMIN: New deal",
      "",
      d.dealId,
      `Buyer: ${field(d.buyerName, 22, "Buyer")}`,
      `Seller: ${field(d.sellerName, 22, "Seller")}`,
      `Value: $${money(d.amount)}`,
      `Status: ${field(d.statusLabel, 26, "Awaiting response")}`,
      `Time: ${d.time}`
    ].join("\n"),

    [FOUNDER_SMS_TYPE.STALLED]: (d) => [
      "DNOLS ADMIN: Deal stalled",
      "",
      `${d.dealId} - No response 2hrs`,
      `Seller: ${field(d.sellerName, 22, "Seller")}`,
      d.sellerPhone || "No seller phone",
      "",
      "Call to remind them."
    ].join("\n"),

    [FOUNDER_SMS_TYPE.DEAL_CLOSED]: (d) => [
      "DNOLS ADMIN: Deal closed",
      "",
      d.dealId,
      `Value: $${money(d.amount)}`,
      `Fee due: $${feeMoney(d.feeAmount * 2)} (x2)`,
      "Both parties notified.",
      `Collected: ${field(d.feeCollectionStatus, 18, "pending")}`
    ].join("\n"),

    [FOUNDER_SMS_TYPE.FEE_UNPAID]: (d) => [
      "DNOLS ADMIN: Fee unpaid",
      "",
      `${d.dealId} - 24hrs overdue`,
      `Buyer: ${field(d.buyerName, 18, "Buyer")} - ${d.buyerPhone || "no phone"}`,
      `Fee: $${feeMoney(d.feeAmount)}`,
      "",
      "Follow up now."
    ].join("\n"),

    [FOUNDER_SMS_TYPE.DEAL_UPDATE]: (d) => [
      "DNOLS ADMIN: Deal update",
      "",
      d.dealId,
      `${field(d.buyerName, 16, "Buyer")} -> ${field(d.sellerName, 16, "Seller")}`,
      `Value: $${money(d.amount)}`,
      `Status: ${field(d.statusLabel, 28, "Updated")}`,
      `Time: ${d.time}`
    ].join("\n")
  };
  return enforceFounderLength(sanitizeSmsText((builders[type] || builders[FOUNDER_SMS_TYPE.DEAL_UPDATE])(data)));
}

export async function sendFounderNotification({
  deal = {},
  type = FOUNDER_SMS_TYPE.DEAL_UPDATE,
  env = process.env,
  fetchImpl = globalThis.fetch,
  smsService = createSmsService({ env, fetchImpl }),
  now = () => new Date()
} = {}) {
  const founderPhone = clean(env.FOUNDER_PHONE);
  const message = renderFounderNotification(deal, type, { now: now() });
  if (!founderPhone) {
    return { ok: true, skipped: true, role: "founder", type, reason: "founder_phone_not_configured", message };
  }
  const delivery = await smsService.sendSms({ to: founderPhone, message });
  return { ...delivery, role: "founder", type, message };
}

export function resolveRoleContact(deal = {}, role) {
  const map = {
    [DEAL_ROLE.BUYER]: deal.buyer || { name: deal.buyerName, phone: deal.buyerPhone },
    [DEAL_ROLE.SELLER]: deal.seller || { name: deal.sellerName, phone: deal.sellerPhone },
    [DEAL_ROLE.OWNER]: deal.owner || { name: deal.ownerName || deal.businessName, phone: deal.ownerPhone || deal.sellerPhone }
  };
  const contact = map[role] || {};
  return { role, name: contact.name || "", phone: contact.phone || "" };
}

export function renderRelayMessage(message, dealId) {
  const text = ["DNOLS: New message", "", sanitizeSmsText(message), `Ref: ${dealId || "PENDING"}`].join("\n");
  const clean = sanitizeSmsText(text);
  return clean.length > SMS_MAX_LENGTH ? clean.slice(0, SMS_MAX_LENGTH).trimEnd() : clean;
}

export function renderNotification(deal, notification) {
  const data = buildDealTemplateData(deal);
  if (notification.type === "relay_message") {
    return renderRelayMessage(notification.message, data.dealId);
  }
  return renderSmsTemplate(notification.type, data);
}

export async function sendDealNotifications({
  deal = {},
  notifications = [],
  env = process.env,
  fetchImpl = globalThis.fetch,
  smsService = createSmsService({ env, fetchImpl })
} = {}) {
  const results = [];
  for (const notification of notifications) {
    const contact = resolveRoleContact(deal, notification.role);
    const message = renderNotification(deal, notification);
    if (!contact.phone) {
      results.push({
        ok: false,
        type: notification.type,
        role: notification.role,
        error: "missing_recipient_phone",
        message
      });
      continue;
    }
    const delivery = await smsService.sendSms({ to: contact.phone, message });
    results.push({ ...delivery, type: notification.type, role: notification.role, message });
  }
  return results;
}

export async function startDealAndNotify({
  deal = {},
  store = createDealStore(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  smsService,
  now = () => new Date()
} = {}) {
  const savedDeal = await store.saveDeal({
    ...deal,
    status: "initiated",
    remindedAt: ""
  });
  return sendDealEvent({
    deal: savedDeal,
    event: DEAL_EVENT.NEW_DEAL,
    store,
    env,
    fetchImpl,
    smsService,
    now
  });
}

export async function sendDealEvent({
  deal = {},
  event,
  store,
  env = process.env,
  fetchImpl = globalThis.fetch,
  smsService,
  now = () => new Date()
} = {}) {
  const plan = planDealEvent(event);
  const activeDeal = store ? await upsertDealForNotification({ deal, store }) : deal;
  const results = await sendDealNotifications({ deal: activeDeal, notifications: plan.notifications, env, fetchImpl, smsService });
  const founderResult = await sendFounderNotification({
    deal: { ...activeDeal, status: plan.nextStatus || activeDeal.status },
    type: founderTypeForDealEvent(event),
    env,
    fetchImpl,
    smsService,
    now
  });
  const persistedDeal = store
    ? await persistNotificationState({
        deal: activeDeal,
        store,
        nextStatus: plan.nextStatus,
        notifications: plan.notifications,
        results: [...results, founderResult],
        now
      })
    : activeDeal;
  return { event, nextStatus: plan.nextStatus, deal: persistedDeal, notifications: plan.notifications, results, founderResult };
}

export async function handleInboundReply({
  deal = {},
  text,
  replierRole = DEAL_ROLE.SELLER,
  env = process.env,
  fetchImpl = globalThis.fetch,
  smsService
} = {}) {
  const reply = parseSmsReply(text);
  const nextRoundCount = reply.intent === REPLY_INTENT.COUNTER
    ? nextNegotiationRound(deal.negotiationRoundCount)
    : Number(deal.negotiationRoundCount) || 0;
  const plan = reply.intent === REPLY_INTENT.COUNTER && shouldEscalateNegotiation(nextRoundCount)
    ? planDealEvent(DEAL_EVENT.ESCALATION)
    : advanceDealOnReply({ intent: reply.intent, message: reply.message, replierRole });
  const results = await sendDealNotifications({ deal, notifications: plan.notifications, env, fetchImpl, smsService });
  return {
    intent: reply.intent,
    keyword: reply.keyword,
    message: reply.message,
    negotiationRoundCount: nextRoundCount,
    nextStatus: plan.nextStatus,
    notifications: plan.notifications,
    results
  };
}

export async function processInboundSms({
  payload = {},
  store = createDealStore(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  smsService,
  now = () => new Date()
} = {}) {
  const inbound = normalizeInboundSmsPayload(payload);
  const deal = await resolveInboundDeal({ payload: inbound, store });
  const replierRole = deal ? resolveReplierRoleByPhone(deal, inbound.from) : null;

  if (inbound.ambiguous) {
    const fallbackRef = inbound.candidateDealIds?.[0] || inbound.dealId || "PENDING";
    const results = await sendDealNotifications({
      deal: {
        dealId: fallbackRef,
        seller: { phone: inbound.from }
      },
      notifications: [{ type: SMS_TYPE.WHICH_DEAL, role: DEAL_ROLE.SELLER }],
      env,
      fetchImpl,
      smsService
    });
    return {
      ok: false,
      resolved: false,
      from: inbound.from,
      dealId: "",
      error: "deal_reference_required",
      candidateDealIds: inbound.candidateDealIds,
      notifications: [{ type: SMS_TYPE.WHICH_DEAL, role: DEAL_ROLE.SELLER }],
      results
    };
  }

  if (!deal || !replierRole) {
    const results = await sendDealNotifications({
      deal: {
        dealId: inbound.dealId || "PENDING",
        seller: { phone: inbound.from }
      },
      notifications: [{ type: SMS_TYPE.NOT_UNDERSTOOD, role: DEAL_ROLE.SELLER }],
      env,
      fetchImpl,
      smsService
    });
    return {
      ok: false,
      resolved: false,
      from: inbound.from,
      dealId: inbound.dealId,
      error: "unknown_sender",
      notifications: [{ type: SMS_TYPE.NOT_UNDERSTOOD, role: DEAL_ROLE.SELLER }],
      results
    };
  }

  const result = await handleInboundReply({
    deal,
    text: inbound.text,
    replierRole,
    env,
    fetchImpl,
    smsService
  });
  const founderResult = await sendFounderNotification({
    deal: { ...deal, status: result.nextStatus || deal.status },
    type: founderTypeForStatus(result.nextStatus),
    env,
    fetchImpl,
    smsService,
    now
  });
  const updatedDeal = await persistInboundState({
    deal,
    store,
    nextStatus: result.nextStatus,
    notifications: result.notifications,
    results: [...result.results, founderResult],
    inbound: { ...inbound, negotiationRoundCount: result.negotiationRoundCount },
    now
  });

  return {
    ok: true,
    resolved: true,
    from: inbound.from,
    dealId: deal.dealId,
    replierRole,
    deal: updatedDeal,
    founderResult,
    ...result
  };
}

export function normalizeInboundSmsPayload(payload = {}) {
  const text = clean(payload.text || payload.message);
  const providerDealId = clean(payload.dealId || payload.linkId || payload.ref);
  return {
    from: clean(payload.from || payload.sender || payload.msisdn),
    to: clean(payload.to || payload.recipient),
    text,
    dealId: providerDealId || extractDealRefFromText(text),
    explicitDealRef: providerDealId || extractDealRefFromText(text),
    linkId: clean(payload.linkId),
    providerMessageId: clean(payload.id || payload.messageId),
    date: clean(payload.date)
  };
}

export function resolveReplierRoleByPhone(deal = {}, phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  if (normalizePhone(deal.buyer?.phone || deal.buyerPhone) === normalized) return DEAL_ROLE.BUYER;
  if (normalizePhone(deal.seller?.phone || deal.sellerPhone) === normalized) return DEAL_ROLE.SELLER;
  return null;
}

async function resolveInboundDeal({ payload, store }) {
  if (payload.dealId) {
    const byId = await store.getDeal(payload.dealId);
    if (byId && resolveReplierRoleByPhone(byId, payload.from)) return byId;
    if (byId) return null;
  }
  if (payload.from && typeof store.findActiveDealsByPhone === "function") {
    const activeDeals = await store.findActiveDealsByPhone(payload.from);
    if (activeDeals.length > 1 && !payload.explicitDealRef) {
      payload.ambiguous = true;
      payload.candidateDealIds = activeDeals.map((deal) => deal.dealId);
      return null;
    }
    if (activeDeals.length === 1) return activeDeals[0];
  }
  return payload.from ? store.findDealByPhone(payload.from) : null;
}

function extractDealRefFromText(text) {
  const tokens = clean(text).match(/[A-Za-z0-9-]{3,24}/g) || [];
  const ignored = new Set(["YES", "NO", "COUNTER", "ACCEPT", "DECLINE", "PAID", "RECEIVED", "DISPUTE", "MSG", "REF"]);
  return tokens.map((token) => token.toUpperCase()).find((token) => !ignored.has(token)) || "";
}

async function upsertDealForNotification({ deal, store }) {
  const dealId = deal.dealId || deal.id || deal.ref;
  if (!dealId) return deal;
  const existing = await store.getDeal(dealId);
  if (existing) return store.updateDeal(dealId, deal);
  return store.saveDeal(deal);
}

async function persistNotificationState({ deal, store, nextStatus, notifications, results = [], now }) {
  const dealId = deal.dealId || deal.id || deal.ref;
  if (!dealId) return deal;
  const patch = {};
  if (nextStatus) patch.status = nextStatus;
  if (notifications.length || results.length) {
    patch.lastNotifiedAt = now().toISOString();
    patch.remindedAt = "";
    patch.notificationLog = appendNotificationLog(deal.notificationLog, buildNotificationLogEntries(results, now));
  }
  const updated = await store.updateDeal(dealId, patch);
  return updated || deal;
}

async function persistInboundState({ deal, store, nextStatus, notifications, results = [], inbound, now }) {
  const timestamp = now().toISOString();
  const patch = {
    lastInboundAt: timestamp,
    inboundProviderMessageId: inbound.providerMessageId,
    remindedAt: "",
    lastNotifiedAt: notifications.length ? timestamp : ""
  };
  if (notifications.length || results.length) patch.notificationLog = appendNotificationLog(deal.notificationLog, buildNotificationLogEntries(results, now));
  if (typeof inbound.negotiationRoundCount === "number") patch.negotiationRoundCount = inbound.negotiationRoundCount;
  if (nextStatus) patch.status = nextStatus;
  if (nextStatus === "complete") {
    patch.completedAt = timestamp;
    patch.feeCollectionStatus = deal.feeCollectionStatus || "pending";
  }
  const updated = await store.updateDeal(deal.dealId, patch);
  return updated || deal;
}

function buildNotificationLogEntries(results = [], now) {
  const timestamp = now().toISOString();
  return results.map((result) => {
    const fallback = !result.ok || result.skipped || result.delivered === false;
    return {
      type: result.type,
      role: result.role,
      to: result.to || "",
      ok: Boolean(result.ok),
      delivered: Boolean(result.delivered),
      skipped: Boolean(result.skipped),
      deliveryChannel: fallback ? "dashboard_fallback" : "sms",
      fallbackReason: fallback ? result.reason || result.error || "sms_delivery_unconfirmed" : "",
      createdAt: timestamp
    };
  });
}

function appendNotificationLog(existing = [], entries = []) {
  return [...(Array.isArray(existing) ? existing : []), ...entries].slice(-50);
}

function founderTypeForDealEvent(event) {
  if (event === DEAL_EVENT.NEW_DEAL) return FOUNDER_SMS_TYPE.NEW_DEAL;
  if (event === DEAL_EVENT.REMINDER) return FOUNDER_SMS_TYPE.STALLED;
  return FOUNDER_SMS_TYPE.DEAL_UPDATE;
}

function founderTypeForStatus(status) {
  if (status === "complete") return FOUNDER_SMS_TYPE.DEAL_CLOSED;
  return FOUNDER_SMS_TYPE.DEAL_UPDATE;
}

function buildFounderTemplateData(deal = {}, now) {
  const data = buildDealTemplateData(deal);
  return {
    ...data,
    buyerPhone: normalizePhone(deal.buyer?.phone || deal.buyerPhone || ""),
    sellerPhone: normalizePhone(deal.seller?.phone || deal.sellerPhone || ""),
    statusLabel: statusLabel(deal.status),
    time: formatFounderTime(now),
    feeCollectionStatus: deal.feeCollectionStatus || deal.collected || "pending"
  };
}

function statusLabel(status) {
  const labels = {
    initiated: "Awaiting seller response",
    approved: "Seller accepted",
    rejected: "Rejected",
    negotiating: "Counter offer sent",
    agreed: "Awaiting payment",
    payment_sent: "Awaiting delivery",
    complete: "Closed",
    disputed: "Disputed",
    escalated: "Escalated"
  };
  return labels[clean(status)] || clean(status) || "Updated";
}

function formatFounderTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()];
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${hours}:${minutes}`;
}

function field(value, maxLength, fallback = "") {
  const text = sanitizeSmsText(value).replace(/\n+/g, " ").trim() || fallback;
  return text.length > maxLength ? text.slice(0, maxLength).trimEnd() : text;
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "0";
  return String(Math.round(number * 100) / 100);
}

function feeMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "0.00";
  return (Math.round(number * 100) / 100).toFixed(2);
}

function enforceFounderLength(text) {
  return text.length > SMS_MAX_LENGTH ? text.slice(0, SMS_MAX_LENGTH).trimEnd() : text;
}

function clean(value) {
  return String(value ?? "").trim();
}
