import { normalizePhoneNumber } from "./sms.js";

const DEFAULT_COLLECTION = "deals";
const DEFAULT_PHONE_INDEX_COLLECTION = "dealPhoneIndex";

const memoryState = {
  deals: new Map(),
  phoneIndex: new Map()
};

export function createDealStore({ env = process.env, now = () => new Date() } = {}) {
  const memory = createMemoryDealStore({ state: memoryState, now });
  const firestoreConfig = getFirestoreConfig(env);
  if (!firestoreConfig.enabled) return memory;

  let firestoreStore;
  return {
    async saveDeal(deal = {}) {
      firestoreStore ||= await createFirestoreDealStore(firestoreConfig, memory, now);
      return firestoreStore.saveDeal(deal);
    },
    async getDeal(dealId) {
      firestoreStore ||= await createFirestoreDealStore(firestoreConfig, memory, now);
      return firestoreStore.getDeal(dealId);
    },
    async findDealByPhone(phone) {
      firestoreStore ||= await createFirestoreDealStore(firestoreConfig, memory, now);
      return firestoreStore.findDealByPhone(phone);
    },
    async listActiveDeals() {
      firestoreStore ||= await createFirestoreDealStore(firestoreConfig, memory, now);
      return firestoreStore.listActiveDeals();
    },
    async updateDeal(dealId, patch = {}) {
      firestoreStore ||= await createFirestoreDealStore(firestoreConfig, memory, now);
      return firestoreStore.updateDeal(dealId, patch);
    }
  };
}

export function createMemoryDealStore({ state = { deals: new Map(), phoneIndex: new Map() }, now = () => new Date() } = {}) {
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
    async updateDeal(dealId, patch = {}) {
      const id = clean(dealId);
      const existing = state.deals.get(id);
      if (!existing) return null;
      const updated = normalizeDeal({ ...existing, ...patch, dealId: id }, { now, existing });
      state.deals.set(id, updated);
      indexDealPhones(state.phoneIndex, updated);
      return clone(updated);
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
  const hasProjectConfig = Boolean(clean(env.FIREBASE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT));
  return {
    enabled: explicitlyEnabled || hasProjectConfig || Boolean(clean(env.GOOGLE_APPLICATION_CREDENTIALS)),
    projectId: clean(env.FIREBASE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT),
    databaseURL: clean(env.FIREBASE_DATABASE_URL),
    collectionName: clean(env.DEAL_STORE_COLLECTION) || DEFAULT_COLLECTION,
    phoneIndexCollectionName: clean(env.DEAL_PHONE_INDEX_COLLECTION) || DEFAULT_PHONE_INDEX_COLLECTION
  };
}

async function createFirestoreDealStore(config, fallback, now) {
  let admin;
  try {
    admin = await import("firebase-admin");
  } catch {
    return fallback;
  }

  const app = admin.getApps?.().length
    ? admin.getApp()
    : admin.initializeApp({
        projectId: config.projectId || undefined,
        databaseURL: config.databaseURL || undefined
      });
  const db = admin.getFirestore ? admin.getFirestore(app) : app.firestore();
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
    async updateDeal(dealId, patch = {}) {
      const existing = (await this.getDeal(dealId)) || {};
      if (!existing.dealId && !existing.id) return null;
      const updated = normalizeDeal({ ...existing, ...patch, dealId }, { now, existing });
      await deals.doc(updated.dealId).set(updated, { merge: true });
      await writePhoneIndex(phoneIndex, updated);
      return updated;
    }
  };
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

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function clean(value) {
  return String(value ?? "").trim();
}
