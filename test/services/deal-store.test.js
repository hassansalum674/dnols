import test from "node:test";
import assert from "node:assert/strict";
import {
  createDealStore,
  createMemoryDealStore,
  createResilientDealStore,
  isFirestoreDegradedError,
  normalizeFirestoreStoreError
} from "../../src/services/deal-store.js";
import {
  getFirebaseAdminDiagnostics,
  getFirebaseAdminConfig,
  initializeFirebaseAdminApp,
  sanitizeFirebaseAdminError,
  describeFirebaseAdminError,
  describeFirestoreTarget
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

test("resilient deal store reports the memory backend when Firestore is disabled", async () => {
  const store = createResilientDealStore({ env: {} });
  const saved = await store.saveDeal({
    dealId: "DL-RESILIENT-MEM",
    seller: { phone: "+255798765432" }
  });

  assert.equal(saved.dealId, "DL-RESILIENT-MEM");
  assert.deepEqual(store.getPersistenceStatus(), {
    ok: true,
    degraded: false,
    backend: "memory",
    reason: ""
  });
});

test("resilient deal store falls back to memory and reports degraded when Firestore rejects", async () => {
  const error = Object.assign(new Error("7 PERMISSION_DENIED: Received HTTP status code 403"), {
    code: "firebase_firestore_permission_denied",
    statusCode: 503
  });
  const reject = async () => { throw error; };
  const primary = {
    saveDeal: reject,
    getDeal: reject,
    findDealByPhone: reject,
    listActiveDeals: reject,
    listDealsByStatus: reject,
    findActiveDealsByPhone: reject,
    updateDeal: reject,
    mirrorBusinessDeal: reject,
    appendBusinessConversationMessage: reject,
    createBusinessNotification: reject
  };
  const store = createResilientDealStore({ env: {}, primary });

  const saved = await store.saveDeal({
    dealId: "DL-RESILIENT-DEGRADED",
    seller: { phone: "+255798765432" }
  });

  assert.equal(saved.dealId, "DL-RESILIENT-DEGRADED");
  const status = store.getPersistenceStatus();
  assert.equal(status.degraded, true);
  assert.equal(status.ok, false);
  assert.equal(status.backend, "memory");
  assert.equal(status.reason, "firebase_firestore_permission_denied");
});

test("resilient deal store rethrows errors that are not Firestore connectivity failures", async () => {
  const primary = {
    saveDeal: async () => { throw new Error("unexpected bug"); }
  };
  const store = createResilientDealStore({ env: {}, primary });

  await assert.rejects(() => store.saveDeal({ dealId: "DL-RESILIENT-BUG" }), /unexpected bug/);
});

test("isFirestoreDegradedError flags Firestore permission and availability failures only", () => {
  assert.equal(isFirestoreDegradedError(Object.assign(new Error("denied"), {
    code: "firebase_firestore_permission_denied"
  })), true);
  assert.equal(isFirestoreDegradedError(Object.assign(new Error("down"), { statusCode: 503 })), true);
  assert.equal(isFirestoreDegradedError(Object.assign(new Error("forbidden"), { status: 403 })), true);
  assert.equal(isFirestoreDegradedError(new Error("some unrelated bug")), false);
  assert.equal(isFirestoreDegradedError(undefined), false);
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

test("Firebase Admin diagnostics report sanitized credential source and project mismatch", () => {
  const config = getFirebaseAdminConfig({
    FIREBASE_PROJECT_ID: "dnols-prod",
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      project_id: "dnols-staging",
      client_email: "firebase-admin@example.com",
      private_key: "redacted-test-key",
      private_key_id: "redacted-test-key-id",
      client_id: "redacted-test-client-id",
      token_uri: "https://oauth2.googleapis.com/token"
    })
  });
  const diagnostics = getFirebaseAdminDiagnostics(config);

  assert.deepEqual(diagnostics, {
    enabled: true,
    projectId: "dnols-prod",
    explicitProjectId: true,
    serviceAccountProjectId: "dnols-staging",
    serviceAccountEmail: "firebase-admin@example.com",
    projectIdMismatch: true,
    credentialSource: "FIREBASE_SERVICE_ACCOUNT_JSON",
    serviceAccountJsonValid: true,
    hasDatabaseURL: false,
    hasFirebaseProjectId: true,
    hasGoogleCloudProject: false,
    hasServiceAccountJson: true,
    hasGoogleApplicationCredentials: false
  });
  assert.equal(Object.hasOwn(diagnostics, "private_key"), false);
  assert.equal(Object.hasOwn(diagnostics, "private_key_id"), false);
  assert.equal(Object.hasOwn(diagnostics, "client_id"), false);
  assert.equal(Object.hasOwn(diagnostics, "token_uri"), false);
  assert.equal(Object.hasOwn(diagnostics, "serviceAccountJson"), false);
});

test("Firestore permission failures are mapped to safe Firebase configuration errors", () => {
  const originalError = new Error("7 PERMISSION_DENIED: Received HTTP status code 403");
  originalError.code = 7;
  const config = getFirebaseAdminConfig({
    FIREBASE_PROJECT_ID: "dnols-prod",
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: "dnols-prod" })
  });
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);

  try {
    const error = normalizeFirestoreStoreError(originalError, config, "getDeal");

    assert.equal(error.code, "firebase_firestore_permission_denied");
    assert.equal(error.statusCode, 503);
    assert.match(error.publicMessage, /Firebase Admin cannot access Firestore/);
    assert.match(error.publicMessage, /dnols-prod/);
    assert.equal(error.cause, originalError);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][1].firebase.credentialSource, "FIREBASE_SERVICE_ACCOUNT_JSON");
    assert.equal(logs[0][1].firebase.serviceAccountProjectId, "dnols-prod");
    assert.equal(logs[0][1].operation, "getDeal");
  } finally {
    console.error = originalConsoleError;
  }
});

