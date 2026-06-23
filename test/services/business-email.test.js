import test from "node:test";
import assert from "node:assert/strict";
import {
  BUSINESS_EMAIL_ERROR,
  PERSONAL_EMAIL_DOMAINS,
  validateBusinessEmail
} from "../../public/js/business-email.js";

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
