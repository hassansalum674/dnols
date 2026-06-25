import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryDealStore } from "../../src/services/deal-store.js";
import {
  normalizeInboundSmsPayload,
  processInboundSms,
  resolveReplierRoleByPhone,
  startDealAndNotify
} from "../../src/services/sms-notifier.js";
import { DEAL_EVENT, DEAL_ROLE } from "../../src/services/deal-flow.js";

test("normalizes Africa's Talking inbound webhook fields", () => {
  assert.deepEqual(normalizeInboundSmsPayload({
    from: " +255 798 765 432 ",
    to: "DNOLS",
    text: " YES ",
    linkId: "DL-AT-1",
    id: "AT-id",
    date: "2026-06-24 10:00:00"
  }), {
    from: "+255 798 765 432",
    to: "DNOLS",
    text: "YES",
    dealId: "DL-AT-1",
    explicitDealRef: "DL-AT-1",
    linkId: "DL-AT-1",
    providerMessageId: "AT-id",
    date: "2026-06-24 10:00:00"
  });
});

test("resolves inbound reply role by buyer or seller phone", () => {
  const deal = {
    buyer: { phone: "+255712345678" },
    seller: { phone: "+255798765432" }
  };

  assert.equal(resolveReplierRoleByPhone(deal, "+255 712 345 678"), DEAL_ROLE.BUYER);
  assert.equal(resolveReplierRoleByPhone(deal, "00255798765432"), DEAL_ROLE.SELLER);
  assert.equal(resolveReplierRoleByPhone(deal, "+255700000000"), null);
});

test("processInboundSms resolves seller from phone and persists approved status", async () => {
  const store = createMemoryDealStore({ state: { deals: new Map(), phoneIndex: new Map() } });
  await store.saveDeal({
    dealId: "DL-IN-1",
    status: "initiated",
    buyer: { name: "Buyer", phone: "+255712345678" },
    seller: { name: "Seller", phone: "+255798765432" },
    serviceDescription: "Freight",
    amount: 500,
    lastNotifiedAt: "2026-06-24T06:00:00.000Z",
    remindedAt: "2026-06-24T08:00:00.000Z"
  });
  const sent = [];
  const smsService = {
    async sendSms(input) {
      sent.push(input);
      return { ok: true, skipped: true, to: input.to };
    }
  };

  const result = await processInboundSms({
    payload: { from: "+255 798 765 432", text: "YES", linkId: "DL-IN-1" },
    store,
    smsService,
    now: () => new Date("2026-06-24T10:00:00.000Z")
  });

  assert.equal(result.ok, true);
  assert.equal(result.replierRole, DEAL_ROLE.SELLER);
  assert.equal(result.nextStatus, "approved");
  assert.deepEqual(sent.map((message) => message.to), ["+255712345678"]);

  const updated = await store.getDeal("DL-IN-1");
  assert.equal(updated.status, "approved");
  assert.equal(updated.remindedAt, undefined);
  assert.equal(updated.lastNotifiedAt, "2026-06-24T10:00:00.000Z");
  assert.equal(updated.notificationLog[0].deliveryChannel, "dashboard_fallback");
});

