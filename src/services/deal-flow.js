import { SMS_TYPE } from "./sms-templates.js";
import { REPLY_INTENT } from "./sms-replies.js";

export const DEAL_ROLE = Object.freeze({
  BUYER: "buyer",
  SELLER: "seller",
  OWNER: "owner"
});

export const DEAL_FLOW_STATUS = Object.freeze({
  INITIATED: "initiated",
  APPROVED: "approved",
  REJECTED: "rejected",
  NEGOTIATING: "negotiating",
  AGREED: "agreed",
  PAYMENT_SENT: "payment_sent",
  COMPLETE: "complete",
  DISPUTED: "disputed",
  ESCALATED: "escalated"
});

export const DEAL_EVENT = Object.freeze({
  NEW_DEAL: "new_deal",
  WELCOME: "welcome",
  REMINDER: "reminder",
  ESCALATION: "escalation"
});

export function planDealEvent(event) {
  switch (event) {
    case DEAL_EVENT.NEW_DEAL:
      return {
        nextStatus: DEAL_FLOW_STATUS.INITIATED,
        notifications: [notify(SMS_TYPE.NEW_DEAL_REQUEST, DEAL_ROLE.SELLER)]
      };
    case DEAL_EVENT.WELCOME:
      return {
        nextStatus: null,
        notifications: [notify(SMS_TYPE.WELCOME, DEAL_ROLE.OWNER)]
      };
    case DEAL_EVENT.REMINDER:
      return {
        nextStatus: null,
        notifications: [notify(SMS_TYPE.DEAL_REMINDER, DEAL_ROLE.BUYER), notify(SMS_TYPE.DEAL_REMINDER, DEAL_ROLE.SELLER)]
      };
    case DEAL_EVENT.ESCALATION:
      return {
        nextStatus: DEAL_FLOW_STATUS.ESCALATED,
        notifications: [notify(SMS_TYPE.HUMAN_ESCALATION, DEAL_ROLE.OWNER)]
      };
    default:
      throw new Error(`Unknown deal event: ${event}`);
  }
}

export function advanceDealOnReply({ intent, message = "", replierRole = DEAL_ROLE.SELLER } = {}) {
  const partnerRole = replierRole === DEAL_ROLE.BUYER ? DEAL_ROLE.SELLER : DEAL_ROLE.BUYER;

  switch (intent) {
    case REPLY_INTENT.APPROVE:
      return {
        nextStatus: DEAL_FLOW_STATUS.APPROVED,
        notifications: [notify(SMS_TYPE.DEAL_ACCEPTED, DEAL_ROLE.BUYER)]
      };
    case REPLY_INTENT.DECLINE:
      return {
        nextStatus: DEAL_FLOW_STATUS.REJECTED,
        notifications: [notify(SMS_TYPE.DEAL_DECLINED, DEAL_ROLE.BUYER)]
      };
    case REPLY_INTENT.COUNTER:
      return {
        nextStatus: DEAL_FLOW_STATUS.NEGOTIATING,
        notifications: [notify(SMS_TYPE.COUNTER_OFFER, DEAL_ROLE.BUYER)]
      };
    case REPLY_INTENT.ACCEPT:
      // Buyer accepted the counter offer; deal is agreed and now armed for payment.
      // The seller-facing payment SMS (PAYMENT_INCOMING) fires once the buyer sends PAID.
      return { nextStatus: DEAL_FLOW_STATUS.AGREED, notifications: [] };
    case REPLY_INTENT.DECLINE_COUNTER:
      return { nextStatus: DEAL_FLOW_STATUS.REJECTED, notifications: [] };
    case REPLY_INTENT.PAID:
      return {
        nextStatus: DEAL_FLOW_STATUS.PAYMENT_SENT,
        notifications: [notify(SMS_TYPE.PAYMENT_INCOMING, DEAL_ROLE.SELLER)]
      };
    case REPLY_INTENT.RECEIVED:
      return {
        nextStatus: DEAL_FLOW_STATUS.COMPLETE,
        notifications: [
          notify(SMS_TYPE.DEAL_COMPLETE, DEAL_ROLE.BUYER),
          notify(SMS_TYPE.DEAL_COMPLETE, DEAL_ROLE.SELLER),
          notify(SMS_TYPE.FEE_INVOICE_BUYER, DEAL_ROLE.BUYER),
          notify(SMS_TYPE.FEE_INVOICE_SELLER, DEAL_ROLE.SELLER)
        ]
      };
    case REPLY_INTENT.DISPUTE:
      return {
        nextStatus: DEAL_FLOW_STATUS.DISPUTED,
        notifications: [notify(SMS_TYPE.DISPUTE_OPENED, DEAL_ROLE.BUYER), notify(SMS_TYPE.DISPUTE_OPENED, DEAL_ROLE.SELLER)]
      };
    case REPLY_INTENT.MESSAGE:
      return {
        nextStatus: null,
        notifications: [{ type: "relay_message", role: partnerRole, message }]
      };
    default:
      return {
        nextStatus: null,
        notifications: [notify(SMS_TYPE.NOT_UNDERSTOOD, replierRole)]
      };
  }
}

function notify(type, role) {
  return { type, role };
}
