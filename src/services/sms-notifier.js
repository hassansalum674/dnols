import { createSmsService } from "./sms.js";
import {
  SMS_MAX_LENGTH,
  SMS_TYPE,
  feeAmount,
  renderSmsTemplate,
  sanitizeSmsText
} from "./sms-templates.js";
import { parseSmsReply } from "./sms-replies.js";
import { DEAL_EVENT, DEAL_ROLE, advanceDealOnReply, planDealEvent } from "./deal-flow.js";
import { createDealStore, normalizePhone } from "./deal-store.js";

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
  const persistedDeal = store
    ? await persistNotificationState({
        deal: activeDeal,
        store,
        nextStatus: plan.nextStatus,
        notifications: plan.notifications,
        now
      })
    : activeDeal;
  return { event, nextStatus: plan.nextStatus, deal: persistedDeal, notifications: plan.notifications, results };
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
  const plan = advanceDealOnReply({ intent: reply.intent, message: reply.message, replierRole });
  const results = await sendDealNotifications({ deal, notifications: plan.notifications, env, fetchImpl, smsService });
  return {
    intent: reply.intent,
    keyword: reply.keyword,
    message: reply.message,
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
  const updatedDeal = await persistInboundState({
    deal,
    store,
    nextStatus: result.nextStatus,
    notifications: result.notifications,
    inbound,
    now
  });

  return {
    ok: true,
    resolved: true,
    from: inbound.from,
    dealId: deal.dealId,
    replierRole,
    deal: updatedDeal,
    ...result
  };
}

export function normalizeInboundSmsPayload(payload = {}) {
  return {
    from: clean(payload.from || payload.sender || payload.msisdn),
    to: clean(payload.to || payload.recipient),
    text: clean(payload.text || payload.message),
    dealId: clean(payload.dealId || payload.linkId || payload.ref),
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
    if (byId) return byId;
  }
  return payload.from ? store.findDealByPhone(payload.from) : null;
}

async function upsertDealForNotification({ deal, store }) {
  const dealId = deal.dealId || deal.id || deal.ref;
  if (!dealId) return deal;
  const existing = await store.getDeal(dealId);
  if (existing) return store.updateDeal(dealId, deal);
  return store.saveDeal(deal);
}

async function persistNotificationState({ deal, store, nextStatus, notifications, now }) {
  const dealId = deal.dealId || deal.id || deal.ref;
  if (!dealId) return deal;
  const patch = {};
  if (nextStatus) patch.status = nextStatus;
  if (notifications.length) {
    patch.lastNotifiedAt = now().toISOString();
    patch.remindedAt = "";
  }
  const updated = await store.updateDeal(dealId, patch);
  return updated || deal;
}

async function persistInboundState({ deal, store, nextStatus, notifications, inbound, now }) {
  const timestamp = now().toISOString();
  const patch = {
    lastInboundAt: timestamp,
    inboundProviderMessageId: inbound.providerMessageId,
    remindedAt: "",
    lastNotifiedAt: notifications.length ? timestamp : ""
  };
  if (nextStatus) patch.status = nextStatus;
  const updated = await store.updateDeal(deal.dealId, patch);
  return updated || deal;
}

function clean(value) {
  return String(value ?? "").trim();
}
