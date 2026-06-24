import { normalizeEastAfricaPhone } from "./js/phone.js";

export const PROFILE_STATUS = Object.freeze({
  DRAFT: "draft",
  PENDING_REVIEW: "pending_review",
  VERIFIED: "verified",
  PUBLISHED: "published",
  PAUSED: "paused"
});

export const REGISTRY_STATUS = Object.freeze({
  NOT_PUBLISHED: "not_published",
  PENDING_REVIEW: "pending_review",
  PUBLISHED: "published",
  PAUSED: "paused"
});

export const DEAL_STATUS = Object.freeze({
  NEW: "new",
  INITIATED: "initiated",
  NEGOTIATING: "negotiating",
  AGREED: "agreed",
  AGENT_REVIEWED: "agent_reviewed",
  PENDING_HUMAN_APPROVAL: "pending_human_approval",
  APPROVED: "approved",
  PAYMENT_SENT: "payment_sent",
  DELIVERED: "delivered",
  COMPLETE: "complete",
  DISPUTED: "disputed",
  BYPASSED: "bypassed",
  CANCELLED: "cancelled",
  REJECTED: "rejected",
  ORDER_CREATED: "order_created",
  COMPLETED: "completed"
});

export const REJECTION_REASON_CATEGORY = Object.freeze({
  PRICE_TOO_HIGH: "price_too_high",
  CANNOT_MEET_DEADLINE: "cannot_meet_deadline",
  SERVICE_NOT_AVAILABLE: "service_not_available",
  FOUND_BETTER_OPTION_ELSEWHERE: "found_better_option_elsewhere",
  OTHER: "other"
});

export const TRUST_SCORE_EVENT = Object.freeze({
  CONFIRMED: "confirmed",
  REJECTED_WITH_REASON: "rejected_with_reason",
  REJECTED_NO_REASON: "rejected_no_reason",
  DISPUTE_RAISED: "dispute_raised",
  DISPUTE_RESOLVED_FAIRLY: "dispute_resolved_fairly"
});

export const TRUST_SCORE_DELTA = Object.freeze({
  [TRUST_SCORE_EVENT.CONFIRMED]: 5,
  [TRUST_SCORE_EVENT.REJECTED_WITH_REASON]: -1,
  [TRUST_SCORE_EVENT.REJECTED_NO_REASON]: -3,
  [TRUST_SCORE_EVENT.DISPUTE_RAISED]: -8,
  [TRUST_SCORE_EVENT.DISPUTE_RESOLVED_FAIRLY]: 3
});

export const DEAL_ROOM_STATUS = Object.freeze({
  OPEN: "open",
  IN_PROGRESS: "in_progress",
  AWAITING_CONFIRMATION: "awaiting_confirmation",
  COMPLETE: "complete",
  DISPUTED: "disputed",
  BYPASSED: "bypassed"
});

export const DEAL_ROOM_MESSAGE_KIND = Object.freeze({
  MESSAGE: "message",
  AGENT_TERM: "agent_term",
  APPROVAL: "approval",
  DELIVERY: "delivery",
  DISPUTE: "dispute",
  SYSTEM: "system"
});

export const AGENT_RUN_TYPE = Object.freeze({
  TEST_SIMULATION: "test_simulation",
  INCOMING_REQUEST_REVIEW: "incoming_request_review",
  HUMAN_NEGOTIATION: "human_negotiation",
  OWNER_AGENT_CHAT: "owner_agent_chat",
  PUBLISHING_REVIEW: "publishing_review",
  PROFILE_UPDATE: "profile_update"
});

export function normalizeOnboardingProfile(input, result) {
  const currency = clean(input.currency).toUpperCase() || "USD";
  const maxDealValue = numberOrZero(input.maxDealValue);
  const approvalRequiredAbove = numberOrZero(input.approvalRequiredAbove);
  const phone = normalizeEastAfricaPhone(input.platformUpdatesPhone || input.approvalPhone, input);
  const normalizedPhoneFields = phone.valid ? phoneFields(phone) : {};

  return {
    businessName: clean(input.publisherName),
    domain: clean(input.domain),
    namespace: clean(input.namespace),
    category: clean(input.category),
    country: clean(input.country),
    region: clean(input.region),
    language: clean(input.language) || "English",
    summary: clean(input.summary),
    capabilityName: clean(input.serviceName),
    tags: clean(input.tags),
    capabilityDescription: clean(input.capabilityDescription),
    maxDealValue,
    approvalRequiredAbove,
    currency,
    approvalEmail: clean(input.approvalEmail || input.contact),
    approvalPhone: normalizedPhoneFields.approvalPhone || clean(input.approvalPhone),
    ...normalizedPhoneFields,
    contact: clean(input.contact),
    pricingModel: clean(input.pricingModel) || "quote",
    paymentTerms: clean(input.paymentTerms),
    executionPreference: clean(input.executionPreference) || "manual",
    protocol: clean(input.protocol) || "rest",
    endpoint: clean(input.baseUrl),
    authType: clean(input.authType) || "apiKey",
    readinessScore: result?.score?.score || 0,
    status: PROFILE_STATUS.PENDING_REVIEW,
    registryStatus: REGISTRY_STATUS.NOT_PUBLISHED,
    onboardingCompleted: true,
    onboardingCompletedAtClient: new Date().toISOString(),
    manifest: result?.manifest || {},
    agentProfileDraft: result?.agentProfileDraft || {},
    validation: result?.validation || {},
    agentConfig: buildAgentConfig(input, currency, maxDealValue, approvalRequiredAbove)
  };
}

