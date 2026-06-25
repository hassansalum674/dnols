import { normalizePhoneNumber } from "./sms.js";
import {
  getFirebaseAdminConfig,
  getFirebaseAdminDiagnostics,
  isFirebaseAdminModuleMissing,
  loadFirestore
} from "./firebase-admin.js";

const DEFAULT_COLLECTION = "deals";
const DEFAULT_PHONE_INDEX_COLLECTION = "dealPhoneIndex";

const memoryState = {
  deals: new Map(),
  phoneIndex: new Map(),
  businesses: new Map()
};

export function createDealStore({ env = process.env, now = () => new Date() } = {}) {
  const memory = createMemoryDealStore({ state: memoryState, now });
  const firestoreConfig = getFirestoreConfig(env);
  if (!firestoreConfig.enabled) return memory;

  let firestoreStore;
  const runFirestoreOperation = async (operation, method, ...args) => {
    try {
      firestoreStore ||= await createFirestoreDealStore(firestoreConfig, memory, now);
      return await firestoreStore[method](...args);
    } catch (error) {
      throw normalizeFirestoreStoreError(error, firestoreConfig, operation);
    }
  };
  return {
    async saveDeal(deal = {}) {
      return runFirestoreOperation("saveDeal", "saveDeal", deal);
    },
    async getDeal(dealId) {
      return runFirestoreOperation("getDeal", "getDeal", dealId);
    },
    async findDealByPhone(phone) {
      return runFirestoreOperation("findDealByPhone", "findDealByPhone", phone);
    },
    async listActiveDeals() {
      return runFirestoreOperation("listActiveDeals", "listActiveDeals");
    },
    async listDealsByStatus(statuses = []) {
      return runFirestoreOperation("listDealsByStatus", "listDealsByStatus", statuses);
    },
    async findActiveDealsByPhone(phone) {
      return runFirestoreOperation("findActiveDealsByPhone", "findActiveDealsByPhone", phone);
    },
    async updateDeal(dealId, patch = {}) {
      return runFirestoreOperation("updateDeal", "updateDeal", dealId, patch);
    },
    async mirrorBusinessDeal(deal = {}, patch = {}) {
      return runFirestoreOperation("mirrorBusinessDeal", "mirrorBusinessDeal", deal, patch);
    },
    async appendBusinessConversationMessage(input = {}) {
      return runFirestoreOperation("appendBusinessConversationMessage", "appendBusinessConversationMessage", input);
    },
    async createBusinessNotification(input = {}) {
      return runFirestoreOperation("createBusinessNotification", "createBusinessNotification", input);
    }
  };
}

export function createMemoryDealStore({ state = { deals: new Map(), phoneIndex: new Map(), businesses: new Map() }, now = () => new Date() } = {}) {
  state.businesses ||= new Map();
  return {
    async saveDeal(deal = {}) {
      const normalized = normalizeDeal(deal, { now });
      state.deals.set(normalized.dealId, normalized);
      indexDealPhones(state.phoneIndex, normalized);
      return clone(normalized);
    },
    async getDeal(dealId) {
      return clone(state.deals.get(clean(dealId)) || null);
    },
    async findDealByPhone(phone) {
      const normalizedPhone = normalizePhone(phone);
      const dealId = normalizedPhone ? state.phoneIndex.get(normalizedPhone) : "";
      return clone(dealId ? state.deals.get(dealId) || null : null);
    },
    async listActiveDeals() {
      return [...state.deals.values()].filter(isActiveDeal).map(clone);
    },
    async listDealsByStatus(statuses = []) {
      const allowed = new Set(statuses.map(clean).filter(Boolean));
      return [...state.deals.values()]
        .filter((deal) => allowed.has(clean(deal.status)))
        .map(clone);
    },
    async findActiveDealsByPhone(phone) {
      const normalizedPhone = normalizePhone(phone);
      return [...state.deals.values()]
        .filter((deal) => isActiveDeal(deal) && dealHasPhone(deal, normalizedPhone))
        .map(clone);
    },
    async updateDeal(dealId, patch = {}) {
      const id = clean(dealId);
      const existing = state.deals.get(id);
      if (!existing) return null;
      const updated = normalizeDeal({ ...existing, ...patch, dealId: id }, { now, existing });
      state.deals.set(id, updated);
      indexDealPhones(state.phoneIndex, updated);
      return clone(updated);
    },
    async mirrorBusinessDeal(deal = {}, patch = {}) {
      const businessId = resolveBusinessId({ ...deal, ...patch });
      const dealId = clean(patch.dealId || deal.dealId || deal.id || deal.ref);
      if (!businessId || !dealId) return null;
      const business = ensureMemoryBusiness(state.businesses, businessId);
      const existing = business.deals.get(dealId) || {};
      const mirrored = {
        ...existing,
        ...deal,
        ...patch,
        businessId,
        dealId,
        id: dealId,
        updatedAt: iso(now())
      };
      business.deals.set(dealId, pruneEmpty(mirrored));
      return clone(business.deals.get(dealId));
    },
    async appendBusinessConversationMessage({ deal = {}, message = {}, conversationPatch = {} } = {}) {
      const businessId = resolveBusinessId({ ...deal, ...conversationPatch });
      const dealId = clean(conversationPatch.dealId || deal.dealId || deal.id || deal.ref);
      if (!businessId || !dealId) return null;
      const business = ensureMemoryBusiness(state.businesses, businessId);
      const existing = business.conversations.get(dealId) || { messages: [] };
      const createdAt = clean(message.createdAt) || iso(now());
      const entry = pruneEmpty({
        id: message.id || `${createdAt}-${existing.messages.length}`,
        ...message,
        createdAt
      });
      const conversation = pruneEmpty({
        ...existing,
        ...conversationPatch,
        businessId,
        dealId,
        id: dealId,
        latestMessage: entry.body || entry.text || "",
        latestMessageAt: createdAt,
        updatedAt: iso(now()),
        messages: [...(Array.isArray(existing.messages) ? existing.messages : []), entry].slice(-100)
      });
      business.conversations.set(dealId, conversation);
      return clone(conversation);
    },
    async createBusinessNotification({ deal = {}, notification = {} } = {}) {
      const businessId = resolveBusinessId({ ...deal, ...notification });
      if (!businessId) return null;
      const business = ensureMemoryBusiness(state.businesses, businessId);
      const id = notification.id || `${iso(now())}-${business.notifications.size}`;
      const entry = pruneEmpty({
        ...notification,
        id,
        businessId,
        dealId: clean(notification.dealId || deal.dealId || deal.id || deal.ref),
        createdAt: notification.createdAt || iso(now())
      });
      business.notifications.set(id, entry);
      return clone(entry);
    }
  };
}

