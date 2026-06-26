import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import {
  loadManifests,
  readJsonFile,
  searchManifests,
  summarizeManifest,
  validateManifest
} from "./domain/acm.js";
import { toA2aAgentCard } from "./adapters/a2a.js";
import { toArdResourceDescriptor } from "./adapters/ard.js";
import { buildDistributionPackage } from "./adapters/distribution.js";
import { toMcpServerManifest } from "./adapters/mcp.js";
import { buildOnboardingResult } from "./services/manifest-builder.js";
import { generateManifestFromWebsite } from "./services/website-generator.js";
import { buildPublicRegistryIndex, buildRobotsTxt, buildSitemap } from "./services/public-index.js";
import { createCheckout, listPlans } from "./services/payments.js";
import { executeCapability } from "./services/execution.js";
import {
  buildAgentNegotiationDraft,
  buildAgentRequestEvaluation,
  buildAgentToAgentNegotiation,
  buildOwnerAgentChat,
  validateAgentChatContext
} from "./services/agent-chat.js";
import { createBusinessEmailVerifier } from "./services/business-email.js";
import {
  processInboundSms,
  sendDealEvent,
  sendDealNotifications,
  startDealAndNotify
} from "./services/sms-notifier.js";
import { createDealStore, createResilientDealStore } from "./services/deal-store.js";
import {
  getFirebaseAdminConfig,
  getFirebaseAdminDiagnostics,
  loadFirestore,
  sanitizeFirebaseAdminError,
  describeFirebaseAdminError,
  describeFirestoreTarget,
  probeFirestoreRest
} from "./services/firebase-admin.js";
import { runDealReminders, runFounderFeeReminders, startDealReminderInterval } from "./services/deal-reminders.js";
import { DEAL_EVENT, DEAL_ROLE } from "./services/deal-flow.js";
import { createPasswordResetVerifier } from "./services/password-reset.js";

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = process.cwd();
const MANIFEST_DIR = join(ROOT, "data", "manifests");
const PUBLIC_DIR = join(ROOT, "public");
const SCHEMA_DIR = join(ROOT, "schemas");
const ALLOWED_CORS_ORIGINS = new Set([
  "https://dnols-2a394.web.app",
  "https://dnols-2a394.firebaseapp.com",
  "https://dnols-83jj.onrender.com",
  "https://dnols.com",
  "https://www.dnols.com"
]);
const LOCAL_CORS_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const businessEmailVerifier = createBusinessEmailVerifier();
const passwordResetVerifier = createPasswordResetVerifier();
const API_VERSION = "agent-groq-primary-2026-06-24";
const dealStore = createDealStore();
startDealReminderInterval({ store: dealStore });

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

createServer(async (request, response) => {
  applyCorsHeaders(request, response);
  try {
    await route(request, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : "Unexpected error"
    });
  }
}).listen(PORT, () => {
  console.log(`Agent Discovery MVP running at http://localhost:${PORT}`);
});