export function validateDashboardProfile(profile) {
  const gaps = [];
  if (!clean(profile.businessName)) gaps.push("Business name");
  if (!clean(profile.domain)) gaps.push("Domain");
  if (!clean(profile.category)) gaps.push("Category");
  if (!clean(profile.region)) gaps.push("Region");
  if (!clean(profile.capabilityName || profile.agentConfig?.capability?.name)) gaps.push("Capability");
  if (!clean(profile.approvalEmail || profile.agentConfig?.escalationRules?.approvalEmail)) gaps.push("Approval email");
  return { valid: gaps.length === 0, gaps };
}

export function transitionPublishingStatus(currentProfile, registryStatus) {
  if (registryStatus === REGISTRY_STATUS.PAUSED) {
    return { status: PROFILE_STATUS.PAUSED, registryStatus: REGISTRY_STATUS.PAUSED };
  }
  if (registryStatus === REGISTRY_STATUS.PUBLISHED) {
    return { status: PROFILE_STATUS.PUBLISHED, registryStatus: REGISTRY_STATUS.PUBLISHED };
  }
  return {
    status: PROFILE_STATUS.PENDING_REVIEW,
    registryStatus: REGISTRY_STATUS.PENDING_REVIEW,
    previousRegistryStatus: currentProfile?.registryStatus || REGISTRY_STATUS.NOT_PUBLISHED
  };
}

export function buildAgentIdentity(profile = {}, agentConfig = {}) {
  const instructions = agentConfig.instructions || {};
  const capability = agentConfig.capability || {};
  const rules = agentConfig.negotiationRules || {};
  const memory = agentConfig.memory || {};
  const businessName = clean(profile.businessName) || clean(capability.name || profile.capabilityName) || "Business";
  const specialties = [
    capability.name || profile.capabilityName,
    capability.tags || profile.tags,
    memory.services || profile.summary,
    memory.serviceAreas || profile.region
  ]
    .map(clean)
    .filter(Boolean)
    .join("; ");

  return {
    name: clean(instructions.agentName) || `${businessName} Agent`,
    personality: clean(instructions.personality) || personalityFromTone(instructions.tone),
    specialties,
    currency: firstValue(rules.currencies || profile.currency || "USD").toUpperCase(),
    autoApprovalLimit: numberOrZero(rules.approvalRequiredAbove || profile.approvalRequiredAbove),
    maxDealValue: numberOrZero(rules.maxDealValue || profile.maxDealValue),
    minimumPrice: numberOrZero(rules.minimumPrice),
    paymentTerms: clean(rules.paymentTerms || profile.paymentTerms),
    language: clean(instructions.language || profile.language) || "English"
  };
}

export function exceedsAutoApprovalLimit(amount, autoApprovalLimit) {
  const limit = numberOrZero(autoApprovalLimit);
  return limit > 0 && numberOrZero(amount) > limit;
}

function personalityFromTone(tone) {
  const map = {
    professional: "professional and direct",
    friendly: "friendly and approachable",
    strict: "strict and detail-oriented, asks for documentation",
    concise: "concise and to the point"
  };
  return map[clean(tone)] || "professional and direct";
}

