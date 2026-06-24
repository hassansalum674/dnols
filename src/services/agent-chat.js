import {
  buildAgentIdentity,
  buildNegotiationDraft,
  buildOwnerAgentChatResponse,
  evaluateDealRequest,
  exceedsAutoApprovalLimit
} from "../../public/system-logic.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "claude-3-5-haiku-20241022";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const FALLBACK_MODEL_CHAIN = ["claude-3-5-haiku-20241022", "claude-3-haiku-20240307"];
const DEFAULT_MAX_TOKENS = 350;
const DEFAULT_TIMEOUT_MS = 8000;
const ALLOWED_TOPICS = new Set(["general", "approval", "deal", "order", "publishing", "setup"]);
const ALLOWED_DECISIONS = new Set(["approved", "rejected", "pending_human_approval", "agent_reviewed"]);

export function validateAgentChatContext({ profile = {}, agentConfig = {}, userContext = {} } = {}) {
  const userUid = clean(userContext.uid);
  if (!userUid) {
    return {
      valid: false,
      statusCode: 400,
      error: "missing_user_context",
      message: "A signed-in user context is required."
    };
  }

  if (!profile || typeof profile !== "object") {
    return {
      valid: false,
      statusCode: 400,
      error: "missing_business_context",
      message: "A business context is required."
    };
  }

  const ownerUid = clean(profile.ownerUid || profile.userUid || profile.uid);
  if (ownerUid && ownerUid !== userUid) {
    return {
      valid: false,
      statusCode: 403,
      error: "profile_user_mismatch",
      message: "The supplied business context does not match the signed-in user context."
    };
  }

  const capabilityName = clean(agentConfig.capability?.name || profile.capabilityName);
  if (!clean(profile.businessName) && !capabilityName) {
    return {
      valid: false,
      statusCode: 400,
      error: "missing_business_context",
      message: "A business name or configured capability is required."
    };
  }

  return { valid: true };
}

