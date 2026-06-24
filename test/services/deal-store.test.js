import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryDealStore } from "../../src/services/deal-store.js";

test("memory deal store saves deals and indexes buyer and seller phones", async () => {
  const store = createMemoryDealStore({ state: { deals: new Map(), phoneIndex: new Map() } });
  const saved = await store.saveDeal({
    dealId: "DL-STORE-1",
    buyer: { name: "Buyer", phone: " +255 712 345 678 " },
    seller: { name: "Seller", phone: "00255798765432" },
    amount: "1200",
    status: "initiated"
  });

  assert.equal(saved.dealId, "DL-STORE-1");
  assert.equal(saved.buyer.phone, "+255712345678");
  assert.equal(saved.seller.phone, "+255798765432");
  assert.equal(saved.amount, 1200);

  assert.equal((await store.findDealByPhone("+255712345678")).dealId, "DL-STORE-1");
  assert.equal((await store.findDealByPhone("+255 798 765 432")).dealId, "DL-STORE-1");
});

test("memory deal store updates active deals and can clear reminder fields", async () => {
  const store = createMemoryDealStore({ state: { deals: new Map(), phoneIndex: new Map() } });
  await store.saveDeal({
    dealId: "DL-STORE-2",
    buyer: { phone: "+255712345678" },
    seller: { phone: "+255798765432" },
    status: "initiated",
    lastNotifiedAt: "2026-06-24T06:00:00.000Z",
    remindedAt: "2026-06-24T08:00:00.000Z"
  });

  const updated = await store.updateDeal("DL-STORE-2", {
    status: "approved",
    lastNotifiedAt: "",
    remindedAt: ""
  });

  assert.equal(updated.status, "approved");
  assert.equal(updated.lastNotifiedAt, undefined);
  assert.equal(updated.remindedAt, undefined);
  assert.deepEqual((await store.listActiveDeals()).map((deal) => deal.dealId), ["DL-STORE-2"]);

  await store.updateDeal("DL-STORE-2", { status: "complete" });
  assert.deepEqual(await store.listActiveDeals(), []);
});