export function evaluateDealRequest(profile, agentConfig, request) {
  const rules = agentConfig?.negotiationRules || {};
  const capability = agentConfig?.capability || {};
  const memory = agentConfig?.memory || {};
  const amount = numberOrZero(request.budgetAmount || request.budget);
  const approvalThreshold = numberOrZero(rules.approvalRequiredAbove || profile.approvalRequiredAbove);
  const maxDealValue = numberOrZero(rules.maxDealValue || profile.maxDealValue);
  const requestText = `${request.requirements || ""} ${request.capabilityId || ""}`.toLowerCase();
  const capabilityText = `${capability.name || profile.capabilityName || ""}`.toLowerCase();
  const region = clean(request.region || request.targetRegion || request.deliveryRegion).toLowerCase();
  const allowedRegions = `${memory.serviceAreas || profile.region || ""}`.toLowerCase();
  const triggers = [];

  if (approvalThreshold > 0 && amount > approvalThreshold) {
    triggers.push("Budget is above the human approval threshold.");
  }
  if (maxDealValue > 0 && amount > maxDealValue) {
    triggers.push("Budget is above the maximum agent-negotiated deal value.");
  }
  if (region && allowedRegions && !allowedRegions.includes(region)) {
    triggers.push("Request region is outside configured service areas.");
  }
  if (capabilityText && requestText && !requestText.includes(capabilityText.split(" ")[0])) {
    triggers.push("Requested capability may not match the configured offer.");
  }
  if (!capabilityText) {
    triggers.push("No business capability is configured.");
  }
  if (/custom|exception|special|contract|legal/i.test(request.requirements || "")) {
    triggers.push("Request mentions custom terms that need human review.");
  }

  const humanApprovalRequired = true;
  const status = triggers.length ? DEAL_STATUS.PENDING_HUMAN_APPROVAL : DEAL_STATUS.AGENT_REVIEWED;

  return {
    status,
    humanApprovalRequired,
    triggers,
    summary: triggers.length
      ? "Agent reviewed this request and found items requiring human approval."
      : "Agent reviewed this request. It is ready for human approval before execution."
  };
}

export function buildNegotiationDraft(profile, agentConfig, task) {
  const config = agentConfig || {};
  const capability = config.capability || {};
  const rules = config.negotiationRules || {};
  const businessName = clean(profile.businessName) || "this business";
  const targetName = clean(task.targetName) || "Buyer";
  const capabilityName = clean(task.capability || capability.name || profile.capabilityName || "Business service");
  const budgetAmount = numberOrZero(task.budgetAmount || task.budget);
  const currency = clean(task.currency || firstValue(rules.currencies || profile.currency || "USD")).toUpperCase() || "USD";
  const requirements = clean(task.request || task.requirements || task.notes);
  const deadline = clean(task.deadline);
  const requestPayload = {
    title: `${capabilityName} request from ${targetName}`,
    targetName: businessName,
    requesterName: targetName,
    capabilityId: slugify(capabilityName),
    requirements,
    budgetAmount,
    currency,
    region: clean(task.region),
    deadline
  };
  const evaluation = evaluateDealRequest(profile, config, requestPayload);
  const maxDealValue = numberOrZero(rules.maxDealValue || profile.maxDealValue);
  const autoApprovalLimit = numberOrZero(rules.approvalRequiredAbove || profile.approvalRequiredAbove);
  const overMaxDealValue = maxDealValue > 0 && budgetAmount > maxDealValue;
  const overAutoApprovalLimit = exceedsAutoApprovalLimit(budgetAmount, autoApprovalLimit);
  const missingRequiredInfo = !requirements || !deadline || !budgetAmount;
  const riskFlags = [
    ...evaluation.triggers,
    ...(overMaxDealValue ? ["Budget is above the maximum configured deal value."] : []),
    ...(overAutoApprovalLimit ? [`Budget is above the ${currency} ${autoApprovalLimit} auto-approval limit; human approval required.`] : []),
    ...(missingRequiredInfo ? ["Some required deal fields are missing."] : [])
  ];
  const decisionRecommendation = overMaxDealValue || missingRequiredInfo
    ? DEAL_STATUS.REJECTED
    : overAutoApprovalLimit
      ? DEAL_STATUS.PENDING_HUMAN_APPROVAL
      : DEAL_STATUS.APPROVED;
  const reason = buildNegotiationReason({
    businessName,
    targetName,
    capabilityName,
    budgetAmount,
    currency,
    deadline,
    riskFlags,
    decisionRecommendation
  });
  const processSteps = [
    {
      label: "Received task",
      detail: requirements || "No request text provided."
    },
    {
      label: "Checked capability",
      detail: capabilityName ? `${businessName} can evaluate ${capabilityName}.` : "No capability is configured yet."
    },
    {
      label: "Checked budget",
      detail: budgetAmount ? `${currency} ${budgetAmount} compared with configured approval rules.` : "No budget provided."
    },
    {
      label: "Checked region",
      detail: task.region ? `${task.region} compared with service areas.` : "No buyer region provided."
    },
    {
      label: "Human action",
      detail: "A human owner must approve or reject before order creation or execution."
    }
  ];

  return {
    title: `Negotiation draft for ${targetName}`,
    dealTitle: `${capabilityName} - ${targetName}`,
    targetName,
    capability: capabilityName,
    requirements,
    budgetAmount,
    currency,
    region: clean(task.region),
    deadline,
    decisionRecommendation,
    reason,
    approvalRequired: true,
    status: evaluation.status,
    riskFlags,
    processSteps,
    agentResponse: riskFlags.length
      ? `I reviewed this for ${businessName}. It needs human review before moving forward because ${riskFlags.join(" ")}`
      : `I reviewed this for ${businessName}. The draft is ready for human approval before anything is finalized.`,
    approvalFields: {
      dealTitle: `${capabilityName} - ${targetName}`,
      decision: decisionRecommendation,
      reason
    },
    orderDraft: {
      title: `${capabilityName} - ${targetName}`,
      status: DEAL_STATUS.PENDING_HUMAN_APPROVAL,
      reason,
      budgetAmount,
      currency,
      deadline,
      targetName
    },
    requestPayload,
    evaluation,
    createdAtClient: new Date().toISOString()
  };
}