export function normalizeDeal(deal = {}, { now = () => new Date(), existing = {} } = {}) {
  const dealId = clean(deal.dealId || deal.id || deal.ref);
  if (!dealId) {
    throw new Error("Deal id is required.");
  }

  const field = (name) => Object.hasOwn(deal, name) ? deal[name] : existing[name];
  const createdAt = clean(deal.createdAt || existing.createdAt) || iso(now());
  return pruneEmpty({
    ...existing,
    ...deal,
    dealId,
    id: dealId,
    status: clean(deal.status || existing.status || "initiated"),
    buyer: normalizeContact(deal.buyer || existing.buyer || { name: deal.buyerName, phone: deal.buyerPhone }),
    seller: normalizeContact(deal.seller || existing.seller || { name: deal.sellerName, phone: deal.sellerPhone }),
    owner: normalizeContact(deal.owner || existing.owner || {
      name: deal.ownerName || deal.businessName || deal.sellerName,
      phone: deal.ownerPhone || deal.sellerPhone
    }),
    amount: numberOrUndefined(deal.amount ?? deal.budgetAmount ?? existing.amount),
    serviceDescription: clean(deal.serviceDescription || deal.service || deal.requirements || existing.serviceDescription),
    deadline: clean(deal.deadline || deal.dueDate || existing.deadline),
    newAmount: numberOrUndefined(deal.newAmount ?? deal.counterAmount ?? existing.newAmount),
    newTerms: clean(deal.newTerms || deal.counterTerms || existing.newTerms),
    payNumber: clean(deal.payNumber || deal.mpesaNumber || existing.payNumber),
    createdAt,
    updatedAt: iso(now()),
    lastNotifiedAt: clean(field("lastNotifiedAt")),
    remindedAt: clean(field("remindedAt"))
  });
}

function getFirestoreConfig(env = {}) {
  const explicitlyEnabled = /^(firestore|firebase)$/i.test(clean(env.DEAL_STORE_BACKEND));
  const adminConfig = getFirebaseAdminConfig(env);
  return {
    ...adminConfig,
    enabled: explicitlyEnabled || adminConfig.enabled,
    collectionName: clean(env.DEAL_STORE_COLLECTION) || DEFAULT_COLLECTION,
    phoneIndexCollectionName: clean(env.DEAL_PHONE_INDEX_COLLECTION) || DEFAULT_PHONE_INDEX_COLLECTION
  };
}