test("processInboundSms asks for a deal ref when a phone has multiple active deals", async () => {
  const store = createMemoryDealStore({ state: { deals: new Map(), phoneIndex: new Map() } });
  await store.saveDeal({
    dealId: "DL-A",
    status: "initiated",
    buyer: { name: "Buyer", phone: "+255712345678" },
    seller: { name: "Seller", phone: "+255798765432" }
  });
  await store.saveDeal({
    dealId: "DL-B",
    status: "negotiating",
    buyer: { name: "Buyer 2", phone: "+255712345679" },
    seller: { name: "Seller", phone: "+255798765432" }
  });
  const sent = [];
  const smsService = {
    async sendSms(input) {
      sent.push(input);
      return { ok: true, skipped: true, to: input.to };
    }
  };

  const result = await processInboundSms({
    payload: { from: "+255798765432", text: "YES" },
    store,
    smsService
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "deal_reference_required");
  assert.deepEqual(result.candidateDealIds, ["DL-A", "DL-B"]);
  assert.match(sent[0].message, /^DNOLS: Which deal/);
});

test("processInboundSms rejects a valid ref from the wrong phone", async () => {
  const store = createMemoryDealStore({ state: { deals: new Map(), phoneIndex: new Map() } });
  await store.saveDeal({
    dealId: "DL-WRONG",
    status: "initiated",
    buyer: { name: "Buyer", phone: "+255712345678" },
    seller: { name: "Seller", phone: "+255798765432" }
  });

  const result = await processInboundSms({
    payload: { from: "+255700000000", text: "YES DL-WRONG" },
    store,
    smsService: { async sendSms(input) { return { ok: true, skipped: true, to: input.to }; } }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "unknown_sender");
});

test("processInboundSms escalates the third counter round", async () => {
  const store = createMemoryDealStore({ state: { deals: new Map(), phoneIndex: new Map() } });
  await store.saveDeal({
    dealId: "DL-COUNTER",
    status: "negotiating",
    negotiationRoundCount: 2,
    buyer: { name: "Buyer", phone: "+255712345678" },
    seller: { name: "Seller", phone: "+255798765432" }
  });

  const result = await processInboundSms({
    payload: { from: "+255798765432", text: "COUNTER 600", linkId: "DL-COUNTER" },
    store,
    smsService: { async sendSms(input) { return { ok: true, skipped: true, to: input.to }; } }
  });

  const updated = await store.getDeal("DL-COUNTER");
  assert.equal(result.nextStatus, "escalated");
  assert.equal(updated.negotiationRoundCount, 3);
  assert.equal(updated.status, "escalated");
});

test("processInboundSms falls back to not understood for unknown senders", async () => {
  const store = createMemoryDealStore({ state: { deals: new Map(), phoneIndex: new Map() } });
  const sent = [];
  const smsService = {
    async sendSms(input) {
      sent.push(input);
      return { ok: true, skipped: true, to: input.to };
    }
  };

  const result = await processInboundSms({
    payload: { from: "+255700000000", text: "YES", linkId: "DL-MISSING" },
    store,
    smsService
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "unknown_sender");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "+255700000000");
  assert.match(sent[0].message, /^DNOLS: Not understood/);
});

test("startDealAndNotify persists a new deal and sends the new deal event", async () => {
  const store = createMemoryDealStore({ state: { deals: new Map(), phoneIndex: new Map() } });
  const sent = [];
  const smsService = {
    async sendSms(input) {
      sent.push(input);
      return { ok: true, skipped: true, to: input.to };
    }
  };

  const result = await startDealAndNotify({
    deal: {
      dealId: "DL-START",
      buyer: { name: "Buyer", phone: "+255712345678" },
      seller: { name: "Seller", phone: "+255798765432" },
      serviceDescription: "Freight",
      amount: 500
    },
    store,
    smsService,
    now: () => new Date("2026-06-24T10:00:00.000Z")
  });

  assert.equal(result.event, DEAL_EVENT.NEW_DEAL);
  assert.equal(result.nextStatus, "initiated");
  assert.deepEqual(sent.map((message) => message.to), ["+255798765432"]);
  assert.equal((await store.getDeal("DL-START")).lastNotifiedAt, "2026-06-24T10:00:00.000Z");
});

test("startDealAndNotify mirrors outbound approval SMS to business-scoped docs", async () => {
  const state = { deals: new Map(), phoneIndex: new Map(), businesses: new Map() };
  const store = createMemoryDealStore({ state });
  const smsService = {
    async sendSms(input) {
      return { ok: true, delivered: true, to: input.to, message: input.message };
    }
  };

  await startDealAndNotify({
    deal: {
      dealId: "DL-BIZ-START",
      ownerUid: "owner-1",
      buyer: { name: "Buyer", phone: "+255712345678" },
      seller: { name: "Seller", phone: "+255798765432" },
      serviceDescription: "Freight",
      amount: 500
    },
    store,
    smsService,
    now: () => new Date("2026-06-24T10:00:00.000Z")
  });

  const business = state.businesses.get("owner-1");
  assert.equal(business.deals.get("DL-BIZ-START").status, "awaiting_sms_reply");
  assert.equal(business.deals.get("DL-BIZ-START").approvalStatus, "sms_sent");
  assert.equal(business.conversations.get("DL-BIZ-START").messages[0].direction, "outgoing");
  assert.equal(business.notifications.size, 1);
});

test("processInboundSms mirrors incoming owner reply and classified approval", async () => {
  const state = { deals: new Map(), phoneIndex: new Map(), businesses: new Map() };
  const store = createMemoryDealStore({ state });
  await store.saveDeal({
    dealId: "DL-BIZ-IN",
    ownerUid: "owner-1",
    status: "initiated",
    owner: { name: "Owner", phone: "+255798765432" },
    buyer: { name: "Buyer", phone: "+255712345678" },
    seller: { name: "Seller", phone: "+255700000000" },
    serviceDescription: "Freight",
    amount: 500
  });

  const result = await processInboundSms({
    payload: { from: "+255798765432", text: "sawa fanya hiyo", linkId: "DL-BIZ-IN" },
    store,
    smsService: { async sendSms(input) { return { ok: true, delivered: true, to: input.to, message: input.message }; } },
    now: () => new Date("2026-06-24T10:00:00.000Z")
  });

  const business = state.businesses.get("owner-1");
  const deal = business.deals.get("DL-BIZ-IN");
  const messages = business.conversations.get("DL-BIZ-IN").messages;
  assert.equal(result.intent, "approve");
  assert.equal(result.replierRole, DEAL_ROLE.OWNER);
  assert.equal(deal.status, "approved");
  assert.equal(deal.approvedAt, "2026-06-24T10:00:00.000Z");
  assert.equal(messages[0].direction, "incoming");
  assert.equal(messages[0].senderRole, "owner");
  assert.equal(business.notifications.get([...business.notifications.keys()][0]).type, "sms_reply_approved");
});

test("startDealAndNotify sends founder admin summary when FOUNDER_PHONE is configured", async () => {
  const store = createMemoryDealStore({ state: { deals: new Map(), phoneIndex: new Map() } });
  const sent = [];
  const smsService = {
    async sendSms(input) {
      sent.push(input);
      return { ok: true, delivered: true, to: input.to };
    }
  };

  const result = await startDealAndNotify({
    deal: {
      dealId: "DNL-2024-0047",
      buyer: { name: "ProTender", phone: "+255734000000" },
      seller: { name: "Orbit Logistics", phone: "+255712000000" },
      amount: 880
    },
    store,
    env: { FOUNDER_PHONE: "+255799999999" },
    smsService,
    now: () => new Date("2026-06-14T09:12:00.000Z")
  });

  assert.deepEqual(sent.map((message) => message.to), ["+255712000000", "+255799999999"]);
  assert.match(sent[1].message, /^DNOLS ADMIN: New deal/);
  assert.match(sent[1].message, /Buyer: ProTender/);
  assert.equal(result.founderResult.to, "+255799999999");
});

test("processInboundSms sends founder deal closed summary on completion", async () => {
  const store = createMemoryDealStore({ state: { deals: new Map(), phoneIndex: new Map() } });
  await store.saveDeal({
    dealId: "DNL-2024-0047",
    status: "payment_sent",
    buyer: { name: "ProTender", phone: "+255734000000" },
    seller: { name: "Orbit Logistics", phone: "+255712000000" },
    amount: 880
  });
  const sent = [];
  const smsService = {
    async sendSms(input) {
      sent.push(input);
      return { ok: true, delivered: true, to: input.to };
    }
  };

  const result = await processInboundSms({
    payload: { from: "+255712000000", text: "RECEIVED", linkId: "DNL-2024-0047" },
    store,
    env: { FOUNDER_PHONE: "+255799999999" },
    smsService,
    now: () => new Date("2026-06-14T10:00:00.000Z")
  });

  const updated = await store.getDeal("DNL-2024-0047");
  assert.equal(result.nextStatus, "complete");
  assert.equal(updated.completedAt, "2026-06-14T10:00:00.000Z");
  assert.match(sent.at(-1).message, /^DNOLS ADMIN: Deal closed/);
  assert.match(sent.at(-1).message, /Fee due: \$17\.60 \(x2\)/);
});