export function buildOwnerAgentChatResponse(profile = {}, agentConfig = {}, input = {}) {
  const message = clip(input.message || input.request, 1000);
  if (!message) {
    throw new Error("A message is required.");
  }

  const text = message.toLowerCase();
  const businessName = clean(profile.businessName) || "your business";
  const identity = buildAgentIdentity(profile, agentConfig);
  const capability = clean(agentConfig.capability?.name || profile.capabilityName || "your configured offer");
  const currency = clean(firstValue(agentConfig.negotiationRules?.currencies || profile.currency || "USD")).toUpperCase();
  const approvalThreshold = numberOrZero(agentConfig.negotiationRules?.approvalRequiredAbove || profile.approvalRequiredAbove);
  const maxDealValue = numberOrZero(agentConfig.negotiationRules?.maxDealValue || profile.maxDealValue);

  let topic = "general";
  let response = `I am ${identity.name}, working for ${businessName}. I can help with deals, orders, approvals, and publishing. Tell me what you want to move forward, and I will point you to the right dashboard area.`;
  const nextActions = ["Use Inbox for new requests, Approvals for owner decisions, Orders for delivery follow-up, and Public Publishing for registry changes."];

  if (/approv|reject|human|review|threshold/.test(text)) {
    topic = "approval";
    response = `Human approval is still required before execution. Review the Approvals area for decisions, and use Agent Settings only when you want to change the rules.`;
    nextActions.unshift(approvalThreshold ? `Current approval threshold signal: ${currency} ${approvalThreshold}.` : "Set an approval threshold later in Agent Settings if needed.");
  } else if (/deal|quote|negot|budget|price|request/.test(text)) {
    topic = "deal";
    response = `For a deal or quote, I can help you prepare the next step for ${capability}. Use the negotiation draft if you need structured approval fields, or Inbox if this is an incoming buyer request.`;
    nextActions.unshift(maxDealValue ? `Check the configured ${currency} ${maxDealValue} max deal value before approving.` : "Add a max deal value in Agent Settings when you are ready to enforce limits.");
  } else if (/order|deliver|delivery|paid|payment|complete/.test(text)) {
    topic = "order";
    response = "For order follow-up, open Orders and use the deal room to message the partner, mark payment, confirm delivery, or close the order when both sides have confirmed.";
    nextActions.unshift("Open Orders to continue delivery and confirmation tracking.");
  } else if (/publish|public|registry|listing|review/.test(text)) {
    topic = "publishing";
    response = "For publishing, use Public Publishing from the overview. Only reviewed public profile fields are prepared there; private rules, notes, and secrets stay out of the registry.";
    nextActions.unshift("Open Public Publishing to preview or submit the listing for review.");
  } else if (/setup|config|rule|security|secret|api|key|tool/.test(text)) {
    topic = "setup";
    response = "Setup, security rules, tool metadata, and private instructions live in Agent Settings. This chat can guide you, but it will not collect secrets or rewrite those rules here.";
    nextActions.unshift("Open Agent Settings for rules, memory, escalation, and tool metadata.");
  }

  return {
    title: "Owner chat with agent",
    type: AGENT_RUN_TYPE.OWNER_AGENT_CHAT,
    status: "answered",
    topic,
    ownerMessage: message,
    agentResponse: response,
    draftResponse: response,
    nextActions,
    messages: [
      {
        role: "owner",
        body: message
      },
      {
        role: "agent",
        body: response,
        nextActions
      }
    ],
    createdAtClient: new Date().toISOString()
  };
}

export function createAuditEvent(type, title, details = {}) {
  return {
    type,
    title,
    details: sanitizeDetails(details),
    createdAtClient: new Date().toISOString()
  };
}

