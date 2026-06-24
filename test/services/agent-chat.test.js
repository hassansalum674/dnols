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
  assert.equal(result.fallbackReason, "ai_not_configured");
  assert.match(result.agentResponse, /Human approval/);
});

test("agent chat uses Groq as the primary provider when configured", async () => {
  let requestUrl;
  let requestHeaders;
  let requestBody;
  const result = await buildOwnerAgentChat({
    profile,
    agentConfig,
    userContext: { uid: "owner-a" },
    input: { message: "Help me with a buyer quote." },
    env: {
      GROQ_API_KEY: "groq-key",
      GROQ_MODEL: "llama-3.3-70b-versatile",
      GEMINI_API_KEY: "gem-key",
      ANTHROPIC_API_KEY: "test-key"
    },
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestHeaders = options.headers;
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    topic: "deal",
                    agentResponse: "Groq prepared a concise quote summary for owner approval.",
                    nextActions: ["Open Approvals before committing to terms."]
                  })
                }
              }
            ]
          };
        }
      };
    }
  });

  assert.equal(result.provider, "groq");
  assert.equal(result.model, "llama-3.3-70b-versatile");
  assert.equal(requestUrl, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(requestHeaders.Authorization, "Bearer groq-key");
  assert.equal(requestBody.response_format.type, "json_object");
  assert.equal(requestBody.model, "llama-3.3-70b-versatile");
  assert.match(result.agentResponse, /Groq prepared/);
});

test("agent chat falls back from Groq failure to Gemini", async () => {
  const calls = [];
  const result = await buildOwnerAgentChat({
    profile,
    agentConfig,
    userContext: { uid: "owner-a" },
    input: { message: "Help me with a buyer quote." },
    env: {
      GROQ_API_KEY: "groq-key",
      GROQ_MODEL: "llama-3.3-70b-versatile",
      GEMINI_API_KEY: "gem-key",
      GEMINI_MODEL: "gemini-2.5-flash-lite"
    },
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("api.groq.com")) {
        return {
          ok: false,
          status: 429,
          async json() {
            return { error: { code: "rate_limit_exceeded", message: "Rate limit reached." } };
          }
        };
      }
      return {
        ok: true,
        async json() {
          return {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        topic: "deal",
                        agentResponse: "Gemini answered after Groq rate limit.",
                        nextActions: ["Review Approvals."]
                      })
                    }
                  ]
                }
              }
            ]
          };
        }
      };
    }
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0], /api\.groq\.com/);
  assert.match(calls[1], /generativelanguage/);
  assert.equal(result.provider, "gemini");
  assert.match(result.agentResponse, /Gemini answered after Groq/);
});

test("agent chat uses Gemini as the primary provider when configured", async () => {
  let requestUrl;
  let requestBody;
  const result = await buildOwnerAgentChat({
    profile,
    agentConfig,
    userContext: { uid: "owner-a" },
    input: { message: "Help me with a buyer quote." },
    env: {
      GEMINI_API_KEY: "gem-key",
      GEMINI_MODEL: "gemini-2.5-flash-lite",
      ANTHROPIC_API_KEY: "test-key"
    },
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        topic: "deal",
                        agentResponse: "Gemini prepared a concise quote summary for owner approval.",
                        nextActions: ["Open Approvals before committing to terms."]
                      })
                    }
                  ]
                }
              }
            ]
          };
        }
      };
    }
  });

  assert.equal(result.provider, "gemini");
  assert.equal(result.model, "gemini-2.5-flash-lite");
  assert.match(requestUrl, /generativelanguage\.googleapis\.com/);
  assert.match(requestUrl, /gemini-2\.5-flash-lite:generateContent/);
  assert.equal(requestBody.generationConfig.responseMimeType, "application/json");
  assert.match(result.agentResponse, /Gemini prepared/);
});

test("agent chat falls back from Gemini billing failure to Claude", async () => {
  const calls = [];
  const result = await buildOwnerAgentChat({
    profile,
    agentConfig,
    userContext: { uid: "owner-a" },
    input: { message: "Help me with a buyer quote." },
    env: {
      GEMINI_API_KEY: "gem-key",
      GEMINI_MODEL: "gemini-2.5-flash-lite",
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_MODEL: "test-model"
    },
    fetchImpl: async (url) => {
      calls.push(url);
      if (String(url).includes("generativelanguage")) {
        return {
          ok: false,
          status: 429,
          async json() {
            return { error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded." } };
          }
        };
      }
      return {
        ok: true,
        async json() {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  topic: "deal",
                  agentResponse: "Claude answered after Gemini quota failure.",
                  nextActions: ["Review Approvals."]
                })
              }
            ]
          };
        }
      };
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(result.provider, "anthropic");
  assert.equal(result.model, "test-model");
  assert.match(result.agentResponse, /Claude answered/);
});

test("agent chat surfaces Gemini-only failure reason and detail", async () => {
  const result = await buildOwnerAgentChat({
    profile,
    agentConfig,
    userContext: { uid: "owner-a" },
    input: { message: "Hello" },
    env: {
      GEMINI_API_KEY: "gem-key",
      GEMINI_MODEL: "gemini-2.5-flash-lite"
    },
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      async json() {
        return { error: { status: "FAILED_PRECONDITION", message: "Billing required for this project." } };
      }
    })
  });

  assert.equal(result.provider, "deterministic");
  assert.equal(result.model, "gemini-2.5-flash-lite");
  assert.equal(result.fallbackReason, "gemini_request_rejected");
  assert.match(result.fallbackDetail, /Billing required/);
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

  assert.deepEqual(requestedModels, ["bad-model-name", "claude-3-5-haiku-20241022"]);
  assert.equal(result.provider, "anthropic");
  assert.equal(result.model, "claude-3-5-haiku-20241022");
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
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      async json() {
        return { error: { type: "invalid_request_error" } };
      }
    })
  });
  const negotiation = await buildAgentToAgentNegotiation({
    profile,
    agentConfig,
    userContext: { uid: "owner-a" },
    request: { requirements: "Need a quote.", budgetAmount: 500, deadline: "2026-07-01" },
    env: {}
  });

  assert.equal(evaluation.provider, "deterministic");
  assert.equal(evaluation.fallbackReason, "anthropic_request_rejected");
  assert.equal(negotiation.provider, "deterministic");
  assert.equal(negotiation.requiresHumanApproval, true);
});

