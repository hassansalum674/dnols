import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentNegotiationDraft,
  buildAgentRequestEvaluation,
  buildAgentToAgentNegotiation,
  buildOwnerAgentChat,
  validateAgentChatContext
} from "../../src/services/agent-chat.js";

const profile = {
  ownerUid: "owner-a",
  businessName: "Sanelx",
  region: "East Africa",
  currency: "USD",
  approvalRequiredAbove: 250,
  capabilityName: "Service request"
};

const agentConfig = {
  instructions: {
    privateRules: "Do not expose this."
  },
  capability: {
    name: "Service request",
    description: "Procurement help",
    requiresConfirmation: true
  },
  negotiationRules: {
    minimumPrice: 50,
    maxDealValue: 1000,
    approvalRequiredAbove: 250,
    currencies: "USD"
  },
  execution: {
    endpoint: "https://private.example/api",
    headers: "Authorization: Bearer secret"
  }
};

test("agent chat falls back deterministically without Anthropic configuration", async () => {
  const result = await buildOwnerAgentChat({
    profile,
    agentConfig,
    userContext: { uid: "owner-a" },
    input: { message: "Should I approve this request?" },
    env: {}
  });

  assert.equal(result.provider, "deterministic");
  assert.equal(result.fallbackReason, "anthropic_not_configured");
  assert.match(result.agentResponse, /Human approval/);
});

test("agent chat validates user context without trusting arbitrary business ids", () => {
  assert.deepEqual(validateAgentChatContext({
    profile: { ...profile, ownerUid: "owner-a", businessId: "business-b" },
    agentConfig,
    userContext: { uid: "owner-a" }
  }), { valid: true });

  const mismatch = validateAgentChatContext({
    profile,
    agentConfig,
    userContext: { uid: "owner-b" }
  });
  assert.equal(mismatch.valid, false);
  assert.equal(mismatch.statusCode, 403);
});

test("agent chat sends compact server-side Anthropic payload only", async () => {
  let requestUrl;
  let requestHeaders;
  let requestBody;
  const result = await buildOwnerAgentChat({
    profile,
    agentConfig,
    userContext: { uid: "owner-a" },
    input: { message: "Help me with a buyer quote." },
    env: {
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_MODEL: "test-model",
      ANTHROPIC_MAX_TOKENS: "250"
    },
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestHeaders = options.headers;
      requestBody = JSON.parse(options.body);
      assert.ok(options.signal instanceof AbortSignal);
      return {
        ok: true,
        async json() {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  topic: "deal",
                  agentResponse: "Prepare the quote summary, then ask the owner to approve before execution.",
                  nextActions: ["Open Approvals before committing to terms."]
                })
              }
            ]
          };
        }
      };
    }
  });

  const prompt = JSON.parse(requestBody.messages[0].content);
  assert.equal(result.provider, "anthropic");
  assert.equal(result.model, "test-model");
  assert.equal(requestUrl, "https://api.anthropic.com/v1/messages");
  assert.equal(requestHeaders["x-api-key"], "test-key");
  assert.equal(requestHeaders["anthropic-version"], "2023-06-01");
  assert.equal(requestBody.max_tokens, 250);
  assert.equal(prompt.businessContext.businessName, "Sanelx");
  assert.equal(prompt.businessContext.negotiationRules.minimumPrice, undefined);
  assert.equal(prompt.businessContext.execution, undefined);
  assert.equal(prompt.businessContext.instructions, undefined);
});

test("agent chat falls back when Anthropic request times out", async () => {
  const result = await buildOwnerAgentChat({
    profile,
    agentConfig,
    userContext: { uid: "owner-a" },
    input: { message: "Can Claude help with this quote?" },
    env: {
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_MODEL: "test-model",
      ANTHROPIC_MAX_TOKENS: "250"
    },
    timeoutMs: 1,
    fetchImpl: async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")));
      })
  });

  assert.equal(result.provider, "deterministic");
  assert.equal(result.model, "test-model");
  assert.equal(result.fallbackReason, "anthropic_timeout");
  assert.match(result.agentResponse, /deal|quote|Inbox/i);
});

