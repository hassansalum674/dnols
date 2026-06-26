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

// Debug-only: bypass the opaque gRPC client and talk to Firestore over plain REST
// so Google's full JSON error body (error.status / message / details[].reason /
// metadata) is captured. That body is non-secret; the OAuth access token, private
// key and env values are never returned. Intended ONLY for the debug probe path.
export async function probeFirestoreRest(config = {}, { fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const projectId = clean(config.projectId) || clean(config.serviceAccountProjectId);
  const result = { tokenObtained: false };

  let accessToken;
  try {
    accessToken = await obtainFirestoreAccessToken(config);
    result.tokenObtained = Boolean(accessToken);
  } catch (error) {
    // A token-fetch failure usually means a mangled/corrupt private key in env.
    result.tokenObtained = false;
    result.tokenError = sanitizeProbeError(error);
    return result;
  }

  if (!accessToken) {
    result.tokenError = { message: "No access token returned by credential." };
    return result;
  }

  if (!projectId) {
    result.requestError = { message: "No projectId resolved for REST probe." };
    return result;
  }

  if (typeof doFetch !== "function") {
    result.requestError = { message: "global fetch is unavailable in this runtime." };
    return result;
  }

  try {
    const url =
      `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}` +
      `/databases/%28default%29/documents?pageSize=1`;
    const restResponse = await doFetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }
    });
    result.httpStatus = restResponse.status;
    const text = await restResponse.text();
    result.body = parseRestProbeBody(text);
  } catch (error) {
    result.requestError = sanitizeProbeError(error);
  }
  return result;
}

async function obtainFirestoreAccessToken(config) {
  const appModule = await import("firebase-admin/app");
  const app = initializeFirebaseAdminApp(appModule, config);
  const credential = app?.options?.credential;
  if (!credential || typeof credential.getAccessToken !== "function") {
    throw new Error("Firebase app credential cannot mint an access token.");
  }
  const tokenResponse = await credential.getAccessToken();
  return clean(tokenResponse?.access_token);
}

function parseRestProbeBody(text) {
  const raw = clean(text);
  if (!raw) return undefined;
  try {
    // Google's error body has no secrets; return it parsed and intact.
    return JSON.parse(raw);
  } catch {
    return redactSensitiveText(raw).slice(0, 4096);
  }
}

function sanitizeProbeError(error) {
  return pruneUndefined({
    name: clean(error?.constructor?.name || error?.name) || undefined,
    message: redactFull(error?.message),
    code: redactFull(error?.code ?? error?.errorInfo?.code)
  });
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

export function sanitizeFirebaseAdminError(error) {
  return {
    code: sanitizeErrorValue(error?.code || error?.errorInfo?.code),
    message: sanitizeErrorValue(error?.message),
    details: sanitizeErrorValue(error?.details),
    status: sanitizeErrorValue(error?.status || error?.statusCode || error?.httpStatus)
  };
}

// Returns the FULL, untruncated (but secret-redacted) error information. This is
// intended ONLY for the debug probe path so that Google's complete explanation of
// a Firestore failure (which is non-secret) is visible. Never include private keys,
// service account JSON, env values, or tokens; redactSensitiveText strips those.
export function describeFirebaseAdminError(error) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return pruneUndefined({ fullMessage: redactFull(String(error)) });
  }
  return pruneUndefined({
    name: clean(error.constructor?.name || error.name) || undefined,
    fullMessage: redactFull(error.message),
    code: redactFull(error.code ?? error.errorInfo?.code),
    grpcCode: typeof error.code === "number" ? error.code : undefined,
    details: redactFull(error.details),
    reason: redactFull(error.reason ?? error.errorInfo?.reason),
    status: redactFull(error.status),
    statusCode: redactFull(error.statusCode ?? error.httpStatus),
    metadata: stringifyErrorMetadata(error.metadata),
    statusDetails: stringifyErrorMetadata(error.statusDetails),
    stack: extractStackHead(error.stack)
  });
}

// Best-effort, crash-safe description of which Firestore database the client targets.
export function describeFirestoreTarget(firestore) {
  try {
    const settings = firestore?._settings || {};
    const databaseId = firestore?._databaseId || firestore?.databaseId || {};
    const targetId = clean(
      settings.databaseId ||
      (typeof databaseId === "string" ? databaseId : databaseId?.database || databaseId?.databaseId)
    );
    return pruneUndefined({
      databaseId: targetId || "(default)",
      isDefaultDatabase: !targetId || targetId === "(default)",
      projectId: clean(settings.projectId || databaseId?.projectId) || undefined
    });
  } catch {
    return undefined;
  }
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

function sanitizeErrorValue(value) {
  const text = clean(value);
  if (!text) return undefined;
  return redactSensitiveText(text).slice(0, 500);
}

// Like sanitizeErrorValue but without the 500-char truncation, for the debug probe.
function redactFull(value) {
  const text = clean(value);
  if (!text) return undefined;
  return redactSensitiveText(text);
}

function extractStackHead(stack, lines = 5) {
  const text = clean(stack);
  if (!text) return undefined;
  return redactSensitiveText(text.split("\n").slice(0, lines).join("\n"));
}

function stringifyErrorMetadata(metadata) {
  if (metadata === undefined || metadata === null) return undefined;
  try {
    let value = metadata;
    if (typeof metadata.toJSON === "function") value = metadata.toJSON();
    else if (typeof metadata.getMap === "function") value = metadata.getMap();
    const text = clean(typeof value === "string" ? value : JSON.stringify(value));
    if (!text || text === "{}" || text === "[]") return undefined;
    return redactSensitiveText(text);
  } catch {
    return undefined;
  }
}

function pruneUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function redactSensitiveText(value) {
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted]")
    .replace(/("?(?:private_key|private_key_id|client_secret|access_token|refresh_token|id_token|authorization)"?\s*[:=]\s*)("[^"]*"|[^\s,}]+)/gi, "$1[redacted]")
    .replace(/ya29\.[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
}