async function createFirestoreDealStore(config, fallback, now) {
  let db;
  try {
    db = await loadFirestore(config);
  } catch (error) {
    if (isFirebaseAdminModuleMissing(error)) return fallback;
    throw error;
  }

  const deals = db.collection(config.collectionName);
  const phoneIndex = db.collection(config.phoneIndexCollectionName);

  return {
    async saveDeal(deal = {}) {
      const normalized = normalizeDeal(deal, { now });
      await deals.doc(normalized.dealId).set(normalized, { merge: true });
      await writePhoneIndex(phoneIndex, normalized);
      return normalized;
    },
    async getDeal(dealId) {
      const snapshot = await deals.doc(clean(dealId)).get();
      return snapshot.exists ? snapshot.data() : null;
    },
    async findDealByPhone(phone) {
      const normalizedPhone = normalizePhone(phone);
      if (!normalizedPhone) return null;
      const snapshot = await phoneIndex.doc(phoneIndexId(normalizedPhone)).get();
      if (!snapshot.exists) return null;
      return this.getDeal(snapshot.data().dealId);
    },
    async listActiveDeals() {
      const snapshot = await deals.where("status", "in", ["initiated", "approved", "negotiating", "agreed", "payment_sent"]).get();
      return snapshot.docs.map((doc) => doc.data()).filter(isActiveDeal);
    },
    async listDealsByStatus(statuses = []) {
      const allowed = statuses.map(clean).filter(Boolean).slice(0, 10);
      if (!allowed.length) return [];
      const snapshot = await deals.where("status", "in", allowed).get();
      return snapshot.docs.map((doc) => doc.data());
    },
    async findActiveDealsByPhone(phone) {
      const normalizedPhone = normalizePhone(phone);
      const activeDeals = await this.listActiveDeals();
      return activeDeals.filter((deal) => dealHasPhone(deal, normalizedPhone));
    },
    async updateDeal(dealId, patch = {}) {
      const existing = (await this.getDeal(dealId)) || {};
      if (!existing.dealId && !existing.id) return null;
      const updated = normalizeDeal({ ...existing, ...patch, dealId }, { now, existing });
      await deals.doc(updated.dealId).set(updated, { merge: true });
      await writePhoneIndex(phoneIndex, updated);
      return updated;
    },
    async mirrorBusinessDeal(deal = {}, patch = {}) {
      const businessId = resolveBusinessId({ ...deal, ...patch });
      const dealId = clean(patch.dealId || deal.dealId || deal.id || deal.ref);
      if (!businessId || !dealId) return null;
      const mirrored = pruneEmpty({
        ...deal,
        ...patch,
        businessId,
        dealId,
        id: dealId,
        updatedAt: iso(now())
      });
      await db.collection("businesses").doc(businessId).collection("deals").doc(dealId).set(mirrored, { merge: true });
      return mirrored;
    },
    async appendBusinessConversationMessage({ deal = {}, message = {}, conversationPatch = {} } = {}) {
      const businessId = resolveBusinessId({ ...deal, ...conversationPatch });
      const dealId = clean(conversationPatch.dealId || deal.dealId || deal.id || deal.ref);
      if (!businessId || !dealId) return null;
      const conversationRef = db.collection("businesses").doc(businessId).collection("conversations").doc(dealId);
      const snapshot = await conversationRef.get();
      const existing = snapshot.exists ? snapshot.data() : {};
      const createdAt = clean(message.createdAt) || iso(now());
      const entry = pruneEmpty({
        id: message.id || `${createdAt}-${Array.isArray(existing.messages) ? existing.messages.length : 0}`,
        ...message,
        createdAt
      });
      const messages = [...(Array.isArray(existing.messages) ? existing.messages : []), entry].slice(-100);
      const conversation = pruneEmpty({
        ...conversationPatch,
        businessId,
        dealId,
        id: dealId,
        latestMessage: entry.body || entry.text || "",
        latestMessageAt: createdAt,
        updatedAt: iso(now()),
        messages
      });
      await conversationRef.set(conversation, { merge: true });
      return conversation;
    },
    async createBusinessNotification({ deal = {}, notification = {} } = {}) {
      const businessId = resolveBusinessId({ ...deal, ...notification });
      if (!businessId) return null;
      const ref = db.collection("businesses").doc(businessId).collection("notifications").doc();
      const entry = pruneEmpty({
        ...notification,
        id: ref.id,
        businessId,
        dealId: clean(notification.dealId || deal.dealId || deal.id || deal.ref),
        createdAt: notification.createdAt || iso(now())
      });
      await ref.set(entry, { merge: true });
      return entry;
    }
  };
}

export function normalizeFirestoreStoreError(error, config = {}, operation = "unknown") {
  if (isFirebaseAdminModuleMissing(error) || isStoreConfigurationError(error)) return error;

  const diagnostics = getFirebaseAdminDiagnostics(config);
  const code = firestoreStoreErrorCode(error);
  if (!code) return error;

  const wrapped = new Error(firestoreStoreErrorMessage(code, diagnostics));
  wrapped.code = code;
  wrapped.statusCode = 503;
  wrapped.publicMessage = wrapped.message;
  wrapped.operation = operation;
  wrapped.diagnostics = diagnostics;
  wrapped.cause = error;

  console.error("Firestore deal store operation failed", {
    code,
    operation,
    firebase: diagnostics,
    causeCode: clean(error?.code || error?.errorInfo?.code),
    causeMessage: truncate(clean(error?.message), 240)
  });

  return wrapped;
}

