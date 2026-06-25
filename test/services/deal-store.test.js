import test from "node:test";
import assert from "node:assert/strict";
import { createDealStore, createMemoryDealStore } from "../../src/services/deal-store.js";
import {
  getFirebaseAdminConfig,
  initializeFirebaseAdminApp
} from "../../src/services/firebase-admin.js";

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

test("deal store uses memory backend when Firebase config is absent", async () => {
  const store = createDealStore({ env: {} });

  const saved = await store.saveDeal({
    dealId: "DL-MEMORY-FALLBACK",
    buyer: { phone: "+255712345678" },
    seller: { phone: "+255798765432" }
  });

  assert.equal(saved.dealId, "DL-MEMORY-FALLBACK");
  assert.equal((await store.getDeal("DL-MEMORY-FALLBACK")).seller.phone, "+255798765432");
});

test("Firebase Admin helper initializes from modular ESM app exports", () => {
  const initialized = [];
  const fakeCredential = { type: "credential" };
  const appModule = {
    cert(serviceAccount) {
      assert.equal(serviceAccount.project_id, "dnols-prod");
      assert.equal(serviceAccount.client_email, "firebase-admin@example.com");
      assert.equal(serviceAccount.private_key, "redacted-test-key");
      return fakeCredential;
    },
    getApps() {
      return [];
    },
    initializeApp(options) {
      initialized.push(options);
      return { name: "[DEFAULT]" };
    }
  };

  const app = initializeFirebaseAdminApp(appModule, getFirebaseAdminConfig({
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      project_id: "dnols-prod",
      client_email: "firebase-admin@example.com",
      private_key: "redacted-test-key"
    }),
    FIREBASE_DATABASE_URL: "https://dnols-prod.firebaseio.com"
  }));

  assert.deepEqual(app, { name: "[DEFAULT]" });
  assert.equal(initialized.length, 1);
  assert.equal(initialized[0].projectId, "dnols-prod");
  assert.equal(initialized[0].databaseURL, "https://dnols-prod.firebaseio.com");
  assert.equal(initialized[0].credential, fakeCredential);
});
