import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryDealStore } from "../../src/services/deal-store.js";
import { runDealReminders, selectDealsNeedingReminder } from "../../src/services/deal-reminders.js";

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
