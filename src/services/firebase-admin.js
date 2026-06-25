export function getFirebaseAdminConfig(env = {}) {
  const serviceAccountJson = clean(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const projectId = clean(env.FIREBASE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT);
  return {
    enabled: Boolean(
      projectId ||
      clean(env.GOOGLE_APPLICATION_CREDENTIALS) ||
      serviceAccountJson
    ),
    projectId,
    databaseURL: clean(env.FIREBASE_DATABASE_URL),
    serviceAccountJson
  };
}

export async function loadFirebaseAuth(config) {
  const [appModule, authModule] = await Promise.all([
    import("firebase-admin/app"),
    import("firebase-admin/auth")
  ]);
  return authModule.getAuth(initializeFirebaseAdminApp(appModule, config));
}

export async function loadFirestore(config) {
  const [appModule, firestoreModule] = await Promise.all([
    import("firebase-admin/app"),
    import("firebase-admin/firestore")
  ]);
  return firestoreModule.getFirestore(initializeFirebaseAdminApp(appModule, config));
}

export function initializeFirebaseAdminApp(appModule, config = {}) {
  const apps = appModule.getApps();
  return apps.length
    ? appModule.getApp()
    : appModule.initializeApp(firebaseAdminOptions(appModule, config));
}

export function firebaseAdminOptions(appModule, config = {}) {
  const serviceAccount = parseServiceAccountJson(config.serviceAccountJson);
  const options = {
    projectId: config.projectId || serviceAccount?.project_id || undefined,
    databaseURL: config.databaseURL || undefined
  };
  if (serviceAccount && typeof appModule.cert === "function") {
    options.credential = appModule.cert(serviceAccount);
  }
  return options;
}

export function isFirebaseAdminModuleMissing(error) {
  const code = String(error?.code || "");
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

function parseServiceAccountJson(value) {
  const json = clean(value);
  return json ? JSON.parse(json) : null;
}

function clean(value) {
  return String(value ?? "").trim();
}