export async function buildOwnerAgentChat({
  profile = {},
  agentConfig = {},
  input = {},
  userContext = {},
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const fallback = withProvider(
    buildOwnerAgentChatResponse(profile, agentConfig, input),
    "deterministic",
    null,
    null
  );
  const validation = validateAgentChatContext({ profile, agentConfig, userContext });
  if (!validation.valid) {
    return withProvider(fallback, "deterministic", null, validation.error);
  }

  const ai = await requestAgentJson({
    env,
    fetchImpl,
    timeoutMs,
    temperature: 0.2,
    system: [
      "You are this specific business's own agent, rebuilt fresh from the provided businessContext.",
      "Adopt the identity in businessContext.agent: speak as businessContext.agent.name with the businessContext.agent.personality tone, and honor that business's specialties, rules, currency, and payment terms.",
      "Use only the provided compact business context.",
      "Never request or reveal secrets, API keys, private minimum prices, or hidden internal rules.",
      "Final execution always requires human owner approval, and any deal above businessContext.agent.autoApprovalLimit must be flagged for human approval.",
      "Return only JSON with: topic, agentResponse, nextActions."
    ].join(" "),
    payload: buildPromptPayload(profile, agentConfig, input, fallback)
  });

  if (!ai.ok) {
    return withProvider(fallback, "deterministic", ai.model, ai.fallbackReason, ai.fallbackDetail);
  }

  const parsed = ai.parsed || {};
  return withProvider(
    {
      ...fallback,
      topic: ALLOWED_TOPICS.has(parsed.topic) ? parsed.topic : fallback.topic,
      agentResponse: clip(parsed.agentResponse, 700) || fallback.agentResponse,
      draftResponse: clip(parsed.agentResponse, 700) || fallback.draftResponse,
      nextActions: normalizeNextActions(parsed.nextActions, fallback.nextActions),
      messages: [
        fallback.messages[0],
        {
          role: "agent",
          body: clip(parsed.agentResponse, 700) || fallback.agentResponse,
          nextActions: normalizeNextActions(parsed.nextActions, fallback.nextActions)
        }
      ]
    },
    ai.provider,
    ai.model,
    null
  );
}

export async function buildAgentNegotiationDraft({
  profile = {},
  agentConfig = {},
  input = {},
  userContext = {},
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const fallback = withProvider(buildNegotiationDraft(profile, agentConfig, input), "deterministic", null, null);
  const validation = validateAgentChatContext({ profile, agentConfig, userContext });
  if (!validation.valid) return withProvider(fallback, "deterministic", null, validation.error);
  const ai = await requestAgentJson({
    env,
    fetchImpl,
    timeoutMs,
    purpose: "negotiation_draft",
    system: featureSystemPrompt("negotiation_draft"),
    payload: {
      task: "Improve this negotiation draft for the business owner. Keep it approval-safe.",
      output: {
        agentResponse: "string<=500",
        reason: "string<=220",
        decisionRecommendation: "approved|rejected|pending_human_approval",
        riskFlags: ["string<=120"],
        processSteps: [{ label: "string<=40", detail: "string<=160" }]
      },
      draft: compactDraft(fallback),
      businessContext: compactBusinessContext(profile, agentConfig)
    }
  });
  if (!ai.ok) return withProvider(fallback, "deterministic", ai.model, ai.fallbackReason, ai.fallbackDetail);
  const parsed = ai.parsed || {};
  const identity = buildAgentIdentity(profile, agentConfig);
  const amount = Number(input.budgetAmount || input.budget) || 0;
  const decisionRecommendation = enforceApprovalDecision(
    ALLOWED_DECISIONS.has(parsed.decisionRecommendation) ? parsed.decisionRecommendation : fallback.decisionRecommendation,
    amount,
    identity
  );
  return withProvider({
    ...fallback,
    agentResponse: clip(parsed.agentResponse, 700) || fallback.agentResponse,
    reason: clip(parsed.reason, 260) || fallback.reason,
    decisionRecommendation,
    riskFlags: normalizeStringArray(parsed.riskFlags, fallback.riskFlags, 6, 140),
    processSteps: normalizeProcessSteps(parsed.processSteps, fallback.processSteps)
  }, ai.provider, ai.model, null);
}

export async function buildAgentRequestEvaluation({
  profile = {},
  agentConfig = {},
  request = {},
  userContext = {},
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const fallback = withProvider(evaluateDealRequest(profile, agentConfig, request), "deterministic", null, null);
  const validation = validateAgentChatContext({ profile, agentConfig, userContext });
  if (!validation.valid) return withProvider(fallback, "deterministic", null, validation.error);
  const ai = await requestAgentJson({
    env,
    fetchImpl,
    timeoutMs,
    purpose: "request_evaluation",
    system: featureSystemPrompt("request_evaluation"),
    payload: {
      task: "Evaluate this incoming business request for owner approval. Return compact safe JSON.",
      output: {
        summary: "string<=220",
        status: "approved|rejected|pending_human_approval|agent_reviewed",
        triggers: ["string<=120"]
      },
      request: compactRequest(request),
      businessContext: compactBusinessContext(profile, agentConfig)
    }
  });
  if (!ai.ok) return withProvider(fallback, "deterministic", ai.model, ai.fallbackReason, ai.fallbackDetail);
  const parsed = ai.parsed || {};
  const identity = buildAgentIdentity(profile, agentConfig);
  const amount = Number(request.budgetAmount || request.budget || request.amount) || 0;
  const status = enforceApprovalDecision(
    ALLOWED_DECISIONS.has(parsed.status) ? parsed.status : fallback.status,
    amount,
    identity
  );
  return withProvider({
    ...fallback,
    summary: clip(parsed.summary, 300) || fallback.summary,
    status,
    triggers: normalizeStringArray(parsed.triggers, fallback.triggers, 6, 140)
  }, ai.provider, ai.model, null);
}

export async function buildAgentToAgentNegotiation({
  profile = {},
  agentConfig = {},
  request = {},
  userContext = {},
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const deterministic = buildNegotiationDraft(profile, agentConfig, {
    ...request,
    targetName: request.requesterName || request.targetName || "Requesting agent",
    request: request.requirements || request.request || request.summary
  });
  const fallback = withProvider({
    status: deterministic.status,
    transcript: deterministic.processSteps,
    proposal: deterministic.approvalFields,
    summary: deterministic.agentResponse,
    requiresHumanApproval: true
  }, "deterministic", null, null);
  const validation = validateAgentChatContext({ profile, agentConfig, userContext });
  if (!validation.valid) return withProvider(fallback, "deterministic", null, validation.error);
  const ai = await requestAgentJson({
    env,
    fetchImpl,
    timeoutMs,
    purpose: "agent_to_agent_negotiation",
    system: featureSystemPrompt("agent_to_agent_negotiation"),
    payload: {
      task: "Simulate a safe agent-to-agent negotiation transcript. Do not make binding commitments. Require human approval.",
      output: {
        summary: "string<=220",
        transcript: [{ label: "string<=40", detail: "string<=160" }],
        proposal: { dealTitle: "string<=120", decision: "approved|rejected|pending_human_approval", reason: "string<=220" }
      },
      request: compactRequest(request),
      businessContext: compactBusinessContext(profile, agentConfig)
    }
  });
  if (!ai.ok) return withProvider(fallback, "deterministic", ai.model, ai.fallbackReason, ai.fallbackDetail);
  const parsed = ai.parsed || {};
  const identity = buildAgentIdentity(profile, agentConfig);
  const amount = Number(request.budgetAmount || request.budget || request.amount) || 0;
  const decision = enforceApprovalDecision(
    ALLOWED_DECISIONS.has(parsed.proposal?.decision) ? parsed.proposal.decision : fallback.proposal.decision,
    amount,
    identity
  );
  return withProvider({
    ...fallback,
    summary: clip(parsed.summary, 260) || fallback.summary,
    transcript: normalizeProcessSteps(parsed.transcript, fallback.transcript),
    proposal: {
      ...fallback.proposal,
      ...(parsed.proposal || {}),
      decision,
      reason: clip(parsed.proposal?.reason, 260) || fallback.proposal.reason
    }
  }, ai.provider, ai.model, null);
}

function featureSystemPrompt(purpose) {
  return [
    "You are a single business's own agent, rebuilt fresh from the supplied businessContext on every run.",
    "Act as businessContext.agent.name with the businessContext.agent.personality tone, honoring that business's specialties, rules, currency, and payment terms.",
    "Use only supplied compact context.",
    "Never reveal secrets, private minimum prices, API keys, or hidden rules.",
    "Every final transaction requires human approval, and any deal above businessContext.agent.autoApprovalLimit must be recommended for human approval, not auto-approved.",
    `Purpose: ${purpose}. Return only valid JSON matching the requested output shape.`
  ].join(" ");
}

function enforceApprovalDecision(decision, amount, identity) {
  if (decision === "approved" && exceedsAutoApprovalLimit(amount, identity?.autoApprovalLimit)) {
    return "pending_human_approval";
  }
  return decision;
}

function buildPromptPayload(profile, agentConfig, input, fallback) {
  return {
    ownerMessage: clip(input.message || input.request, 1000),
    deterministicTopic: fallback.topic,
    deterministicGuidance: clip(fallback.agentResponse, 500),
    businessContext: compactBusinessContext(profile, agentConfig)
  };
}

async function requestAgentJson({ env, fetchImpl, timeoutMs, system, payload, temperature = 0 }) {
  let last = null;

  if (typeof fetchImpl === "function" && clean(env.GROQ_API_KEY)) {
    const groqModel = clean(env.GROQ_MODEL) || DEFAULT_GROQ_MODEL;
    const result = await attemptProvider(
      "groq",
      groqModel,
      classifyGroqError,
      () => requestGroqJson({ env, fetchImpl, timeoutMs, model: groqModel, system, payload, temperature })
    );
    if (result.ok) return result;
    last = result;
  }

  if (typeof fetchImpl === "function" && clean(env.GEMINI_API_KEY)) {
    const geminiModel = clean(env.GEMINI_MODEL) || DEFAULT_GEMINI_MODEL;
    const result = await attemptProvider(
      "gemini",
      geminiModel,
      classifyGeminiError,
      () => requestGeminiJson({ env, fetchImpl, timeoutMs, model: geminiModel, system, payload, temperature })
    );
    if (result.ok) return result;
    last = result;
  }

  if (typeof fetchImpl === "function" && clean(env.ANTHROPIC_API_KEY)) {
    const claudeModel = clean(env.ANTHROPIC_MODEL) || DEFAULT_MODEL;
    const maxTokens = clampNumber(env.ANTHROPIC_MAX_TOKENS, 100, 1000, DEFAULT_MAX_TOKENS);
    const result = await attemptProvider(
      "anthropic",
      claudeModel,
      classifyAnthropicError,
      () => requestClaudeJson({ env, fetchImpl, timeoutMs, model: claudeModel, maxTokens, temperature, system, payload })
    );
    if (result.ok) return result;
    last = result;
  }

  return last || { ok: false, provider: "deterministic", model: null, fallbackReason: "ai_not_configured", fallbackDetail: "" };
}

async function attemptProvider(provider, model, classifyError, run) {
  try {
    const result = await run();
    if (result.ok && !result.parsed) {
      return { ok: false, provider, model: result.model || model, fallbackReason: `${provider}_invalid_response`, fallbackDetail: "" };
    }
    return { ...result, provider, model: result.model || model };
  } catch (error) {
    return { ok: false, provider, model, fallbackReason: classifyError(error), fallbackDetail: "" };
  }
}

async function requestGroqJson({ env, fetchImpl, timeoutMs, model, system, payload, temperature }) {
  const apiKey = clean(env.GROQ_API_KEY);
  const maxTokens = clampNumber(env.GROQ_MAX_TOKENS, 100, 2000, DEFAULT_MAX_TOKENS);
  const response = await fetchWithTimeout(fetchImpl, GROQ_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) }
      ]
    })
  }, timeoutMs);
  if (!response.ok) {
    const safeError = await readSafeGroqError(response);
    return {
      ok: false,
      model,
      fallbackReason: classifyGroqStatus(response.status, safeError.code),
      fallbackDetail: safeError.message
    };
  }
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  return { ok: true, model, parsed: parseJsonObject(text) };
}

