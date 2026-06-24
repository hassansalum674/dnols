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