async function route(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const origin = getOrigin(request);

  if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
    response.writeHead(204, {
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400"
    });
    response.end();
    return;
  }

  if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
    sendJson(response, 200, {
      ok: true,
      service: "dnols-api",
      version: API_VERSION,
      environment: process.env.NODE_ENV || "development"
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/debug/firebase-admin") {
    sendJson(response, 200, {
      ok: true,
      ...getFirebaseAdminDiagnostics(getFirebaseAdminConfig(process.env))
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/debug/firestore-probe") {
    sendJson(response, 200, await runFirestoreProbe());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/manifests") {
    const records = await loadManifests(MANIFEST_DIR);
    const results = searchManifests(records, url.searchParams.get("q") ?? "", {
      protocol: url.searchParams.get("protocol") ?? undefined,
      verified: url.searchParams.get("verified") ?? undefined,
      tag: url.searchParams.get("tag") ?? undefined
    });

    sendJson(response, 200, {
      count: results.length,
      results
    });
    return;
  }

  if (
    request.method === "GET" &&
    (url.pathname === "/registry.json" || url.pathname === "/.well-known/agent-registry.json")
  ) {
    const records = await loadManifests(MANIFEST_DIR);
    sendJson(response, 200, buildPublicRegistryIndex(records, origin));
    return;
  }

  if (request.method === "GET" && url.pathname === "/sitemap.xml") {
    const records = await loadManifests(MANIFEST_DIR);
    sendRaw(response, 200, buildSitemap(records, origin), "application/xml; charset=utf-8");
    return;
  }

  if (request.method === "GET" && url.pathname === "/robots.txt") {
    sendPlain(response, 200, buildRobotsTxt(origin));
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/manifests/")) {
    const namespace = decodeURIComponent(url.pathname.replace("/api/manifests/", ""));
    const manifest = await findManifest(namespace);

    if (!manifest) {
      sendJson(response, 404, {
        error: "not_found",
        message: `No manifest found for namespace ${namespace}.`
      });
      return;
    }

    sendJson(response, 200, {
      manifest,
      summary: summarizeManifest(manifest)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/validate") {
    const body = await readRequestJson(request);
    const validation = validateManifest(body);
    sendJson(response, validation.valid ? 200 : 422, validation);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/build-manifest") {
    const body = await readRequestJson(request);
    const result = buildOnboardingResult(body);
    sendJson(response, result.accepted ? 200 : 422, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agent-chat") {
    const body = await readRequestJson(request);
    const userContext = body.userContext || body.user || {};
    const profile = body.profile || {};
    const agentConfig = body.agentConfig || profile.agentConfig || {};
    const input = body.input || {};
    const validation = validateAgentChatContext({ profile, agentConfig, userContext });
    if (!validation.valid) {
      sendJson(response, validation.statusCode, {
        ok: false,
        error: validation.error,
        message: validation.message
      });
      return;
    }

    const chat = await buildOwnerAgentChat({
      profile,
      agentConfig,
      input,
      userContext
    });
    sendJson(response, 200, {
      ok: true,
      chat,
      provider: chat.provider,
      model: chat.model,
      fallbackReason: chat.fallbackReason,
      fallbackDetail: chat.fallbackDetail
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agent-negotiation-draft") {
    const body = await readRequestJson(request);
    const userContext = body.userContext || body.user || {};
    const profile = body.profile || {};
    const agentConfig = body.agentConfig || profile.agentConfig || {};
    const input = body.input || body.task || {};
    const validation = validateAgentChatContext({ profile, agentConfig, userContext });
    if (!validation.valid) {
      sendJson(response, validation.statusCode, {
        ok: false,
        error: validation.error,
        message: validation.message
      });
      return;
    }
    const draft = await buildAgentNegotiationDraft({ profile, agentConfig, input, userContext });
    sendJson(response, 200, {
      ok: true,
      draft,
      provider: draft.provider,
      model: draft.model,
      fallbackReason: draft.fallbackReason,
      fallbackDetail: draft.fallbackDetail
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agent-request-evaluation") {
    const body = await readRequestJson(request);
    const userContext = body.userContext || body.user || {};
    const profile = body.profile || {};
    const agentConfig = body.agentConfig || profile.agentConfig || {};
    const requestPayload = body.request || body.input || {};
    const validation = validateAgentChatContext({ profile, agentConfig, userContext });
    if (!validation.valid) {
      sendJson(response, validation.statusCode, {
        ok: false,
        error: validation.error,
        message: validation.message
      });
      return;
    }
    const evaluation = await buildAgentRequestEvaluation({ profile, agentConfig, request: requestPayload, userContext });
    sendJson(response, 200, {
      ok: true,
      evaluation,
      provider: evaluation.provider,
      model: evaluation.model,
      fallbackReason: evaluation.fallbackReason,
      fallbackDetail: evaluation.fallbackDetail
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/agent-to-agent/negotiate") {
    const body = await readRequestJson(request);
    const userContext = body.userContext || body.user || {};
    const profile = body.profile || {};
    const agentConfig = body.agentConfig || profile.agentConfig || {};
    const requestPayload = body.request || body.input || {};
    const validation = validateAgentChatContext({ profile, agentConfig, userContext });
    if (!validation.valid) {
      sendJson(response, validation.statusCode, {
        ok: false,
        error: validation.error,
        message: validation.message
      });
      return;
    }
    const negotiation = await buildAgentToAgentNegotiation({ profile, agentConfig, request: requestPayload, userContext });
    sendJson(response, 200, {
      ok: true,
      negotiation,
      provider: negotiation.provider,
      model: negotiation.model,
      fallbackReason: negotiation.fallbackReason,
      fallbackDetail: negotiation.fallbackDetail
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sms/notify") {
    const body = await readRequestJson(request);
    const deal = body.deal || {};
    // Best-effort persistence: Firestore mirrors the dashboard but must not block SMS.
    const store = createResilientDealStore();
    try {
      if (body.event) {
        const result = body.event === DEAL_EVENT.NEW_DEAL
          ? await startDealAndNotify({ deal, store })
          : await sendDealEvent({ deal, event: body.event, store });
        sendJson(response, 200, { ok: true, ...result, persistence: store.getPersistenceStatus() });
        return;
      }
      const notifications = Array.isArray(body.notifications)
        ? body.notifications
        : body.type
          ? [{ type: body.type, role: body.role || DEAL_ROLE.SELLER }]
          : [];
      if (!notifications.length) {
        sendJson(response, 400, { ok: false, error: "no_notifications", message: "Provide event, type, or notifications." });
        return;
      }
      const persistedDeal = await persistSmsNotifyDeal(store, deal, notifications);
      const results = await sendDealNotifications({ deal: persistedDeal, notifications });
      sendJson(response, 200, { ok: true, deal: persistedDeal, notifications, results, persistence: store.getPersistenceStatus() });
    } catch (error) {
      const knownCode = safeErrorCode(error);
      sendJson(response, Number(error?.statusCode) || 422, {
        ok: false,
        error: knownCode || "sms_notify_failed",
        message: safeErrorMessage(error, "Could not send SMS notification.")
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sms/webhook") {
    const payload = await readRequestBody(request);
    // Best-effort persistence: a Firestore failure must not stop inbound classification
    // or the outbound confirmation SMS from running.
    const store = createResilientDealStore();
    try {
      const result = await processInboundSms({ payload, store });
      sendJson(response, 200, { ...result, persistence: store.getPersistenceStatus() });
    } catch (error) {
      sendJson(response, 200, {
        ok: false,
        error: "sms_webhook_failed",
        message: error instanceof Error ? error.message : "Could not process inbound SMS."
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sms/run-reminders") {
    const body = await readRequestBody(request);
    const windowMs = Number(body.windowMs || 0) || undefined;
    try {
      const result = await runDealReminders({ store: dealStore, windowMs });
      sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(response, 422, {
        ok: false,
        error: "sms_reminders_failed",
        message: error instanceof Error ? error.message : "Could not run SMS reminders."
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sms/run-fee-reminders") {
    const body = await readRequestBody(request);
    const windowMs = Number(body.windowMs || 0) || undefined;
    try {
      const result = await runFounderFeeReminders({ store: dealStore, windowMs });
      sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(response, 422, {
        ok: false,
        error: "sms_fee_reminders_failed",
        message: error instanceof Error ? error.message : "Could not run fee reminder SMS notifications."
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/business-email/start") {
    const body = await readRequestJson(request);
    const result = await businessEmailVerifier.startVerification(body);
    sendJson(response, result.ok ? 200 : result.statusCode ?? 400, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/business-email/verify") {
    const body = await readRequestJson(request);
    const result = businessEmailVerifier.verifyCode(body);
    sendJson(response, result.ok ? 200 : result.statusCode ?? 400, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/email-verification/request") {
    const body = await readRequestJson(request);
    const result = await businessEmailVerifier.startVerification({
      ownerUid: body.ownerUid,
      email: body.email,
      expectedDomain: body.expectedDomain
    });
    sendJson(response, result.ok ? 200 : result.statusCode ?? 400, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/email-verification/confirm") {
    const body = await readRequestJson(request);
    const result = businessEmailVerifier.verifyCode({
      challengeId: body.challengeId || body.token,
      email: body.email,
      code: body.code
    });
    sendJson(response, result.ok ? 200 : result.statusCode ?? 400, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/password-reset/start") {
    const body = await readRequestJson(request);
    const result = await passwordResetVerifier.startReset({
      email: body.email,
      ip: clientIp(request)
    });
    sendJson(response, result.ok ? 200 : result.statusCode ?? 400, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/password-reset/verify") {
    const body = await readRequestJson(request);
    const result = passwordResetVerifier.verifyCode({
      challengeId: body.challengeId,
      email: body.email,
      code: body.code
    });
    sendJson(response, result.ok ? 200 : result.statusCode ?? 400, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/password-reset/complete") {
    const body = await readRequestJson(request);
    const result = await passwordResetVerifier.completeReset({
      challengeId: body.challengeId,
      email: body.email,
      resetToken: body.resetToken,
      newPassword: body.newPassword ?? body.password
    });
    sendJson(response, result.ok ? 200 : result.statusCode ?? 400, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/generate-from-website") {
    const body = await readRequestJson(request);
    try {
      const result = await generateManifestFromWebsite(body);
      sendJson(response, result.accepted ? 200 : 422, result);
    } catch (error) {
      sendJson(response, 422, {
        accepted: false,
        error: "website_generation_failed",
        message: error instanceof Error ? error.message : "Could not generate from website."
      });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/plans") {
    sendJson(response, 200, {
      plans: listPlans()
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/checkout") {
    const body = await readRequestJson(request);
    const checkout = createCheckout(body.planId, origin);
    sendJson(response, checkout.ok ? 200 : checkout.statusCode, checkout);
    return;
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/execute/")) {
    const [, namespace, capabilityId] = decodeURIComponent(
      url.pathname.replace("/api/execute/", "")
    ).match(/^(.+)\/([^/]+)$/) ?? [];

    if (!namespace || !capabilityId) {
      sendJson(response, 400, {
        ok: false,
        error: "bad_execute_path",
        message: "Use /api/execute/:namespace/:capabilityId."
      });
      return;
    }

    const manifest = await findManifest(namespace);
    if (!manifest) {
      sendJson(response, 404, {
        ok: false,
        error: "not_found",
        message: `No manifest found for namespace ${namespace}.`
      });
      return;
    }

    const body = await readRequestJson(request);
    const result = await executeCapability(manifest, capabilityId, body.input ?? {}, {
      allowLiveExecution: body.allowLiveExecution,
      apiKey: body.apiKey,
      authToken: body.authToken,
      did: body.did,
      didSignature: body.didSignature,
      idempotencyKey: body.idempotencyKey
    });

    sendJson(response, result.ok ? 200 : result.statusCode ?? 422, result);
    return;
  }

  if (request.method === "GET" && url.pathname === "/checkout") {
    const checkout = createCheckout(url.searchParams.get("plan") ?? "professional", origin);
    if (!checkout.ok) {
      sendJson(response, checkout.statusCode, checkout);
      return;
    }

    response.writeHead(302, {
      Location: checkout.checkoutUrl
    });
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/adapters/mcp/")) {
    const namespace = decodeURIComponent(url.pathname.replace("/api/adapters/mcp/", ""));
    const manifest = await findManifest(namespace);
    if (!manifest) {
      sendJson(response, 404, {
        error: "not_found"
      });
      return;
    }
    sendJson(response, 200, toMcpServerManifest(manifest));
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/adapters/a2a/")) {
    const namespace = decodeURIComponent(url.pathname.replace("/api/adapters/a2a/", ""));
    const manifest = await findManifest(namespace);
    if (!manifest) {
      sendJson(response, 404, {
        error: "not_found"
      });
      return;
    }
    sendJson(response, 200, toA2aAgentCard(manifest));
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/adapters/ard/")) {
    const namespace = decodeURIComponent(url.pathname.replace("/api/adapters/ard/", ""));
    const manifest = await findManifest(namespace);
    if (!manifest) {
      sendJson(response, 404, {
        error: "not_found"
      });
      return;
    }
    sendJson(response, 200, toArdResourceDescriptor(manifest));
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/distribution/")) {
    const namespace = decodeURIComponent(url.pathname.replace("/api/distribution/", ""));
    const manifest = await findManifest(namespace);
    if (!manifest) {
      sendJson(response, 404, {
        error: "not_found"
      });
      return;
    }
    sendJson(response, 200, buildDistributionPackage(manifest, origin));
    return;
  }

  if (request.method === "GET" && url.pathname === "/.well-known/agent-capabilities.json") {
    const namespace = url.searchParams.get("namespace") ?? "com.najd.procurement";
    const manifest = await findManifest(namespace);
    if (!manifest) {
      sendJson(response, 404, {
        error: "not_found"
      });
      return;
    }
    sendJson(response, 200, manifest);
    return;
  }

  if (request.method === "GET" && url.pathname === "/dns/_agent") {
    const domain = url.searchParams.get("domain") ?? "najd-procurement.example";
    const records = await loadManifests(MANIFEST_DIR);
    const match = records.find((record) => record.manifest.publisher?.domain === domain);

    if (!match) {
      sendPlain(response, 404, `No _agent TXT record known for ${domain}`);
      return;
    }

    const manifestUrl =
      match.manifest.endpoints?.manifestUrl ??
      `https://${domain}/.well-known/agent-capabilities.json`;
    sendPlain(response, 200, `_agent.${domain}. 300 IN TXT "acm=${manifestUrl}"\n`);
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/schemas/")) {
    await serveStaticFromDirectory(url.pathname.replace("/schemas/", "/"), SCHEMA_DIR, response);
    return;
  }

  if (request.method === "GET") {
    await serveStaticFromDirectory(url.pathname, PUBLIC_DIR, response);
    return;
  }

  sendJson(response, 405, {
    error: "method_not_allowed"
  });
}

async function findManifest(namespace) {
  const path = join(MANIFEST_DIR, `${namespace}.json`);
  try {
    return await readJsonFile(path);
  } catch {
    return null;
  }
}

async function persistSmsNotifyDeal(store, deal, notifications = []) {
  const dealId = deal.dealId || deal.id || deal.ref;
  if (!dealId) return deal;
  // Best-effort: never let a persistence failure block the SMS send. The resilient
  // store already falls back to memory on Firestore errors; this guard covers any
  // other unexpected persistence error so the SMS still goes out.
  try {
    const existing = await store.getDeal(dealId);
    const saved = existing ? await store.updateDeal(dealId, deal) : await store.saveDeal(deal);
    if (!notifications.length) return saved || deal;
    const updated = await store.updateDeal(dealId, {
      lastNotifiedAt: new Date().toISOString(),
      remindedAt: ""
    });
    return updated || saved || deal;
  } catch (error) {
    console.warn("SMS notify persistence failed; sending SMS without a persisted deal record", {
      dealId,
      code: error?.code || "",
      message: error instanceof Error ? error.message : String(error)
    });
    return deal;
  }
}

async function runFirestoreProbe() {
  const config = getFirebaseAdminConfig(process.env);
  const diagnostics = getFirebaseAdminDiagnostics(config);
  const checkedAt = new Date().toISOString();
  let writeOk = false;
  let readOk = false;
  let database;

  // Debug path only: capture Google's raw REST error body to explain the opaque
  // gRPC "403 PERMISSION_DENIED". Never throws; secrets are never returned.
  const restProbe = await safeProbeFirestoreRest(config);

  try {
    const firestore = await loadFirestore(config);
    database = describeFirestoreTarget(firestore);
    const probeRef = firestore.collection("_debug").doc("firestoreProbe");
    await probeRef.set({ checkedAt, source: "firestore-probe" }, { merge: true });
    writeOk = true;

    const snapshot = await probeRef.get();
    readOk = snapshot.exists && snapshot.get("source") === "firestore-probe";

    return {
      ok: writeOk && readOk,
      ...diagnostics,
      database,
      writeOk,
      readOk,
      restProbe
    };
  } catch (error) {
    return {
      ok: false,
      ...diagnostics,
      database,
      writeOk,
      readOk,
      ...sanitizeFirebaseAdminError(error),
      error: describeFirebaseAdminError(error),
      restProbe
    };
  }
}

async function safeProbeFirestoreRest(config) {
  try {
    return await probeFirestoreRest(config);
  } catch (error) {
    return { tokenObtained: false, requestError: sanitizeFirebaseAdminError(error) };
  }
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  const contentType = String(request.headers["content-type"] || "");
  if (contentType.includes("application/json") || raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  return Object.fromEntries(new URLSearchParams(raw));
}

async function serveStaticFromDirectory(pathname, rootDirectory, response) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(rootDirectory, safePath);

  if (!filePath.startsWith(rootDirectory)) {
    sendPlain(response, 403, "Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream"
    });
    response.end(content);
  } catch {
    sendPlain(response, 404, "Not found");
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendPlain(response, statusCode, body) {
  sendRaw(response, statusCode, body, "text/plain; charset=utf-8");
}

function sendRaw(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    "Content-Type": contentType
  });
  response.end(body);
}

function safeErrorCode(error) {
  const code = String(error?.code || "");
  return /^firebase_[a-z0-9_]+$/.test(code) ? code : "";
}

function safeErrorMessage(error, fallback) {
  if (error?.publicMessage) return String(error.publicMessage);
  return error instanceof Error ? error.message : fallback;
}

function getOrigin(request) {
  const host = request.headers["x-forwarded-host"] ?? request.headers.host;
  const protocol = request.headers["x-forwarded-proto"] ?? "http";
  return `${protocol}://${host}`;
}

function clientIp(request) {
  return request.headers["x-forwarded-for"] ?? request.socket?.remoteAddress ?? "";
}

function applyCorsHeaders(request, response) {
  const requestOrigin = request.headers.origin;
  if (!isAllowedCorsOrigin(requestOrigin)) return;

  response.setHeader("Access-Control-Allow-Origin", requestOrigin);
  response.setHeader("Vary", "Origin");
}

function isAllowedCorsOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_CORS_ORIGINS.has(origin) || LOCAL_CORS_ORIGIN_PATTERN.test(origin);
}
