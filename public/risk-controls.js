export const NEW_BUSINESS_WAIT_DAYS = 7;
export const MAX_DAILY_DEAL_REQUESTS = 5;
export const MANUAL_REVIEW_FIRST_DEALS = 3;
export const MAX_NEGOTIATION_ROUNDS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export const RISK_REASONS = Object.freeze({
  CAPABILITY_NOT_CONFIRMED: "capability_accuracy_not_confirmed",
  NEW_BUSINESS_WAIT_PERIOD: "new_business_wait_period",
  FIRST_DEALS_MANUAL_REVIEW: "first_deals_manual_review",
  SELLER_NOT_VERIFIED: "seller_not_verified",
  OVER_HARD_DEAL_LIMIT: "over_hard_deal_limit",
  DAILY_DEAL_LIMIT_REACHED: "daily_deal_limit_reached",
  NEGOTIATION_ROUND_LIMIT: "negotiation_round_limit"
});

export function businessAgeDays(profile = {}, now = new Date()) {
  const startedAt = dateMs(
    profile.verifiedAtServer ||
      profile.onboardingCompletedAtServer ||
      profile.onboardingCompletedAtClient ||
      profile.createdAtClient ||
      profile.createdAt
  );
  if (!startedAt) return 0;
  return Math.max(0, Math.floor((dateMs(now) - startedAt) / DAY_MS));
}

export function isSellerVerified(profile = {}) {
  return Boolean(
    profile.businessEmailVerified ||
      profile.businessDomainVerified ||
      profile.status === "verified" ||
      profile.status === "published" ||
      profile.registryStatus === "published"
  );
}

export function requiresManualReviewForNewBusiness(profile = {}, stats = {}, now = new Date()) {
  const reasons = [];
  const completedDeals = numberOrZero(stats.completedDeals ?? profile.completedDeals ?? profile.transactionCount);
  if (!profile.capabilityAccuracyConfirmed) {
    reasons.push(RISK_REASONS.CAPABILITY_NOT_CONFIRMED);
  }
  if (!isSellerVerified(profile)) {
    reasons.push(RISK_REASONS.SELLER_NOT_VERIFIED);
  }
  if (businessAgeDays(profile, now) < NEW_BUSINESS_WAIT_DAYS) {
    reasons.push(RISK_REASONS.NEW_BUSINESS_WAIT_PERIOD);
  }
  if (completedDeals < MANUAL_REVIEW_FIRST_DEALS) {
    reasons.push(RISK_REASONS.FIRST_DEALS_MANUAL_REVIEW);
  }
  return {
    required: reasons.length > 0,
    reasons,
    completedDeals,
    businessAgeDays: businessAgeDays(profile, now)
  };
}

export function hardDealLimit(profile = {}, agentConfig = {}) {
  const rules = agentConfig.negotiationRules || {};
  return numberOrZero(rules.maxDealValue || profile.maxDealValue);
}

export function withinHardDealLimit(amount, profile = {}, agentConfig = {}) {
  const limit = hardDealLimit(profile, agentConfig);
  const value = numberOrZero(amount);
  return {
    ok: !limit || !value || value <= limit,
    amount: value,
    limit,
    reason: limit && value > limit ? RISK_REASONS.OVER_HARD_DEAL_LIMIT : ""
  };
}

export function shouldEscalateNegotiation(roundCount) {
  return numberOrZero(roundCount) >= MAX_NEGOTIATION_ROUNDS;
}

export function nextNegotiationRound(currentRoundCount) {
  return numberOrZero(currentRoundCount) + 1;
}

export function dailyDealRequestLimitStatus(countToday) {
  const count = numberOrZero(countToday);
  return {
    allowed: count < MAX_DAILY_DEAL_REQUESTS,
    countToday: count,
    limit: MAX_DAILY_DEAL_REQUESTS,
    reason: count >= MAX_DAILY_DEAL_REQUESTS ? RISK_REASONS.DAILY_DEAL_LIMIT_REACHED : ""
  };
}

export function firstDealsManualReviewStatus(count = 0) {
  const reviewed = numberOrZero(count);
  return {
    required: reviewed < MANUAL_REVIEW_FIRST_DEALS,
    completedDeals: reviewed,
    threshold: MANUAL_REVIEW_FIRST_DEALS,
    reason: reviewed < MANUAL_REVIEW_FIRST_DEALS ? RISK_REASONS.FIRST_DEALS_MANUAL_REVIEW : ""
  };
}

function dateMs(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toDate === "function") return value.toDate().getTime();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