test("Firebase Admin error sanitizer redacts secret-looking values", () => {
  const error = new Error("private_key=\"-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----\" Bearer secret-token");
  error.code = "permission-denied";
  error.details = "access_token=ya29.secret-token private_key_id=key-id";
  error.status = 403;

  const sanitized = sanitizeFirebaseAdminError(error);
  const serialized = JSON.stringify(sanitized);

  assert.equal(sanitized.code, "permission-denied");
  assert.equal(sanitized.status, "403");
  assert.match(sanitized.message, /\[redacted\]/);
  assert.match(sanitized.details, /\[redacted\]/);
  assert.doesNotMatch(serialized, /secret-token|PRIVATE KEY|key-id|ya29\./);
});

test("describeFirebaseAdminError exposes full untruncated error without secrets", () => {
  const longDetail = "Cloud Firestore API has not been used in project dnols-2a394 before or it is disabled. " + "x".repeat(600);
  const error = new Error(`7 PERMISSION_DENIED: ${longDetail}`);
  error.code = 7;
  error.details = longDetail;
  error.metadata = { getMap: () => ({ "www-authenticate": "Bearer ya29.secret-token" }) };
  error.private_key = "-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----";

  const described = describeFirebaseAdminError(error);
  const serialized = JSON.stringify(described);

  assert.equal(described.grpcCode, 7);
  assert.equal(described.code, "7");
  assert.equal(described.name, "Error");
  assert.ok(described.fullMessage.length > 500, "fullMessage should not be truncated to 500 chars");
  assert.match(described.fullMessage, /Cloud Firestore API has not been used/);
  assert.match(described.details, /Cloud Firestore API has not been used/);
  assert.match(described.metadata, /Bearer \[redacted\]/);
  assert.ok(described.stack.split("\n").length <= 5, "stack should be capped to ~5 lines");
  assert.doesNotMatch(serialized, /secret-token|PRIVATE KEY|ya29\.|BEGIN PRIVATE KEY/);
});

test("describeFirestoreTarget detects the (default) database safely", () => {
  const target = describeFirestoreTarget({ _databaseId: { database: "(default)", projectId: "dnols-2a394" } });
  assert.equal(target.databaseId, "(default)");
  assert.equal(target.isDefaultDatabase, true);
  assert.equal(target.projectId, "dnols-2a394");
  assert.doesNotThrow(() => describeFirestoreTarget(undefined));
});