async function requestGeminiJson({ env, fetchImpl, timeoutMs, model, system, payload, temperature }) {
  const apiKey = clean(env.GEMINI_API_KEY);
  const maxTokens = clampNumber(env.GEMINI_MAX_TOKENS, 100, 2000, DEFAULT_MAX_TOKENS);
  const url = `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json"
      }
    })
  }, timeoutMs);
  if (!response.ok) {
    const safeError = await readSafeGeminiError(response);
    return {
      ok: false,
      model,
      fallbackReason: classifyGeminiStatus(response.status, safeError.status),
      fallbackDetail: safeError.message
    };
  }
  const data = await response.json();
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part?.text)
    .filter(Boolean)
    .join("\n");
  return { ok: true, model, parsed: parseJsonObject(text) };
}

async function requestClaudeJson({ env, fetchImpl, timeoutMs, model, maxTokens, temperature, system, payload }) {
  const apiKey = clean(env.ANTHROPIC_API_KEY);
  const models = [model, ...FALLBACK_MODEL_CHAIN].map(clean).filter(Boolean);
  const uniqueModels = [...new Set(models)];
  let lastResult = null;
  for (const candidateModel of uniqueModels) {
    const result = await sendClaudeJson({ apiKey, fetchImpl, timeoutMs, model: candidateModel, maxTokens, temperature, system, payload });
    if (result.ok) return result;
    lastResult = result;
    if (!shouldRetryModel(result.fallbackReason)) break;
  }
  return lastResult || { ok: false, model, fallbackReason: "anthropic_unavailable" };
}

async function sendClaudeJson({ apiKey, fetchImpl, timeoutMs, model, maxTokens, temperature, system, payload }) {
  const response = await fetchWithTimeout(fetchImpl, ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: "user", content: JSON.stringify(payload) }]
    })
  }, timeoutMs);
  if (!response.ok) {
    const safeError = await readSafeAnthropicError(response);
    return {
      ok: false,
      model,
      fallbackReason: classifyAnthropicStatus(response.status, safeError.type),
      fallbackDetail: safeError.message
    };
  }
  const data = await response.json();
  const text = data?.content?.find((block) => block?.type === "text")?.text;
  return { ok: true, model, parsed: parseJsonObject(text) };
}

function compactBusinessContext(profile, agentConfig) {
  const capability = agentConfig.capability || {};
  const rules = agentConfig.negotiationRules || {};
  const escalation = agentConfig.escalationRules || {};
  const memory = agentConfig.memory || {};
  const identity = buildAgentIdentity(profile, agentConfig);

  return {
    agent: {
      name: clip(identity.name, 120),
      personality: clip(identity.personality, 160),
      specialties: clip(identity.specialties, 400),
      autoApprovalLimit: identity.autoApprovalLimit,
      maxDealValue: identity.maxDealValue,
      currency: clip(identity.currency, 12),
      paymentTerms: clip(identity.paymentTerms, 160),
      language: clip(identity.language, 40)
    },
    businessName: clip(profile.businessName, 120),
    category: clip(profile.category, 80),
    region: clip(profile.region, 120),
    language: clip(profile.language, 40),
    summary: clip(profile.summary, 400),
    capability: {
      name: clip(capability.name || profile.capabilityName, 120),
      description: clip(capability.description || profile.capabilityDescription, 400),
      tags: clip(capability.tags || profile.tags, 160),
      priceModel: clip(capability.priceModel || profile.pricingModel, 80),
      requiresConfirmation: capability.requiresConfirmation !== false
    },
    negotiationRules: {
      maxDealValue: Number(rules.maxDealValue || profile.maxDealValue) || 0,
      approvalRequiredAbove: Number(rules.approvalRequiredAbove || profile.approvalRequiredAbove) || 0,
      currencies: clip(rules.currencies || profile.currency || "USD", 40),
      paymentTerms: clip(rules.paymentTerms || profile.paymentTerms, 160)
    },
    escalationRules: {
      timeout: clip(escalation.timeout, 80),
      customTerms: Boolean(escalation.customTerms),
      outsideRegion: Boolean(escalation.outsideRegion),
      priceAboveThreshold: Boolean(escalation.priceAboveThreshold)
    },
    memory: {
      services: clip(memory.services, 300),
      serviceAreas: clip(memory.serviceAreas || profile.region, 160),
      policies: clip(memory.policies || profile.paymentTerms, 200),
      requiredBuyerInfo: clip(memory.requiredBuyerInfo, 160)
    }
  };
}

function normalizeNextActions(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const actions = value.map((action) => clip(action, 160)).filter(Boolean).slice(0, 3);
  return actions.length ? actions : fallback;
}

function normalizeStringArray(value, fallback = [], limit = 5, maxLength = 120) {
  if (!Array.isArray(value)) return fallback;
  const items = value.map((item) => clip(item, maxLength)).filter(Boolean).slice(0, limit);
  return items.length ? items : fallback;
}

function normalizeProcessSteps(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  const steps = value
    .map((step) => ({
      label: clip(step?.label, 50),
      detail: clip(step?.detail, 180)
    }))
    .filter((step) => step.label && step.detail)
    .slice(0, 6);
  return steps.length ? steps : fallback;
}

function compactDraft(draft = {}) {
  return {
    title: clip(draft.dealTitle || draft.title, 120),
    request: clip(draft.requirements, 500),
    amount: Number(draft.budgetAmount) || 0,
    currency: clip(draft.currency, 12),
    deadline: clip(draft.deadline, 40),
    risks: normalizeStringArray(draft.riskFlags, [], 6, 120),
    deterministicReason: clip(draft.reason, 240)
  };
}

function compactRequest(request = {}) {
  return {
    title: clip(request.title || request.dealTitle, 120),
    requester: clip(request.requesterName || request.targetName || request.buyerName, 100),
    capability: clip(request.capabilityId || request.capability || request.capabilityName, 100),
    requirements: clip(request.requirements || request.request || request.summary, 700),
    amount: Number(request.budgetAmount || request.budget || request.amount) || 0,
    currency: clip(request.currency, 12),
    region: clip(request.region || request.targetRegion || request.deliveryRegion, 100),
    deadline: clip(request.deadline || request.dueDate, 40)
  };
}

function classifyAnthropicStatus(status, errorType = "") {
  if (status === 401 || status === 403) return "anthropic_auth_failed";
  if (status === 404) return "anthropic_model_or_endpoint_not_found";
  if (/not_found|model/i.test(errorType)) return "anthropic_model_or_endpoint_not_found";
  if (/authentication|permission|forbidden|unauthorized/i.test(errorType)) return "anthropic_auth_failed";
  if (status === 400 || status === 422) return "anthropic_request_rejected";
  if (status === 429) return "anthropic_rate_limited";
  if (status >= 500) return "anthropic_service_error";
  return "anthropic_unavailable";
}

function classifyAnthropicError(error) {
  if (error?.name === "AbortError" || /abort|timeout/i.test(error?.message || "")) return "anthropic_timeout";
  return "anthropic_unavailable";
}

function classifyGroqStatus(status, code = "") {
  if (status === 401 || status === 403 || /invalid_api_key|authentication|permission/i.test(code)) return "groq_auth_failed";
  if (status === 404 || /not_found|model_not_found|model_decommissioned/i.test(code)) return "groq_model_or_endpoint_not_found";
  if (status === 429 || /rate_limit/i.test(code)) return "groq_rate_limited";
  if (status === 400 || status === 422 || /invalid_request|json_validate_failed/i.test(code)) return "groq_request_rejected";
  if (status >= 500) return "groq_service_error";
  return "groq_unavailable";
}

function classifyGroqError(error) {
  if (error?.name === "AbortError" || /abort|timeout/i.test(error?.message || "")) return "groq_timeout";
  return "groq_unavailable";
}

function classifyGeminiStatus(status, statusText = "") {
  if (status === 401 || status === 403 || /permission_denied|unauthenticated/i.test(statusText)) return "gemini_auth_failed";
  if (status === 404 || /not_found/i.test(statusText)) return "gemini_model_or_endpoint_not_found";
  if (status === 429 || /resource_exhausted/i.test(statusText)) return "gemini_rate_limited";
  if (status === 400 || status === 422 || /invalid_argument|failed_precondition/i.test(statusText)) return "gemini_request_rejected";
  if (status >= 500) return "gemini_service_error";
  return "gemini_unavailable";
}

function classifyGeminiError(error) {
  if (error?.name === "AbortError" || /abort|timeout/i.test(error?.message || "")) return "gemini_timeout";
  return "gemini_unavailable";
}

async function readSafeAnthropicError(response) {
  try {
    const data = await response.json();
    return {
      type: clean(data?.error?.type || data?.type || data?.error),
      message: clip(clean(data?.error?.message || data?.message), 240)
    };
  } catch {
    return { type: "", message: "" };
  }
}

async function readSafeGroqError(response) {
  try {
    const data = await response.json();
    return {
      code: clean(data?.error?.code || data?.error?.type || data?.code),
      message: clip(clean(data?.error?.message || data?.message), 240)
    };
  } catch {
    return { code: "", message: "" };
  }
}

async function readSafeGeminiError(response) {
  try {
    const data = await response.json();
    return {
      status: clean(data?.error?.status || data?.status),
      message: clip(clean(data?.error?.message || data?.message), 240)
    };
  } catch {
    return { status: "", message: "" };
  }
}

function shouldRetryModel(fallbackReason) {
  return fallbackReason === "anthropic_request_rejected" || fallbackReason === "anthropic_model_or_endpoint_not_found";
}

function parseJsonObject(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), clampNumber(timeoutMs, 500, 15000, DEFAULT_TIMEOUT_MS));
  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function withProvider(chat, provider, model, fallbackReason, fallbackDetail = "") {
  return {
    ...chat,
    provider,
    model,
    fallbackReason,
    fallbackDetail
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function clip(value, maxLength) {
  const text = clean(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function clean(value) {
  return String(value ?? "").trim();
}
