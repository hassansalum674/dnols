import { buildOwnerAgentChatResponse } from "../../public/system-logic.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-3-5-haiku-latest";
const DEFAULT_MAX_TOKENS = 350;
const DEFAULT_TIMEOUT_MS = 8000;
const ALLOWED_TOPICS = new Set(["general", "approval", "deal", "order", "publishing", "setup"]);

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

  const apiKey = clean(env.ANTHROPIC_API_KEY);
  if (!apiKey || typeof fetchImpl !== "function") {
    return withProvider(fallback, "deterministic", null, "anthropic_not_configured");
  }

  const model = clean(env.ANTHROPIC_MODEL) || DEFAULT_MODEL;
  const maxTokens = clampNumber(env.ANTHROPIC_MAX_TOKENS, 100, 800, DEFAULT_MAX_TOKENS);

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      ANTHROPIC_MESSAGES_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0.2,
          system: [
            "You are a concise owner-assistance agent for a B2B dashboard.",
            "Use only the provided compact business context.",
            "Never request or reveal secrets, API keys, private minimum prices, or hidden internal rules.",
            "Final execution always requires human owner approval.",
            "Return only JSON with: topic, agentResponse, nextActions."
          ].join(" "),
          messages: [
            {
              role: "user",
              content: JSON.stringify(buildPromptPayload(profile, agentConfig, input, fallback))
            }
          ]
        })
      },
      timeoutMs
    );

    if (!response.ok) {
      return withProvider(fallback, "deterministic", model, "anthropic_unavailable");
    }

    const data = await response.json();
    const text = data?.content?.find((block) => block?.type === "text")?.text;
    const parsed = parseJsonObject(text);
    if (!parsed) {
      return withProvider(fallback, "deterministic", model, "anthropic_invalid_response");
    }

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
      "anthropic",
      model,
      null
    );
  } catch {
    return withProvider(fallback, "deterministic", model, "anthropic_unavailable");
  }
}

function buildPromptPayload(profile, agentConfig, input, fallback) {
  return {
    ownerMessage: clip(input.message || input.request, 1000),
    deterministicTopic: fallback.topic,
    deterministicGuidance: clip(fallback.agentResponse, 500),
    businessContext: compactBusinessContext(profile, agentConfig)
  };
}

function compactBusinessContext(profile, agentConfig) {
  const capability = agentConfig.capability || {};
  const rules = agentConfig.negotiationRules || {};
  const escalation = agentConfig.escalationRules || {};
  const memory = agentConfig.memory || {};

  return {
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

function withProvider(chat, provider, model, fallbackReason) {
  return {
    ...chat,
    provider,
    model,
    fallbackReason
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
