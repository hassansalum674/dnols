import test from "node:test";
import assert from "node:assert/strict";
import {
  BUSINESS_EMAIL_ERROR,
  PERSONAL_EMAIL_DOMAINS,
  validateBusinessEmail
} from "../../public/js/business-email.js";
import { createBusinessEmailVerifier } from "../../src/services/business-email.js";

test("business email validation rejects common personal domains", () => {
  for (const domain of PERSONAL_EMAIL_DOMAINS) {
    const result = validateBusinessEmail(`owner@${domain}`);
    assert.equal(result.valid, false, domain);
    assert.equal(result.message, BUSINESS_EMAIL_ERROR);
  }
});

test("business email validation requires a sane dotted domain", () => {
  for (const email of ["owner", "owner@", "owner@example", "owner@-example.com", "owner@example..com"]) {
    const result = validateBusinessEmail(email);
    assert.equal(result.valid, false, email);
    assert.equal(result.message, BUSINESS_EMAIL_ERROR);
  }
});

test("business email validation accepts unknown business domains", () => {
  assert.deepEqual(validateBusinessEmail("Owner@Acme.Example"), {
    valid: true,
    email: "owner@acme.example",
    domain: "acme.example"
  });
});

test("Resend verification fails closed when API key is missing", async () => {
  let fetchCalled = false;
  const verifier = createBusinessEmailVerifier({
    env: { RESEND_FROM_EMAIL: "verify@dnols.example" },
    fetchImpl: async () => {
      fetchCalled = true;
      return { ok: true };
    }
  });

  const result = await verifier.startVerification({ email: "owner@acme.example" });

  assert.equal(fetchCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 503);
  assert.equal(result.error, "email_service_not_configured");
});

test("Resend verification sends with mocked transport and verifies code", async () => {
  const fetchCalls = [];
  const verifier = createBusinessEmailVerifier({
    env: {
      RESEND_API_KEY: "test-key",
      RESEND_FROM_EMAIL: "verify@dnols.example",
      RESEND_FROM_NAME: "Dnols Verify",
      BUSINESS_EMAIL_VERIFICATION_SECRET: "test-secret"
    },
    now: () => Date.parse("2026-06-23T18:00:00.000Z"),
    randomBytes: fixedRandomBytes(),
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options, body: JSON.parse(options.body) });
      return { ok: true };
    }
  });

  const start = await verifier.startVerification({
    ownerUid: "owner-a",
    email: "Owner@Acme.Example",
    expectedDomain: "acme.example"
  });

  assert.equal(start.ok, true);
  assert.equal(start.businessEmail, "owner@acme.example");
  assert.equal(start.businessDomain, "acme.example");
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://api.resend.com/emails");
  assert.equal(fetchCalls[0].options.headers.Authorization, "Bearer test-key");
  assert.equal(fetchCalls[0].body.from, "Dnols Verify <verify@dnols.example>");
  assert.deepEqual(fetchCalls[0].body.to, ["owner@acme.example"]);
  assert.match(fetchCalls[0].body.text, /123456/);

  const verified = verifier.verifyCode({
    challengeId: start.challengeId,
    email: "owner@acme.example",
    code: "123456"
  });

  assert.equal(verified.ok, true);
  assert.equal(verified.businessEmailVerified, true);
  assert.equal(verified.businessDomainVerified, true);
  assert.match(verified.verificationToken, /^[^.]+\.[^.]+$/);
});

function fixedRandomBytes() {
  let call = 0;
  return (size) => {
    call += 1;
    if (call % 2 === 1 && size === 3) return Buffer.from([0x01, 0xe2, 0x40]);
    return Buffer.alloc(size, call);
  };
}
