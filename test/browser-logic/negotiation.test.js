import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_RUN_TYPE,
  DEAL_STATUS,
  buildOwnerAgentChatResponse,
  buildNegotiationDraft
} from "../../public/system-logic.js";

test("human negotiation draft autofills approval-safe fields", () => {
  const draft = buildNegotiationDraft(
    {
      ownerUid: "owner-a",
      businessName: "Sanelx",
      region: "East Africa",
      currency: "USD",
      maxDealValue: 1000,
      approvalRequiredAbove: 250,
      capabilityName: "Service request"
    },
    {
      capability: {
        name: "Service request",
        requiresConfirmation: true
      },
      negotiationRules: {
        maxDealValue: 1000,
        approvalRequiredAbove: 250,
        currencies: "USD"
      },
      memory: {
        serviceAreas: "East Africa"
      }
    },
    {
      targetName: "Acme Buyer",
      capability: "Service request",
      budgetAmount: 400,
      currency: "USD",
      region: "East Africa",
      deadline: "2026-07-30",
      request: "Please prepare a service quote."
    }
  );

  assert.equal(AGENT_RUN_TYPE.HUMAN_NEGOTIATION, "human_negotiation");
  assert.equal(draft.approvalRequired, true);
  assert.equal(draft.approvalFields.dealTitle, "Service request - Acme Buyer");
  assert.equal(draft.approvalFields.decision, DEAL_STATUS.APPROVED);
  assert.equal(draft.orderDraft.status, DEAL_STATUS.PENDING_HUMAN_APPROVAL);
  assert.ok(draft.processSteps.length >= 5);
  assert.ok(draft.riskFlags.some((flag) => flag.includes("approval threshold")));
});

test("human negotiation draft recommends rejection when required fields are missing", () => {
  const draft = buildNegotiationDraft(
    {
      businessName: "Sanelx",
      region: "East Africa",
      capabilityName: "Service request"
    },
    {
      capability: {
        name: "Service request",
        requiresConfirmation: true
      }
    },
    {
      targetName: "Acme Buyer",
      capability: "Service request",
      request: "Can you help us?"
    }
  );

  assert.equal(draft.decisionRecommendation, DEAL_STATUS.REJECTED);
  assert.ok(draft.riskFlags.some((flag) => flag.includes("required deal fields")));
});

test("owner agent chat gives deterministic approval guidance without secrets", () => {
  const result = buildOwnerAgentChatResponse(
    {
      businessName: "Sanelx",
      currency: "USD",
      approvalRequiredAbove: 250,
      capabilityName: "Service request"
    },
    {
      negotiationRules: {
        approvalRequiredAbove: 250,
        currencies: "USD"
      }
    },
    {
      message: "Should I approve this buyer request?"
    }
  );

  assert.equal(result.type, AGENT_RUN_TYPE.OWNER_AGENT_CHAT);
  assert.equal(result.topic, "approval");
  assert.match(result.agentResponse, /Human approval/);
  assert.ok(result.nextActions.some((action) => action.includes("USD 250")));
  assert.deepEqual(result.messages.map((message) => message.role), ["owner", "agent"]);
});
