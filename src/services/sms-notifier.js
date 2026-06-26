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
import { createDealStore, normalizePhone, resolveBusinessId } from "./deal-store.js";
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
    [DEAL_ROLE.OWNER]: deal.owner || {
      name: deal.ownerName || deal.businessName,
      phone: deal.ownerPhone || deal.approvalPhone || deal.sellerPhone
    }
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

// Best-effort persistence: Firestore mirrors the dashboard, but SMS delivery must
// never depend on it. When a Firestore op rejects (it is currently blocked at
// Google's network edge), we log and continue so the SMS still goes out.
async function bestEffortPersist(label, run, fallback = undefined) {
  try {
    return await run();
  } catch (error) {
    console.warn(`Best-effort persistence skipped (${label})`, {
      code: error?.code || "",
      message: error instanceof Error ? error.message : String(error)
    });
    return fallback;
  }
}

export async function startDealAndNotify({
  deal = {},
  store = createDealStore(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  smsService,
  now = () => new Date()
} = {}) {
  const initiatedDeal = { ...deal, status: "initiated", remindedAt: "" };
  const savedDeal = (await bestEffortPersist(
    "startDealAndNotify.saveDeal",
    () => store.saveDeal(initiatedDeal)
  )) || initiatedDeal;
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
  const activeDeal = store
    ? (await bestEffortPersist("sendDealEvent.upsertDeal", () => upsertDealForNotification({ deal, store }))) || deal
    : deal;
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
    ? (await bestEffortPersist("sendDealEvent.persistNotificationState", () => persistNotificationState({
        deal: activeDeal,
        store,
        nextStatus: plan.nextStatus,
        notifications: plan.notifications,
        results: [...results, founderResult],
        now
      }))) || activeDeal
    : activeDeal;
  if (store) {
    await bestEffortPersist("sendDealEvent.persistBusinessOutboundState", () => persistBusinessOutboundState({
      deal: persistedDeal,
      store,
      nextStatus: plan.nextStatus,
      notifications: plan.notifications,
      results,
      now
    }));
  }
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

  await bestEffortPersist("processInboundSms.persistBusinessIncomingState", () =>
    persistBusinessIncomingState({ deal, store, inbound, replierRole, now }));
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
  const updatedDeal = (await bestEffortPersist("processInboundSms.persistInboundState", () => persistInboundState({
    deal,
    store,
    nextStatus: result.nextStatus,
    notifications: result.notifications,
    results: [...result.results, founderResult],
    inbound: { ...inbound, negotiationRoundCount: result.negotiationRoundCount },
    now
  }))) || deal;
  await bestEffortPersist("processInboundSms.persistBusinessClassifiedState", () => persistBusinessClassifiedState({
    deal: updatedDeal,
    originalDeal: deal,
    store,
    result,
    inbound,
    replierRole,
    results: result.results,
    now
  }));

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
  if (normalizePhone(deal.owner?.phone || deal.ownerPhone || deal.approvalPhone) === normalized) return DEAL_ROLE.OWNER;
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
  const ignored = new Set([
    "YES", "YEP", "NO", "NOPE", "OK", "OKAY", "COUNTER", "ACCEPT", "DECLINE", "REJECT",
    "APPROVE", "APPROVED", "PROCEED", "PAID", "RECEIVED", "DISPUTE", "MSG", "REF",
    "CAN", "WE", "DO", "MAKE", "IT", "WHAT", "ABOUT", "TOO", "EXPENSIVE", "PRICE",
    "NDIYO", "SAWA", "KUBALI", "FANYA", "HIYO", "ENDELEA", "HAPANA", "KATAA", "USIENDE",
    "BEI", "NDOGO", "SANA", "GHALI", "NIONGEZE", "ONGEZA", "PUNGUZA"
  ]);
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

async function persistBusinessOutboundState({ deal, store, nextStatus, notifications = [], results = [], now }) {
  if (!canMirrorBusiness(store, deal)) return;
  const timestamp = now().toISOString();
  const status = nextStatus === "initiated" ? "awaiting_sms_reply" : businessStatusFromLegacy(nextStatus || deal.status);
  await store.mirrorBusinessDeal(deal, {
    businessId: resolveBusinessId(deal),
    status,
    approvalStatus: "sms_sent",
    smsState: "waiting",
    smsSentAt: timestamp,
    lastSmsSentAt: timestamp,
    lastNotifiedAt: timestamp
  });
  for (const notification of notifications) {
    const result = results.find((item) => item.role === notification.role && item.type === notification.type) || {};
    await store.appendBusinessConversationMessage({
      deal,
      conversationPatch: businessConversationPatch(deal, timestamp, status),
      message: {
        direction: "outgoing",
        senderRole: "agent",
        recipientRole: notification.role,
        channel: "sms",
        type: notification.type,
        to: result.to || resolveRoleContact(deal, notification.role).phone,
        body: result.message || renderNotification(deal, notification),
        delivered: Boolean(result.delivered),
        deliveryStatus: result.ok ? "sent" : "fallback",
        createdAt: timestamp
      }
    });
  }
  await store.createBusinessNotification({
    deal,
    notification: {
      type: "approval_sms_sent",
      title: "Approval SMS sent",
      message: `Waiting for SMS reply on ${deal.dealId || deal.id || "deal"}.`,
      status: "unread",
      createdAt: timestamp
    }
  });
}

async function persistBusinessIncomingState({ deal, store, inbound, replierRole, now }) {
  if (!canMirrorBusiness(store, deal)) return;
  const timestamp = now().toISOString();
  await store.appendBusinessConversationMessage({
    deal,
    conversationPatch: businessConversationPatch(deal, timestamp, "reply_received"),
    message: {
      direction: "incoming",
      senderRole: replierRole === DEAL_ROLE.OWNER ? "owner" : replierRole,
      channel: "sms",
      from: inbound.from,
      body: inbound.text,
      providerMessageId: inbound.providerMessageId,
      createdAt: timestamp
    }
  });
  await store.mirrorBusinessDeal(deal, {
    businessId: resolveBusinessId(deal),
    status: "reply_received",
    approvalStatus: "processing",
    smsState: "processing",
    replyReceivedAt: timestamp,
    lastInboundAt: timestamp,
    lastReplyText: inbound.text
  });
}

async function persistBusinessClassifiedState({ deal, originalDeal = {}, store, result = {}, inbound = {}, replierRole, results = [], now }) {
  const sourceDeal = deal || originalDeal;
  if (!canMirrorBusiness(store, sourceDeal)) return;
  const timestamp = now().toISOString();
  const status = businessStatusFromIntent(result.intent, result.nextStatus);
  const patch = {
    businessId: resolveBusinessId(sourceDeal),
    status,
    approvalStatus: status,
    smsState: status,
    classifiedAt: timestamp,
    replyIntent: result.intent,
    replyKeyword: result.keyword,
    lastReplyText: inbound.text,
    lastInboundAt: timestamp
  };
  if (status === "approved") {
    patch.approvedAt = timestamp;
    patch.agentConfirmedAt = timestamp;
  }
  if (status === "declined") {
    patch.declinedAt = timestamp;
    patch.agentNotifiedAt = timestamp;
  }
  if (status === "counter") {
    patch.counterText = result.message || inbound.text;
    patch.counterAmount = extractAmount(result.message || inbound.text);
  }
  await store.mirrorBusinessDeal(sourceDeal, patch);
  for (const notificationResult of results) {
    if (!notificationResult.message) continue;
    await store.appendBusinessConversationMessage({
      deal: sourceDeal,
      conversationPatch: businessConversationPatch(sourceDeal, timestamp, status),
      message: {
        direction: "outgoing",
        senderRole: "agent",
        recipientRole: notificationResult.role,
        channel: "sms",
        type: notificationResult.type,
        to: notificationResult.to || "",
        body: notificationResult.message,
        delivered: Boolean(notificationResult.delivered),
        deliveryStatus: notificationResult.ok ? "sent" : "fallback",
        createdAt: timestamp
      }
    });
  }
  await store.createBusinessNotification({
    deal: sourceDeal,
    notification: {
      type: `sms_reply_${status}`,
      title: "SMS reply processed",
      message: `Owner SMS classified as ${status}.`,
      status: "unread",
      replyIntent: result.intent,
      replierRole,
      createdAt: timestamp
    }
  });
}

function canMirrorBusiness(store, deal) {
  return Boolean(store && typeof store.mirrorBusinessDeal === "function" && resolveBusinessId(deal));
}

function businessConversationPatch(deal = {}, timestamp, status) {
  return {
    businessId: resolveBusinessId(deal),
    dealId: deal.dealId || deal.id || deal.ref,
    title: deal.title || deal.dealTitle || deal.serviceDescription || deal.service || "Deal approval",
    status,
    participantName: deal.owner?.name || deal.ownerName || deal.businessName || deal.seller?.name || deal.sellerName || "",
    latestMessageAt: timestamp
  };
}

function businessStatusFromIntent(intent, nextStatus) {
  if (intent === REPLY_INTENT.APPROVE || nextStatus === "approved") return "approved";
  if (intent === REPLY_INTENT.DECLINE || nextStatus === "rejected") return "declined";
  if (intent === REPLY_INTENT.COUNTER || nextStatus === "negotiating") return "counter";
  if (intent === REPLY_INTENT.MESSAGE) return "message";
  return businessStatusFromLegacy(nextStatus);
}

function businessStatusFromLegacy(status) {
  const normalized = clean(status);
  if (normalized === "initiated" || normalized === "pending_human_approval") return "awaiting_sms_reply";
  if (normalized === "rejected") return "declined";
  if (normalized === "negotiating") return "counter";
  return normalized || "awaiting_sms_reply";
}

function extractAmount(text) {
  const value = String(text || "").match(/\d[\d,]*(?:\.\d+)?/)?.[0];
  return value ? Number(value.replace(/,/g, "")) : undefined;
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
