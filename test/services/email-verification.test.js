import test from "node:test";
import assert from "node:assert/strict";
import {
  clearEmailVerificationStore,
  confirmEmailVerification,
  getEmailVerificationRecord,
  requestEmailVerification
} from "../../src/services/email-verification.js";

test("email verification request rejects personal email domains", async () => {
  clearEmailVerificationStore();
  const result = await requestEmailVerification({
    email: "owner@gmail.com",
    env: {
      RESEND_API_KEY: "test-key",
      RESEND_FROM_EMAIL: "verify@example.com"
    },
    fetchImpl: async () => {
      throw new Error("should not send");
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 422);
  assert.equal(result.error, "business_email_required");
});

test("email verification request fails closed when Resend is not configured", async () => {
  clearEmailVerificationStore();
  let sent = false;
  const result = await requestEmailVerification({
    email: "owner@acme.example",
    env: {},
    fetchImpl: async () => {
      sent = true;
      return { ok: true };
    }
  });

  assert.equal(sent, false);
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 503);
  assert.equal(result.error, "resend_not_configured");
});

test("email verification request sends through mocked Resend and confirms code", async () => {
  clearEmailVerificationStore();
  let requestUrl;
  let requestHeaders;
  let requestBody;
  const now = Date.parse("2026-06-23T18:00:00.000Z");
  const result = await requestEmailVerification({
    email: "Owner@Acme.Example",
    now,
    env: {
      RESEND_API_KEY: "test-key",
      RESEND_FROM_EMAIL: "verify@dnols.example",
      RESEND_FROM_NAME: "Dnols Verify",
      APP_PUBLIC_URL: "https://dnols.com"
    },
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestHeaders = options.headers;
      requestBody = JSON.parse(options.body);
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.email, "owner@acme.example");
  assert.equal(requestUrl, "https://api.resend.com/emails");
  assert.equal(requestHeaders.Authorization, "Bearer test-key");
  assert.equal(requestBody.from, "Dnols Verify <verify@dnols.example>");
  assert.deepEqual(requestBody.to, ["owner@acme.example"]);
  assert.match(requestBody.text, /Code: \d{6}/);
  assert.match(requestBody.text, /https:\/\/dnols\.com\/login\.html\?verifyEmail=/);

  const record = getEmailVerificationRecord("owner@acme.example");
  assert.ok(record);
  const confirmation = confirmEmailVerification({
    email: "owner@acme.example",
    code: record.code,
    now: now + 1000
  });

  assert.equal(confirmation.ok, true);
  assert.equal(confirmation.verified, true);
  assert.equal(getEmailVerificationRecord("owner@acme.example"), null);
});

test("email verification codes expire", async () => {
  clearEmailVerificationStore();
  const now = Date.parse("2026-06-23T18:00:00.000Z");
  await requestEmailVerification({
    email: "owner@acme.example",
    now,
    ttlMs: 1000,
    env: {
      RESEND_API_KEY: "test-key",
      RESEND_FROM_EMAIL: "verify@dnols.example"
    },
    fetchImpl: async () => ({ ok: true })
  });
  const record = getEmailVerificationRecord("owner@acme.example");
  const confirmation = confirmEmailVerification({
    email: "owner@acme.example",
    code: record.code,
    now: now + 1001
  });

  assert.equal(confirmation.ok, false);
  assert.equal(confirmation.error, "verification_expired");
});
