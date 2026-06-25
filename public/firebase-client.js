import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  createUserWithEmailAndPassword,
  getAuth as getFirebaseAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { assertBusinessEmail } from "./js/business-email.js";

let appPromise;
let app;
let auth;
let db;

export async function getFirebaseApp() {
  if (!appPromise) {
    appPromise = fetch("/__/firebase/init.json")
      .then((response) => {
        if (!response.ok) {
          throw new Error("Firebase project config was not found. Open this page from Firebase Hosting.");
        }
        return response.json();
      })
      .then((config) => {
        app = initializeApp(config);
        auth = getFirebaseAuth(app);
        db = getFirestore(app);
        return app;
      });
  }
  return appPromise;
}

export async function getAuth() {
  await getFirebaseApp();
  return auth;
}

export async function getDb() {
  await getFirebaseApp();
  return db;
}

export async function requireUser() {
  const authInstance = await getAuth();
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(authInstance, (user) => {
      unsubscribe();
      if (!user) {
        window.location.href = `/login.html?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      resolve(user);
    });
  });
}

export async function watchUser(callback) {
  const authInstance = await getAuth();
  return onAuthStateChanged(authInstance, callback);
}

export async function signUp(email, password) {
  assertBusinessEmail(email);
  const authInstance = await getAuth();
  return createUserWithEmailAndPassword(authInstance, email, password);
}

export async function signIn(email, password) {
  const authInstance = await getAuth();
  return signInWithEmailAndPassword(authInstance, email, password);
}

export async function signInWithGoogle() {
  const authInstance = await getAuth();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return signInWithPopup(authInstance, provider);
}

export async function resetPassword(email) {
  const authInstance = await getAuth();
  return sendPasswordResetEmail(authInstance, email);
}

export async function signOutUser() {
  const authInstance = await getAuth();
  return signOut(authInstance);
}

export async function createOwnerDoc(user, businessName) {
  assertBusinessEmail(user.email);
  const dbInstance = await getDb();
  const accountRef = doc(dbInstance, "businessAccounts", user.uid);
  await setDoc(
    accountRef,
    {
      ownerUid: user.uid,
      email: user.email,
      businessName: clean(businessName) || "New Business",
      status: "pending_review",
      plan: "free",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );

  const profileRef = doc(dbInstance, "businessProfiles", user.uid);
  await setDoc(
    profileRef,
    {
      ownerUid: user.uid,
      email: user.email,
      businessName: clean(businessName) || "New Business",
      status: "draft",
      registryStatus: "not_published",
      readinessScore: 35,
      executionPreference: "manual",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

export async function getOwnerData(uid) {
  const dbInstance = await getDb();
  const [accountSnap, profileSnap] = await Promise.all([
    getDoc(doc(dbInstance, "businessAccounts", uid)),
    getDoc(doc(dbInstance, "businessProfiles", uid))
  ]);
  return {
    account: accountSnap.exists() ? { id: accountSnap.id, ...accountSnap.data() } : null,
    profile: profileSnap.exists() ? { id: profileSnap.id, ...profileSnap.data() } : null
  };
}

export async function saveOwnerProfile(uid, data) {
  const dbInstance = await getDb();
  const profileRef = doc(dbInstance, "businessProfiles", uid);
  const profileSnap = await getDoc(profileRef);
  const createDefaults = profileSnap.exists()
    ? {}
    : {
        businessName: clean(data.businessName) || "New Business",
        status: data.status || "draft",
        registryStatus: "not_published",
        readinessScore: data.readinessScore || 35,
        executionPreference: data.executionPreference || "manual",
        createdAt: serverTimestamp()
      };
  await setDoc(
    profileRef,
    {
      ...createDefaults,
      ...data,
      ownerUid: uid,
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

export async function updateOwnerAccount(uid, data) {
  const dbInstance = await getDb();
  await setDoc(
    doc(dbInstance, "businessAccounts", uid),
    {
      ...data,
      ownerUid: uid,
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

export async function createOwnerDealRequest(uid, data) {
  return createOwnerRecord(uid, "sentRequests", data);
}

export async function createOwnerRecord(uid, collectionName, data) {
  const dbInstance = await getDb();
  return addDoc(collection(dbInstance, "businessProfiles", uid, collectionName), {
    ...data,
    ownerUid: uid,
    status: data.status || "pending_human_approval",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

export async function saveApprovalDecision(uid, data) {
  const dbInstance = await getDb();
  return addDoc(collection(dbInstance, "businessProfiles", uid, "approvals"), {
    ...data,
    ownerUid: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

export async function createOrder(uid, data) {
  const dbInstance = await getDb();
  return addDoc(collection(dbInstance, "businessProfiles", uid, "orders"), {
    ...data,
    ownerUid: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

export async function createOrderMessage(uid, orderId, data) {
  const dbInstance = await getDb();
  return addDoc(collection(dbInstance, "businessProfiles", uid, "orders", orderId, "messages"), {
    ...data,
    ownerUid: uid,
    orderId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

export async function createAgentRun(uid, data) {
  const dbInstance = await getDb();
  return addDoc(collection(dbInstance, "businessProfiles", uid, "agentRuns"), {
    ...data,
    ownerUid: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

export async function createAuditEvent(uid, data) {
  const dbInstance = await getDb();
  return addDoc(collection(dbInstance, "businessProfiles", uid, "auditEvents"), {
    ...data,
    ownerUid: uid,
    createdAt: serverTimestamp()
  });
}

export async function listOwnerCollection(uid, collectionName) {
  const dbInstance = await getDb();
  const snapshot = await getDocs(query(collection(dbInstance, "businessProfiles", uid, collectionName), orderBy("createdAt", "desc")));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

export async function watchBusinessCollection(businessId, collectionName, callback, errorCallback = console.error) {
  const dbInstance = await getDb();
  const collectionRef = collection(dbInstance, "businesses", businessId, collectionName);
  const sortField = collectionName === "conversations"
    ? "latestMessageAt"
    : collectionName === "notifications"
      ? "createdAt"
      : "updatedAt";
  return onSnapshot(
    query(collectionRef, orderBy(sortField, "desc")),
    (snapshot) => callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))),
    errorCallback
  );
}

export async function listOrderMessages(uid, orderId) {
  const dbInstance = await getDb();
  const snapshot = await getDocs(query(collection(dbInstance, "businessProfiles", uid, "orders", orderId, "messages"), orderBy("createdAt", "asc")));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

export async function updateOwnerCollectionDoc(uid, collectionName, id, data) {
  const dbInstance = await getDb();
  return updateDoc(doc(dbInstance, "businessProfiles", uid, collectionName, id), {
    ...data,
    updatedAt: serverTimestamp()
  });
}

export { serverTimestamp };

function clean(value) {
  return String(value ?? "").trim();
}