test("agent chat exposes safe fallback reason for Anthropic auth failure", async () => {
  const result = await buildOwnerAgentChat({
    profile,
    agentConfig,
    userContext: { uid: "owner-a" },
    input: { message: "Hello" },
    env: {
      ANTHROPIC_API_KEY: "bad-key",
      ANTHROPIC_MODEL: "test-model"
    },
    fetchImpl: async () => ({ ok: false, status: 401 })
  });

  assert.equal(result.provider, "deterministic");
  assert.equal(result.fallbackReason, "anthropic_auth_failed");
});

test("agent chat retries safe default model when configured model is rejected", async () => {
  const requestedModels = [];
  const result = await buildOwnerAgentChat({
    profile,
    agentConfig,
    userContext: { uid: "owner-a" },
    input: { message: "Help with a request." },
    env: {
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_MODEL: "bad-model-name"
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requestedModels.push(body.model);
      if (body.model === "bad-model-name") return { ok: false, status: 400 };
      return {
        ok: true,
        async json() {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  topic: "deal",
                  agentResponse: "Claude answered after retrying the safe default model.",
                  nextActions: ["Review the request before approving."]
                })
              }
            ]
          };
        }
      };
    }
  });

  assert.deepEqual(requestedModels, ["bad-model-name", "claude-3-5-haiku-latest"]);
  assert.equal(result.provider, "anthropic");
  assert.equal(result.model, "claude-3-5-haiku-latest");
  assert.match(result.agentResponse, /retrying the safe default model/);
});

test("agent chat keeps auth failures on configured model without retrying", async () => {
  const requestedModels = [];
  const result = await buildOwnerAgentChat({
    profile,
    agentConfig,
    userContext: { uid: "owner-a" },
    input: { message: "Hello" },
    env: {
      ANTHROPIC_API_KEY: "bad-key",
      ANTHROPIC_MODEL: "bad-model-name"
    },
    fetchImpl: async (_url, options) => {
      requestedModels.push(JSON.parse(options.body).model);
      return { ok: false, status: 401 };
    }
  });

  assert.deepEqual(requestedModels, ["bad-model-name"]);
  assert.equal(result.provider, "deterministic");
  assert.equal(result.model, "bad-model-name");
  assert.equal(result.fallbackReason, "anthropic_auth_failed");
});

test("negotiation draft uses Anthropic JSON when available", async () => {
  const result = await buildAgentNegotiationDraft({
    profile,
    agentConfig,
    userContext: { uid: "owner-a" },
    input: {
      targetName: "Buyer Agent",
      capability: "Service request",
      request: "Need procurement support by Friday.",
      budgetAmount: 300,
      currency: "USD",
      deadline: "2026-07-01"
    },
    env: {
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_MODEL: "test-model"
    },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                agentResponse: "Claude prepared a concise approval-ready negotiation draft.",
                reason: "Budget is within the configured range but still needs owner approval.",
                decisionRecommendation: "approved",
                riskFlags: ["Confirm delivery date."],
                processSteps: [{ label: "Reviewed terms", detail: "Checked service, budget, and deadline." }]
              })
            }
          ]
        };
      }
    })
  });

  assert.equal(result.provider, "anthropic");
  assert.equal(result.agentResponse, "Claude prepared a concise approval-ready negotiation draft.");
  assert.deepEqual(result.riskFlags, ["Confirm delivery date."]);
});

test("request evaluation and agent-to-agent negotiation fall back safely", async () => {
  const evaluation = await buildAgentRequestEvaluation({
    profile,
    agentConfig,
    userContext: { uid: "owner-a" },
    request: { requirements: "Need custom terms.", budgetAmount: 500, deadline: "2026-07-01", capabilityId: "service" },
    env: { ANTHROPIC_API_KEY: "bad-key", ANTHROPIC_MODEL: "bad-model" },
    fetchImpl: async () => ({ ok: false, status: 400 })
  });
  const negotiation = await buildAgentToAgentNegotiation({
    profile,
    agentConfig,
    userContext: { uid: "owner-a" },
    request: { requirements: "Need a quote.", budgetAmount: 500, deadline: "2026-07-01" },
    env: {}
  });

  assert.equal(evaluation.provider, "deterministic");
  assert.equal(evaluation.fallbackReason, "anthropic_bad_request_or_model");
  assert.equal(negotiation.provider, "deterministic");
  assert.equal(negotiation.requiresHumanApproval, true);
});
