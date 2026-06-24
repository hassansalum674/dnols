import { createSmsService } from "./sms.js";
import {
  SMS_MAX_LENGTH,
  feeAmount,
  renderSmsTemplate,
  sanitizeSmsText
} from "./sms-templates.js";
import { parseSmsReply } from "./sms-replies.js";
import { DEAL_ROLE, advanceDealOnReply, planDealEvent } from "./deal-flow.js";

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

export async function sendDealEvent({ deal = {}, event, env = process.env, fetchImpl = globalThis.fetch, smsService } = {}) {
  const plan = planDealEvent(event);
  const results = await sendDealNotifications({ deal, notifications: plan.notifications, env, fetchImpl, smsService });
  return { event, nextStatus: plan.nextStatus, notifications: plan.notifications, results };
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