export function normalizeDealStatus(status) {
  if (status === DEAL_STATUS.COMPLETED) return DEAL_STATUS.COMPLETE;
  if (status === DEAL_STATUS.ORDER_CREATED) return DEAL_STATUS.APPROVED;
  if (status === DEAL_STATUS.NEW) return DEAL_STATUS.INITIATED;
  if (status === DEAL_STATUS.AGENT_REVIEWED || status === DEAL_STATUS.PENDING_HUMAN_APPROVAL) return DEAL_STATUS.NEGOTIATING;
  return status || DEAL_STATUS.INITIATED;
}

export function normalizeRejectionReason(input = {}) {
  const category = clean(input.category || input.reasonCategory);
  const note = clean(input.note || input.reason);
  const validCategories = Object.values(REJECTION_REASON_CATEGORY);
  if (!validCategories.includes(category)) {
    throw new Error("A valid rejection reason category is required.");
  }
  return {
    category,
    note,
    status: DEAL_STATUS.REJECTED,
    trustScoreDelta: calculateTrustScoreDelta(TRUST_SCORE_EVENT.REJECTED_WITH_REASON)
  };
}

export function calculateTrustScoreDelta(eventType) {
  return TRUST_SCORE_DELTA[eventType] ?? 0;
}

export function applyTrustScoreChange(currentScore = 0, eventType) {
  const delta = calculateTrustScoreDelta(eventType);
  return {
    previousScore: numberOrZero(currentScore),
    nextScore: Math.max(0, Math.min(100, numberOrZero(currentScore) + delta)),
    delta
  };
}

export function buildOrderConfirmationState(order = {}) {
  const confirmations = order.confirmations || {};
  return {
    buyerPaid: Boolean(confirmations.buyerPaid || order.buyerPaid),
    sellerReceived: Boolean(confirmations.sellerReceived || order.sellerReceived || order.sellerDelivered),
    buyerPaidAtClient: confirmations.buyerPaidAtClient || order.buyerPaidAtClient || "",
    sellerReceivedAtClient: confirmations.sellerReceivedAtClient || order.sellerReceivedAtClient || ""
  };
}

export function applyOrderConfirmation(order = {}, action, now = new Date().toISOString()) {
  const confirmations = buildOrderConfirmationState(order);
  const auditEvents = [];
  if (action === "buyer_paid") {
    confirmations.buyerPaid = true;
    confirmations.buyerPaidAtClient = confirmations.buyerPaidAtClient || now;
    auditEvents.push("payment_sent");
  } else if (action === "seller_received" || action === "seller_delivered") {
    confirmations.sellerReceived = true;
    confirmations.sellerReceivedAtClient = confirmations.sellerReceivedAtClient || now;
    auditEvents.push("delivered");
  } else {
    throw new Error("Unsupported order confirmation action.");
  }

  const status = confirmations.buyerPaid && confirmations.sellerReceived
    ? DEAL_STATUS.COMPLETE
    : confirmations.buyerPaid
      ? DEAL_STATUS.PAYMENT_SENT
      : DEAL_STATUS.DELIVERED;
  if (status === DEAL_STATUS.COMPLETE) auditEvents.push("complete");

  return {
    status,
    confirmations,
    dealRoom: appendDealRoomTimeline(order.dealRoom || createDealRoom(order, {}, now), {
      kind: DEAL_ROOM_MESSAGE_KIND.DELIVERY,
      label: action === "buyer_paid" ? "Buyer marked payment sent" : "Seller marked delivery received",
      detail: status === DEAL_STATUS.COMPLETE ? "Both parties confirmed. Deal can close." : dealStatusText({ ...order, status, confirmations }, now),
      createdAtClient: now
    }),
    auditEvents,
    trustScoreEvent: status === DEAL_STATUS.COMPLETE ? TRUST_SCORE_EVENT.CONFIRMED : null,
    statusText: dealStatusText({ ...order, status, confirmations })
  };
}

export function openOrderDispute(order = {}, now = new Date().toISOString()) {
  return {
    status: DEAL_STATUS.DISPUTED,
    disputedAtClient: order.disputedAtClient || now,
    dealRoom: appendDealRoomTimeline(order.dealRoom || createDealRoom(order), {
      kind: DEAL_ROOM_MESSAGE_KIND.DISPUTE,
      label: "Dispute opened",
      detail: "A party reported an issue with this deal.",
      createdAtClient: now
    }),
    trustScoreEvent: TRUST_SCORE_EVENT.DISPUTE_RAISED,
    auditEvents: ["dispute_opened"]
  };
}