function firestoreStoreErrorCode(error) {
  const code = clean(error?.code || error?.errorInfo?.code);
  const message = clean(error?.message);
  const details = clean(error?.details);
  const status = Number(error?.status || error?.statusCode || error?.httpStatus);
  const combined = `${code} ${message} ${details}`;

  if (code === "firebase_admin_service_account_invalid") return "firebase_admin_service_account_invalid";
  if (status === 403 || code === "7" || /permission_denied|status code 403|forbidden/i.test(combined)) {
    return "firebase_firestore_permission_denied";
  }
  if (/firestore.*not.*enabled|cloud datastore.*not.*enabled|database.*not.*found|not_found|failed_precondition/i.test(combined)) {
    return "firebase_firestore_not_available";
  }
  return "";
}

function firestoreStoreErrorMessage(code, diagnostics = {}) {
  const project = diagnostics.projectId || "unspecified";
  if (code === "firebase_admin_service_account_invalid") {
    return "Firebase Admin is misconfigured: FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.";
  }
  if (code === "firebase_firestore_not_available") {
    return `Firestore is not available for Firebase project "${project}". Enable Cloud Firestore in Native mode and verify the configured project.`;
  }
  const mismatch = diagnostics.projectIdMismatch
    ? " The configured FIREBASE_PROJECT_ID does not match the service account project_id."
    : "";
  return `Firebase Admin cannot access Firestore for project "${project}". Check FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_PROJECT_ID, Firestore API status, and service account IAM permissions.${mismatch}`;
}

function isStoreConfigurationError(error) {
  return String(error?.code || "").startsWith("firebase_firestore_");
}

async function writePhoneIndex(collection, deal) {
  const entries = phoneIndexEntries(deal);
  await Promise.all(entries.map(([phone, role]) =>
    collection.doc(phoneIndexId(phone)).set({ phone, role, dealId: deal.dealId, updatedAt: deal.updatedAt }, { merge: true })
  ));
}

function indexDealPhones(index, deal) {
  for (const [phone] of phoneIndexEntries(deal)) {
    index.set(phone, deal.dealId);
  }
}

function phoneIndexEntries(deal = {}) {
  return [
    [normalizePhone(deal.buyer?.phone || deal.buyerPhone), "buyer"],
    [normalizePhone(deal.seller?.phone || deal.sellerPhone), "seller"],
    [normalizePhone(deal.owner?.phone || deal.ownerPhone), "owner"]
  ].filter(([phone]) => phone);
}

function dealHasPhone(deal = {}, phone) {
  if (!phone) return false;
  return phoneIndexEntries(deal).some(([entryPhone]) => entryPhone === phone);
}

function normalizeContact(contact = {}) {
  return pruneEmpty({
    name: clean(contact.name),
    phone: normalizePhone(contact.phone)
  });
}

export function normalizePhone(value) {
  const result = normalizePhoneNumber(value);
  return result.valid ? result.phone : clean(value);
}

export function resolveBusinessId(deal = {}) {
  return clean(
    deal.businessId ||
    deal.ownerUid ||
    deal.ownerId ||
    deal.uid ||
    deal.profileId ||
    deal.owner?.uid ||
    deal.owner?.id ||
    deal.business?.id ||
    deal.seller?.ownerUid ||
    deal.seller?.businessId ||
    deal.sellerBusinessId ||
    deal.sellerId ||
    slugify(deal.businessSlug || deal.businessName || deal.sellerName || deal.ownerName)
  );
}

function isActiveDeal(deal = {}) {
  return !["complete", "rejected", "disputed", "escalated"].includes(clean(deal.status));
}

function phoneIndexId(phone) {
  return phone.replace(/^\+/, "plus-").replace(/[^A-Za-z0-9_-]/g, "-");
}

function numberOrUndefined(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function pruneEmpty(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (item === undefined || item === null || item === "") return false;
    if (typeof item === "object" && !Array.isArray(item) && !Object.keys(item).length) return false;
    return true;
  }));
}

function ensureMemoryBusiness(businesses, businessId) {
  if (!businesses.has(businessId)) {
    businesses.set(businessId, {
      deals: new Map(),
      conversations: new Map(),
      notifications: new Map()
    });
  }
  return businesses.get(businessId);
}

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function clean(value) {
  return String(value ?? "").trim();
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function slugify(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
