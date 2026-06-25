export function getFirebaseAdminConfig(env = {}) {
  const serviceAccountJson = clean(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const projectId = clean(env.FIREBASE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT);
  const serviceAccount = inspectServiceAccountJson(serviceAccountJson);
  return {
    enabled: Boolean(
      projectId ||
      clean(env.GOOGLE_APPLICATION_CREDENTIALS) ||
      serviceAccountJson
    ),
    projectId,
    databaseURL: clean(env.FIREBASE_DATABASE_URL),
    serviceAccountJson,
    serviceAccountProjectId: serviceAccount.projectId,
    serviceAccountEmail: serviceAccount.email,
    serviceAccountJsonValid: serviceAccount.valid,
    credentialSource: resolveCredentialSource(env, serviceAccountJson, serviceAccount),
    hasFirebaseProjectId: Boolean(clean(env.FIREBASE_PROJECT_ID)),
    hasGoogleCloudProject: Boolean(clean(env.GOOGLE_CLOUD_PROJECT)),
    hasServiceAccountJson: Boolean(serviceAccountJson),
    hasGoogleApplicationCredentials: Boolean(clean(env.GOOGLE_APPLICATION_CREDENTIALS))
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

export function getFirebaseAdminDiagnostics(config = {}) {
  const projectId = clean(config.projectId);
  const serviceAccountProjectId = clean(config.serviceAccountProjectId);
  const serviceAccountEmail = clean(config.serviceAccountEmail);
  return {
    enabled: Boolean(config.enabled),
    projectId: projectId || serviceAccountProjectId || "unspecified",
    explicitProjectId: Boolean(projectId),
    serviceAccountProjectId: serviceAccountProjectId || "unspecified",
    serviceAccountEmail: serviceAccountEmail || "unspecified",
    projectIdMismatch: Boolean(projectId && serviceAccountProjectId && projectId !== serviceAccountProjectId),
    credentialSource: clean(config.credentialSource) || "application_default_credentials",
    serviceAccountJsonValid: config.serviceAccountJson ? Boolean(config.serviceAccountJsonValid) : undefined,
    hasDatabaseURL: Boolean(clean(config.databaseURL)),
    hasFirebaseProjectId: Boolean(config.hasFirebaseProjectId),
    hasGoogleCloudProject: Boolean(config.hasGoogleCloudProject),
    hasServiceAccountJson: Boolean(config.hasServiceAccountJson),
    hasGoogleApplicationCredentials: Boolean(config.hasGoogleApplicationCredentials)
  };
}

function parseServiceAccountJson(value) {
  const json = clean(value);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch (error) {
    const wrapped = new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.");
    wrapped.code = "firebase_admin_service_account_invalid";
    wrapped.cause = error;
    throw wrapped;
  }
}

function inspectServiceAccountJson(value) {
  const json = clean(value);
  if (!json) return { valid: undefined, projectId: "", email: "" };
  try {
    const parsed = JSON.parse(json);
    return {
      valid: true,
      projectId: clean(parsed?.project_id),
      email: clean(parsed?.client_email)
    };
  } catch {
    return { valid: false, projectId: "", email: "" };
  }
}

function resolveCredentialSource(env = {}, serviceAccountJson, serviceAccount = {}) {
  if (serviceAccountJson) {
    return serviceAccount.valid ? "FIREBASE_SERVICE_ACCOUNT_JSON" : "FIREBASE_SERVICE_ACCOUNT_JSON_INVALID";
  }
  if (clean(env.GOOGLE_APPLICATION_CREDENTIALS)) return "GOOGLE_APPLICATION_CREDENTIALS";
  if (clean(env.FIREBASE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT)) return "APPLICATION_DEFAULT_CREDENTIALS";
  return "none";
}

function clean(value) {
  return String(value ?? "").trim();
}