export function resolveOrderDisputeFairly(order = {}, now = new Date().toISOString()) {
  return {
    status: normalizeDealStatus(order.status) === DEAL_STATUS.COMPLETE ? DEAL_STATUS.COMPLETE : DEAL_STATUS.DELIVERED,
    disputeResolvedAtClient: now,
    trustScoreEvent: TRUST_SCORE_EVENT.DISPUTE_RESOLVED_FAIRLY,
    auditEvents: ["dispute_resolved_fairly"]
  };
}

export function dealStatusText(order = {}, now = new Date().toISOString()) {
  const status = normalizeDealStatus(order.status);
  if (status === DEAL_STATUS.DISPUTED) return "disputed";
  if (status === DEAL_STATUS.BYPASSED || order.bypassSignal?.suspected) return "suspected bypass";
  if (status === DEAL_STATUS.COMPLETE) return "complete";
  const confirmations = buildOrderConfirmationState(order);
  if (confirmations.buyerPaid && !confirmations.sellerReceived) return "awaiting seller confirmation";
  if (!confirmations.buyerPaid && confirmations.sellerReceived) return "awaiting buyer confirmation";
  if (isOrderOverdue(order, now)) return "overdue follow-up needed";
  return status ? status.replaceAll("_", " ") : "initiated";
}

export function createDealRoom(order = {}, context = {}, now = new Date().toISOString()) {
  const roomId = clean(order.dealRoom?.roomId || context.roomId || order.roomId || `room-${slugify(order.id || order.title || "deal")}`);
  const partnerName = clean(context.partnerName || order.partnerName || order.targetName || order.requesterName || "Deal partner");
  const title = clean(order.title || order.dealTitle || context.title || "Deal");
  const agreedTerms = {
    title,
    service: clean(context.service || order.capability || order.capabilityId || title),
    price: numberOrZero(context.price || order.budgetAmount || order.amount),
    currency: clean(context.currency || order.currency || "USD"),
    deadline: clean(context.deadline || order.deadline || order.dueDate),
    paymentTerms: clean(context.paymentTerms || order.paymentTerms || order.reason)
  };
  const timeline = order.dealRoom?.timeline?.length
    ? order.dealRoom.timeline
    : [
        buildTimelineEvent({
          kind: DEAL_ROOM_MESSAGE_KIND.AGENT_TERM,
          label: "Agents negotiated terms",
          detail: agreedTerms.price ? `${agreedTerms.currency} ${agreedTerms.price} for ${agreedTerms.service}` : agreedTerms.service,
          createdAtClient: now
        }),
        buildTimelineEvent({
          kind: DEAL_ROOM_MESSAGE_KIND.APPROVAL,
          label: "Human approval saved",
          detail: "Deal requires owner confirmation before execution.",
          createdAtClient: now
        }),
        buildTimelineEvent({
          kind: DEAL_ROOM_MESSAGE_KIND.SYSTEM,
          label: "Deal room opened",
          detail: "Messages and confirmations are recorded by Dnols.",
          createdAtClient: now
        })
      ];

  return {
    roomId,
    partnerName,
    partnerRole: clean(context.partnerRole || order.partnerRole || "partner"),
    openedAtClient: order.dealRoom?.openedAtClient || now,
    status: order.dealRoom?.status || DEAL_ROOM_STATUS.OPEN,
    agreedTerms,
    agentTranscript: context.agentTranscript || order.negotiationDraft?.processSteps || order.agentTranscript || [],
    timeline,
    lastMessagePreview: clean(order.dealRoom?.lastMessagePreview),
    messageCount: numberOrZero(order.dealRoom?.messageCount)
  };
}

export function appendDealRoomTimeline(room = {}, event = {}) {
  const nextEvent = buildTimelineEvent(event);
  return {
    ...room,
    status: roomStatusFromEvent(room.status, nextEvent),
    timeline: [...(room.timeline || []), nextEvent]
  };
}

export function buildDealRoomMessage(input = {}, now = new Date().toISOString()) {
  const body = clean(input.body || input.message);
  if (!body) {
    throw new Error("Deal room message body is required.");
  }
  const kind = Object.values(DEAL_ROOM_MESSAGE_KIND).includes(input.kind) ? input.kind : DEAL_ROOM_MESSAGE_KIND.MESSAGE;
  return {
    orderId: clean(input.orderId),
    roomId: clean(input.roomId),
    senderRole: clean(input.senderRole || "owner"),
    senderName: clean(input.senderName || "Owner"),
    recipientRole: clean(input.recipientRole || "partner"),
    recipientName: clean(input.recipientName || "Deal partner"),
    body: clip(body, 1000),
    kind,
    sender: {
      uid: clean(input.ownerUid || input.senderUid),
      role: clean(input.senderRole || "owner"),
      name: clean(input.senderName || "Owner")
    },
    recipient: {
      role: clean(input.recipientRole || "partner"),
      name: clean(input.recipientName || "Deal partner")
    },
    route: {
      channel: clean(input.channel || "dashboard"),
      command: kind === DEAL_ROOM_MESSAGE_KIND.MESSAGE ? "MSG" : kind.toUpperCase()
    },
    createdAtClient: now
  };
}

