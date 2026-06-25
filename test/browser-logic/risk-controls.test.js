import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DAILY_DEAL_REQUESTS,
  MAX_NEGOTIATION_ROUNDS,
  MANUAL_REVIEW_FIRST_DEALS,
  NEW_BUSINESS_WAIT_DAYS,
  dailyDealRequestLimitStatus,
  requiresManualReviewForNewBusiness,
  shouldEscalateNegotiation,
  withinHardDealLimit
} from "../../public/risk-controls.js";

test("risk control constants match platform policy", () => {
  assert.equal(NEW_BUSINESS_WAIT_DAYS, 7);
  assert.equal(MAX_DAILY_DEAL_REQUESTS, 5);
  assert.equal(MANUAL_REVIEW_FIRST_DEALS, 3);
  assert.equal(MAX_NEGOTIATION_ROUNDS, 3);
});

test("new businesses require manual review during wait and first deals", () => {
  const review = requiresManualReviewForNewBusiness(
    {
      capabilityAccuracyConfirmed: true,
      businessEmailVerified: true,
      onboardingCompletedAtClient: "2026-06-20T00:00:00.000Z"
    },
    { completedDeals: 1 },
    new Date("2026-06-24T00:00:00.000Z")
  );

  assert.equal(review.required, true);
  assert.ok(review.reasons.includes("new_business_wait_period"));
  assert.ok(review.reasons.includes("first_deals_manual_review"));
});

test("verified mature businesses can pass manual review checks", () => {
  const review = requiresManualReviewForNewBusiness(
    {
      capabilityAccuracyConfirmed: true,
      businessEmailVerified: true,
      onboardingCompletedAtClient: "2026-06-01T00:00:00.000Z"
    },
    { completedDeals: 3 },
    new Date("2026-06-24T00:00:00.000Z")
  );

  assert.equal(review.required, false);
});

test("hard deal limits, daily limits, and negotiation caps are deterministic", () => {
  assert.equal(withinHardDealLimit(1001, { maxDealValue: 1000 }).ok, false);
  assert.equal(withinHardDealLimit(999, { maxDealValue: 1000 }).ok, true);
  assert.equal(dailyDealRequestLimitStatus(4).allowed, true);
  assert.equal(dailyDealRequestLimitStatus(5).allowed, false);
  assert.equal(shouldEscalateNegotiation(2), false);
  assert.equal(shouldEscalateNegotiation(3), true);
});
