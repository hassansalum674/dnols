import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryDealStore } from "../../src/services/deal-store.js";
import {
  runDealReminders,
  runFounderFeeReminders,
  selectDealsNeedingReminder,
  selectDealsWithUnpaidFees
} from "../../src/services/deal-reminders.js";

const now = new Date("2026-06-24T10:00:00.000Z");

test("selectDealsNeedingReminder returns active waiting deals older than the window", () => {
  const due = {
    dealId: "DL-DUE",
    status: "initiated",
    lastNotifiedAt: "2026-06-24T07:59:00.000Z"
  };
  const recent = {
    dealId: "DL-RECENT",
    status: "initiated",
    lastNotifiedAt: "2026-06-24T09:00:00.000Z"
  };
  const reminded = {
    dealId: "DL-REM",
    status: "initiated",
    lastNotifiedAt: "2026-06-24T07:00:00.000Z",
    remindedAt: "2026-06-24T09:30:00.000Z"
  };
  const complete = {
    dealId: "DL-DONE",
    status: "complete",
    lastNotifiedAt: "2026-06-24T07:00:00.000Z"
  };

  assert.deepEqual(
    selectDealsNeedingReminder([due, recent, reminded, complete], now).map((deal) => deal.dealId),
    ["DL-DUE"]
  );
});

test("runDealReminders sends reminder SMS and marks the deal reminded", async () => {
  const store = createMemoryDealStore({ state: { deals: new Map(), phoneIndex: new Map() } });
  await store.saveDeal({
    dealId: "DL-RUN",
    status: "initiated",
    buyer: { name: "Buyer", phone: "+255712345678" },
    seller: { name: "Seller", phone: "+255798765432" },
    serviceDescription: "Freight",
    amount: 500,
    lastNotifiedAt: "2026-06-24T07:00:00.000Z"
  });
  const sent = [];
  const smsService = {
    async sendSms(input) {
      sent.push(input);
      return { ok: true, skipped: true, to: input.to };
    }
  };

  const result = await runDealReminders({
    store,
    smsService,
    now: () => now
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.reminded, 1);
  assert.deepEqual(sent.map((message) => message.to).sort(), ["+255712345678", "+255798765432"]);
  assert.ok(sent.every((message) => message.message.startsWith("DNOLS:")));

  const updated = await store.getDeal("DL-RUN");
  assert.equal(updated.remindedAt, "2026-06-24T10:00:00.000Z");
  assert.equal(updated.lastNotifiedAt, "2026-06-24T10:00:00.000Z");
});

test("runDealReminders sends founder stalled summary when configured", async () => {
  const store = createMemoryDealStore({ state: { deals: new Map(), phoneIndex: new Map() } });
  await store.saveDeal({
    dealId: "DNL-2024-0047",
    status: "initiated",
    buyer: { name: "ProTender", phone: "+255734000000" },
    seller: { name: "Orbit Logistics", phone: "+255712000000" },
    amount: 880,
    lastNotifiedAt: "2026-06-24T07:00:00.000Z"
  });
  const sent = [];
  const smsService = {
    async sendSms(input) {
      sent.push(input);
      return { ok: true, delivered: true, to: input.to };
    }
  };

  await runDealReminders({
    store,
    env: { FOUNDER_PHONE: "+255799999999" },
    smsService,
    now: () => now
  });

  assert.equal(sent.at(-1).to, "+255799999999");
  assert.match(sent.at(-1).message, /^DNOLS ADMIN: Deal stalled/);
  assert.match(sent.at(-1).message, /Call to remind them/);
});

test("selectDealsWithUnpaidFees returns completed unpaid deals after 24 hours", () => {
  const due = {
    dealId: "DL-DUE-FEE",
    status: "complete",
    completedAt: "2026-06-23T09:00:00.000Z",
    feeCollectionStatus: "pending"
  };
  const paid = {
    dealId: "DL-PAID-FEE",
    status: "complete",
    completedAt: "2026-06-23T09:00:00.000Z",
    feeCollectionStatus: "paid"
  };
  const recent = {
    dealId: "DL-RECENT-FEE",
    status: "complete",
    completedAt: "2026-06-24T09:00:00.000Z",
    feeCollectionStatus: "pending"
  };

  assert.deepEqual(
    selectDealsWithUnpaidFees([due, paid, recent], now).map((deal) => deal.dealId),
    ["DL-DUE-FEE"]
  );
});

test("runFounderFeeReminders sends founder unpaid-fee summary once", async () => {
  const store = createMemoryDealStore({ state: { deals: new Map(), phoneIndex: new Map() } });
  await store.saveDeal({
    dealId: "DNL-2024-0047",
    status: "complete",
    buyer: { name: "ProTender", phone: "+255734000000" },
    seller: { name: "Orbit Logistics", phone: "+255712000000" },
    amount: 880,
    completedAt: "2026-06-23T09:00:00.000Z",
    feeCollectionStatus: "pending"
  });
  const sent = [];
  const smsService = {
    async sendSms(input) {
      sent.push(input);
      return { ok: true, delivered: true, to: input.to };
    }
  };

  const result = await runFounderFeeReminders({
    store,
    env: { FOUNDER_PHONE: "+255799999999" },
    smsService,
    now: () => now
  });

  assert.equal(result.reminded, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "+255799999999");
  assert.match(sent[0].message, /^DNOLS ADMIN: Fee unpaid/);
  assert.match(sent[0].message, /Fee: \$8\.80/);
  assert.equal((await store.getDeal("DNL-2024-0047")).founderFeeUnpaidNotifiedAt, "2026-06-24T10:00:00.000Z");
});