const orbitProfile = {
  ownerUid: "owner-orbit",
  businessName: "Orbit Logistics",
  region: "Dar-Nairobi",
  currency: "USD",
  approvalRequiredAbove: 5000,
  capabilityName: "Freight forwarding"
};

const orbitConfig = {
  instructions: { agentName: "Orbit Logistics Agent", personality: "professional, direct" },
  capability: { name: "Freight forwarding", tags: "freight, logistics", requiresConfirmation: true },
  negotiationRules: { minimumPrice: 500, maxDealValue: 20000, approvalRequiredAbove: 5000, currencies: "USD", paymentTerms: "Payment on delivery" },
  memory: { services: "Freight services on Dar-Nairobi routes", serviceAreas: "Dar-Nairobi" }
};

const proTenderProfile = {
  ownerUid: "owner-protender",
  businessName: "ProTender",
  region: "East Africa",
  currency: "USD",
  approvalRequiredAbove: 2000,
  capabilityName: "Procurement"
};

const proTenderConfig = {
  instructions: { agentName: "ProTender Procurement Agent", personality: "detail-oriented, asks for documentation" },
  capability: { name: "Procurement", tags: "procurement, vendors", requiresConfirmation: true },
  negotiationRules: { minimumPrice: 0, maxDealValue: 10000, approvalRequiredAbove: 2000, currencies: "USD", paymentTerms: "Net 30" },
  memory: { services: "Procurement needs and preferred vendors", serviceAreas: "East Africa" }
};

async function captureGeminiPayload(callArgs) {
  let sentPayload;
  await buildOwnerAgentChat({
    ...callArgs,
    env: { GEMINI_API_KEY: "shared-key", GEMINI_MODEL: "gemini-2.5-flash-lite" },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      sentPayload = JSON.parse(body.contents[0].parts[0].text);
      return {
        ok: true,
        async json() {
          return {
            candidates: [
              { content: { parts: [{ text: JSON.stringify({ topic: "general", agentResponse: "Acknowledged.", nextActions: ["Open Approvals."] }) }] } }
            ]
          };
        }
      };
    }
  });
  return sentPayload;
}

test("each business gets its own agent identity from the same shared key", async () => {
  const orbitPayload = await captureGeminiPayload({
    profile: orbitProfile,
    agentConfig: orbitConfig,
    userContext: { uid: "owner-orbit" },
    input: { message: "A freight deal arrived." }
  });
  const proTenderPayload = await captureGeminiPayload({
    profile: proTenderProfile,
    agentConfig: proTenderConfig,
    userContext: { uid: "owner-protender" },
    input: { message: "A procurement deal arrived." }
  });

  assert.equal(orbitPayload.businessContext.agent.name, "Orbit Logistics Agent");
  assert.equal(orbitPayload.businessContext.agent.personality, "professional, direct");
  assert.equal(orbitPayload.businessContext.agent.autoApprovalLimit, 5000);

  assert.equal(proTenderPayload.businessContext.agent.name, "ProTender Procurement Agent");
  assert.equal(proTenderPayload.businessContext.agent.personality, "detail-oriented, asks for documentation");
  assert.equal(proTenderPayload.businessContext.agent.autoApprovalLimit, 2000);

  assert.notEqual(orbitPayload.businessContext.agent.name, proTenderPayload.businessContext.agent.name);
});

test("deterministic negotiation requires human approval above the auto-approval limit", async () => {
  const within = await buildAgentNegotiationDraft({
    profile: orbitProfile,
    agentConfig: orbitConfig,
    userContext: { uid: "owner-orbit" },
    input: { targetName: "Buyer", request: "Freight to Nairobi", budgetAmount: 1200, currency: "USD", deadline: "2026-07-01" },
    env: {}
  });
  const above = await buildAgentNegotiationDraft({
    profile: orbitProfile,
    agentConfig: orbitConfig,
    userContext: { uid: "owner-orbit" },
    input: { targetName: "Buyer", request: "Freight to Nairobi", budgetAmount: 9000, currency: "USD", deadline: "2026-07-01" },
    env: {}
  });

  assert.equal(within.provider, "deterministic");
  assert.equal(within.decisionRecommendation, "approved");
  assert.equal(above.decisionRecommendation, "pending_human_approval");
});

test("AI auto-approval is downgraded to human approval above the business limit", async () => {
  const result = await buildAgentNegotiationDraft({
    profile: proTenderProfile,
    agentConfig: proTenderConfig,
    userContext: { uid: "owner-protender" },
    input: { targetName: "Vendor", request: "Bulk supplies", budgetAmount: 8000, currency: "USD", deadline: "2026-07-10" },
    env: { GEMINI_API_KEY: "shared-key", GEMINI_MODEL: "gemini-2.5-flash-lite" },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      agentResponse: "Vendor proposal looks acceptable.",
                      reason: "Within vendor catalogue.",
                      decisionRecommendation: "approved",
                      riskFlags: [],
                      processSteps: [{ label: "Reviewed", detail: "Checked vendor terms." }]
                    })
                  }
                ]
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(result.provider, "gemini");
  assert.equal(result.decisionRecommendation, "pending_human_approval");
});