export function summarizeDealRoom(room = {}, messages = []) {
  const sortedMessages = [...messages].sort((a, b) => String(a.createdAtClient || "").localeCompare(String(b.createdAtClient || "")));
  const latest = sortedMessages.at(-1);
  return {
    roomId: room.roomId || "",
    status: room.status || DEAL_ROOM_STATUS.OPEN,
    partnerName: room.partnerName || "Deal partner",
    agreedTerms: room.agreedTerms || {},
    timelineCount: (room.timeline || []).length,
    messageCount: sortedMessages.length,
    lastMessagePreview: latest?.body || room.lastMessagePreview || "",
    awaiting: summarizeDealAwaiting(room.status)
  };
}

export function updateDealRoomAfterMessage(room = {}, message = {}) {
  return appendDealRoomTimeline(
    {
      ...room,
      lastMessagePreview: clip(message.body, 140),
      messageCount: numberOrZero(room.messageCount) + 1
    },
    {
      kind: message.kind || DEAL_ROOM_MESSAGE_KIND.MESSAGE,
      label: `${message.senderName || "Owner"} sent a message`,
      detail: clip(message.body, 160),
      createdAtClient: message.createdAtClient
    }
  );
}

export function evaluateBypassSuspicion({ orders = [], approvals = [], now = new Date().toISOString(), rejectionThreshold = 2, overdueDays = 7 } = {}) {
  const foundBetterRejections = approvals.filter((item) =>
    normalizeDealStatus(item.status || item.decision) === DEAL_STATUS.REJECTED &&
    rejectionCategory(item) === REJECTION_REASON_CATEGORY.FOUND_BETTER_OPTION_ELSEWHERE
  ).length;
  const overdueUnconfirmedOrders = orders.filter((order) =>
    ![DEAL_STATUS.COMPLETE, DEAL_STATUS.DISPUTED, DEAL_STATUS.BYPASSED, DEAL_STATUS.CANCELLED].includes(normalizeDealStatus(order.status)) &&
    isOrderOverdue(order, now, overdueDays)
  );
  const suspected = foundBetterRejections >= rejectionThreshold || overdueUnconfirmedOrders.length > 0;
  const reasons = [
    ...(foundBetterRejections >= rejectionThreshold ? ["repeated_found_better_option_rejections"] : []),
    ...(overdueUnconfirmedOrders.length ? ["overdue_unconfirmed_deals"] : [])
  ];
  return {
    suspected,
    reasons,
    foundBetterRejections,
    overdueUnconfirmedCount: overdueUnconfirmedOrders.length,
    overdueOrderIds: overdueUnconfirmedOrders.map((order) => order.id).filter(Boolean)
  };
}

export function isOrderOverdue(order = {}, now = new Date().toISOString(), overdueDays = 7) {
  const deadline = order.confirmationDeadline || order.deadline || order.dueDate;
  if (!deadline) return false;
  const deadlineTime = Date.parse(deadline);
  const nowTime = Date.parse(now);
  if (!Number.isFinite(deadlineTime) || !Number.isFinite(nowTime)) return false;
  return nowTime - deadlineTime > overdueDays * 24 * 60 * 60 * 1000;
}

function buildAgentConfig(input, currency, maxDealValue, approvalRequiredAbove) {
  const phone = normalizeEastAfricaPhone(input.platformUpdatesPhone || input.approvalPhone, input);
  const normalizedPhone = phone.valid ? phone.phone : clean(input.approvalPhone);
  return {
    status: PROFILE_STATUS.DRAFT,
    instructions: {
      agentName: clean(input.agentName) || `${clean(input.publisherName) || "Business"} Agent`,
      personality: clean(input.personality) || personalityFromTone(input.tone),
      role: `You represent ${clean(input.publisherName)} and respond to B2B requests.`,
      tone: clean(input.tone) || "professional",
      language: clean(input.language) || "English",
      alwaysSay: "Final execution requires human approval.",
      neverSay: "Never reveal private minimum prices or internal constraints.",
      privateRules: "Do not reveal private deal limits. Escalate custom terms to a human."
    },
    capability: {
      name: clean(input.serviceName),
      description: clean(input.capabilityDescription),
      tags: clean(input.tags),
      inputNeeded: "Buyer request details, budget, region, and deadline.",
      outputProvided: "Quote, next steps, or approval-ready deal summary.",
      turnaround: "Manual follow-up",
      priceModel: clean(input.pricingModel) || "quote",
      requiresConfirmation: true
    },
    negotiationRules: {
      minimumPrice: 0,
      quoteRange: "",
      maxDiscount: 0,
      maxDealValue,
      approvalRequiredAbove,
      currencies: currency,
      paymentTerms: clean(input.paymentTerms),
      deadlineFlexibility: "",
      preferredCustomers: "",
      blocked: ""
    },
    escalationRules: {
      approvalEmail: clean(input.approvalEmail || input.contact),
      approvalPhone: normalizedPhone,
      timeout: "24 hours",
      confidenceThreshold: 70,
      customTerms: true,
      outsideRegion: true,
      priceAboveThreshold: true
    },
    execution: {
      executionMode: clean(input.executionPreference) === "optional-api" ? "api-after-approval" : "manual",
      endpoint: clean(input.baseUrl),
      authType: clean(input.authType) || "apiKey",
      headers: "",
      requiresIdempotencyKey: false,
      requiresConfirmation: true
    },
    memory: {
      services: clean(input.summary),
      serviceAreas: clean(input.region),
      operatingHours: "",
      faqs: "",
      policies: clean(input.paymentTerms),
      requiredBuyerInfo: "Budget, requirements, region, and deadline.",
      preferredPartners: "",
      blacklist: ""
    },
    updatedAtClient: new Date().toISOString()
  };
}

function phoneFields(phone) {
  return {
    approvalPhone: phone.phone,
    notificationPhone: phone.phone,
    platformUpdatesPhone: phone.phone,
    phoneCountryCode: phone.countryCode,
    phoneCountry: phone.country,
    phoneCountryIso2: phone.countryIso2
  };
}

function sanitizeDetails(details) {
  const copy = JSON.parse(JSON.stringify(details || {}));
  delete copy.apiKey;
  delete copy.token;
  delete copy.headers;
  if (copy.agentConfig?.instructions) delete copy.agentConfig.instructions.privateRules;
  if (copy.agentConfig?.negotiationRules) delete copy.agentConfig.negotiationRules.minimumPrice;
  return copy;
}

function rejectionCategory(item) {
  return item.rejectionReason?.category || item.reasonCategory || item.category || "";
}

function buildTimelineEvent(event = {}) {
  return {
    kind: Object.values(DEAL_ROOM_MESSAGE_KIND).includes(event.kind) ? event.kind : DEAL_ROOM_MESSAGE_KIND.SYSTEM,
    label: clean(event.label || "Deal room event"),
    detail: clip(event.detail || "", 240),
    createdAtClient: event.createdAtClient || new Date().toISOString()
  };
}

function roomStatusFromEvent(currentStatus, event) {
  if (event.kind === DEAL_ROOM_MESSAGE_KIND.DISPUTE) return DEAL_ROOM_STATUS.DISPUTED;
  if (event.kind === DEAL_ROOM_MESSAGE_KIND.DELIVERY && /complete|received|delivered/i.test(event.label || event.detail || "")) {
    return DEAL_ROOM_STATUS.AWAITING_CONFIRMATION;
  }
  return currentStatus || DEAL_ROOM_STATUS.IN_PROGRESS;
}

function summarizeDealAwaiting(status) {
  if (status === DEAL_ROOM_STATUS.DISPUTED) return "Manual review";
  if (status === DEAL_ROOM_STATUS.COMPLETE) return "Nothing";
  if (status === DEAL_ROOM_STATUS.AWAITING_CONFIRMATION) return "Partner confirmation";
  return "Next message or confirmation";
}

function numberOrZero(value) {
  return Number(value) || 0;
}

function buildNegotiationReason({ businessName, targetName, capabilityName, budgetAmount, currency, deadline, riskFlags, decisionRecommendation }) {
  const action = decisionRecommendation === DEAL_STATUS.APPROVED ? "Recommended for human approval" : "Recommended for rejection or revision";
  const budget = budgetAmount ? `${currency} ${budgetAmount}` : "no budget";
  const date = deadline || "no deadline";
  const risks = riskFlags.length ? ` Risks: ${riskFlags.join(" ")}` : " No escalation risks were detected.";
  return `${action}: ${targetName} requested ${capabilityName} from ${businessName} with ${budget} and deadline ${date}.${risks}`;
}

function firstValue(value) {
  return String(value || "USD").split(",")[0].trim() || "USD";
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "business-service";
}

function clip(value, maxLength) {
  const text = clean(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function clean(value) {
  return String(value ?? "").trim();
}
