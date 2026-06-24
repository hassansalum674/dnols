import test from "node:test";
import assert from "node:assert/strict";
import {
  createPasswordResetVerifier,
  makeResetCode
} from "../../src/services/password-reset.js";

test("password reset code is eight alphanumeric characters with letters and numbers", () => {
  const code = makeResetCode(sequenceRandomBytes([[0, 1, 2, 3, 24, 25, 26, 27]]));

  assert.equal(code, "ABCD2345");
  assert.match(code, /^[A-Z0-9]{8}$/);
  assert.match(code, /[A-Z]/);
  assert.match(code, /[0-9]/);
});

test("password reset sends a code without returning it to the browser", async () => {
  const fetchCalls = [];
  const store = new Map();
  const verifier = createPasswordResetVerifier({
    env: {
      RESEND_API_KEY: "test-key",
      RESEND_FROM_EMAIL: "security@dnols.example",
      RESEND_FROM_NAME: "Dnols Security"
    },
    now: () => Date.parse("2026-06-24T18:00:00.000Z"),
    randomBytes: sequenceRandomBytes([
      [0, 1, 2, 3, 24, 25, 26, 27],
      Array(16).fill(7)
    ]),
    store,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options, body: JSON.parse(options.body) });
      return { ok: true };
    }
  });

  const start = await verifier.startReset({ email: "Owner@Acme.Example", ip: "203.0.113.10" });

  assert.equal(start.ok, true);
  assert.equal(start.challengeId, "07070707070707070707070707070707");
  assert.equal(start.businessEmail, undefined);
  assert.equal(start.code, undefined);
  assert.match(start.message, /If this business email/);
  assert.match(fetchCalls[0].body.text, /ABCD2345/);
  assert.equal(fetchCalls[0].body.from, "Dnols Security <security@dnols.example>");
  assert.deepEqual(fetchCalls[0].body.to, ["owner@acme.example"]);

  const stored = store.get(start.challengeId);
  assert.equal(stored.email, "owner@acme.example");
  assert.notEqual(stored.codeHash, "ABCD2345");
});

test("password reset verifies code once and consumes challenge", async () => {
  const verifier = createVerifierWithCode("ABCD2345");
  const start = await verifier.startReset({ email: "owner@acme.example", ip: "203.0.113.10" });

  const verified = verifier.verifyCode({
    challengeId: start.challengeId,
    email: "owner@acme.example",
    code: "abcd 2345"
  });

  assert.equal(verified.ok, true);
  assert.equal(verified.resetAuthorized, true);
  assert.equal(typeof verified.resetToken, "string");
  assert.equal(verified.businessEmail, undefined);

  const replay = verifier.verifyCode({
    challengeId: start.challengeId,
    email: "owner@acme.example",
    code: "ABCD2345"
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.error, "reset_challenge_not_found");
});

test("password reset completes with new password after verified code", async () => {
  const updates = [];
  const verifier = createVerifierWithCode("ABCD2345", {
    passwordUpdater: async (input) => {
      updates.push(input);
      return { ok: true };
    }
  });
  const start = await verifier.startReset({ email: "Owner@Acme.Example", ip: "203.0.113.10" });
  const verified = verifier.verifyCode({
    challengeId: start.challengeId,
    email: "owner@acme.example",
    code: "ABCD2345"
  });

  const completed = await verifier.completeReset({
    challengeId: start.challengeId,
    email: "owner@acme.example",
    resetToken: verified.resetToken,
    newPassword: "StrongPass1!"
  });

  assert.equal(completed.ok, true);
  assert.equal(completed.passwordUpdated, true);
  assert.deepEqual(updates, [{ email: "owner@acme.example", password: "StrongPass1!" }]);

  const replay = await verifier.completeReset({
    challengeId: start.challengeId,
    email: "owner@acme.example",
    resetToken: verified.resetToken,
    newPassword: "StrongPass1!"
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.error, "reset_session_not_found");
});

test("password reset rejects expired completion session without updating password", async () => {
  let currentTime = Date.parse("2026-06-24T18:00:00.000Z");
  const updates = [];
  const verifier = createVerifierWithCode("ABCD2345", {
    now: () => currentTime,
    passwordUpdater: async (input) => {
      updates.push(input);
      return { ok: true };
    }
  });
  const start = await verifier.startReset({ email: "owner@acme.example", ip: "203.0.113.10" });
  const verified = verifier.verifyCode({
    challengeId: start.challengeId,
    email: "owner@acme.example",
    code: "ABCD2345"
  });

  currentTime += 5 * 60 * 1000 + 1;
  const completed = await verifier.completeReset({
    challengeId: start.challengeId,
    email: "owner@acme.example",
    resetToken: verified.resetToken,
    newPassword: "StrongPass1!"
  });

  assert.equal(completed.ok, false);
  assert.equal(completed.error, "reset_session_expired");
  assert.deepEqual(updates, []);
});

test("password reset validates completion token and limits bad attempts", async () => {
  const updates = [];
  const verifier = createVerifierWithCode("ABCD2345", {
    passwordUpdater: async (input) => {
      updates.push(input);
      return { ok: true };
    }
  });
  const start = await verifier.startReset({ email: "owner@acme.example", ip: "203.0.113.10" });
  verifier.verifyCode({
    challengeId: start.challengeId,
    email: "owner@acme.example",
    code: "ABCD2345"
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await verifier.completeReset({
      challengeId: start.challengeId,
      email: "owner@acme.example",
      resetToken: `wrong-${attempt}`,
      newPassword: "StrongPass1!"
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "reset_invalid_session");
  }

  const locked = await verifier.completeReset({
    challengeId: start.challengeId,
    email: "owner@acme.example",
    resetToken: "still-wrong",
    newPassword: "StrongPass1!"
  });
  assert.equal(locked.ok, false);
  assert.equal(locked.error, "reset_too_many_attempts");
  assert.deepEqual(updates, []);
});

test("password reset rejects weak new password before Firebase update", async () => {
  const updates = [];
  const verifier = createVerifierWithCode("ABCD2345", {
    passwordUpdater: async (input) => {
      updates.push(input);
      return { ok: true };
    }
  });
  const start = await verifier.startReset({ email: "owner@acme.example", ip: "203.0.113.10" });
  const verified = verifier.verifyCode({
    challengeId: start.challengeId,
    email: "owner@acme.example",
    code: "ABCD2345"
  });

  const completed = await verifier.completeReset({
    challengeId: start.challengeId,
    email: "owner@acme.example",
    resetToken: verified.resetToken,
    newPassword: "password"
  });

  assert.equal(completed.ok, false);
  assert.equal(completed.error, "weak_password");
  assert.deepEqual(updates, []);
});

test("password reset rejects new password containing business email details", async () => {
  const updates = [];
  const verifier = createVerifierWithCode("ABCD2345", {
    passwordUpdater: async (input) => {
      updates.push(input);
      return { ok: true };
    }
  });
  const start = await verifier.startReset({ email: "owner@acme.example", ip: "203.0.113.10" });
  const verified = verifier.verifyCode({
    challengeId: start.challengeId,
    email: "owner@acme.example",
    code: "ABCD2345"
  });

  const completed = await verifier.completeReset({
    challengeId: start.challengeId,
    email: "owner@acme.example",
    resetToken: verified.resetToken,
    newPassword: "Acme.example1!"
  });

  assert.equal(completed.ok, false);
  assert.equal(completed.error, "weak_password");
  assert.deepEqual(updates, []);
});

test("password reset fails safely when Firebase updater is not configured", async () => {
  const verifier = createVerifierWithCode("ABCD2345", {
    passwordUpdater: async () => ({
      ok: false,
      statusCode: 503,
      error: "firebase_admin_not_configured",
      message: "Password updates are not configured on the server yet."
    })
  });
  const start = await verifier.startReset({ email: "owner@acme.example", ip: "203.0.113.10" });
  const verified = verifier.verifyCode({
    challengeId: start.challengeId,
    email: "owner@acme.example",
    code: "ABCD2345"
  });

  const completed = await verifier.completeReset({
    challengeId: start.challengeId,
    email: "owner@acme.example",
    resetToken: verified.resetToken,
    newPassword: "StrongPass1!"
  });

  assert.equal(completed.ok, false);
  assert.equal(completed.statusCode, 503);
  assert.equal(completed.error, "firebase_admin_not_configured");
});

test("password reset expires challenges", async () => {
  let currentTime = Date.parse("2026-06-24T18:00:00.000Z");
  const verifier = createVerifierWithCode("ABCD2345", { now: () => currentTime });
  const start = await verifier.startReset({ email: "owner@acme.example", ip: "203.0.113.10" });

  currentTime += 10 * 60 * 1000 + 1;
  const result = verifier.verifyCode({
    challengeId: start.challengeId,
    email: "owner@acme.example",
    code: "ABCD2345"
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "reset_code_expired");
});

test("password reset limits incorrect verification attempts", async () => {
  const verifier = createVerifierWithCode("ABCD2345");
  const start = await verifier.startReset({ email: "owner@acme.example", ip: "203.0.113.10" });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = verifier.verifyCode({
      challengeId: start.challengeId,
      email: "owner@acme.example",
      code: "WRONG999"
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "reset_invalid_code");
  }

  const locked = verifier.verifyCode({
    challengeId: start.challengeId,
    email: "owner@acme.example",
    code: "ABCD2345"
  });
  assert.equal(locked.ok, false);
  assert.equal(locked.error, "reset_too_many_attempts");
});

test("password reset rate limits repeated requests per email", async () => {
  const verifier = createPasswordResetVerifier({
    env: {
      RESEND_API_KEY: "test-key",
      RESEND_FROM_EMAIL: "security@dnols.example"
    },
    randomBytes: repeatingRandomBytes(),
    fetchImpl: async () => ({ ok: true })
  });

  for (let request = 0; request < 3; request += 1) {
    const result = await verifier.startReset({ email: "owner@acme.example", ip: `203.0.113.${request}` });
    assert.equal(result.ok, true);
  }

  const limited = await verifier.startReset({ email: "owner@acme.example", ip: "203.0.113.99" });
  assert.equal(limited.ok, false);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.error, "reset_rate_limited");
});

test("password reset requires business email and configured sender", async () => {
  const verifier = createPasswordResetVerifier({
    env: { RESEND_API_KEY: "test-key" },
    randomBytes: repeatingRandomBytes(),
    fetchImpl: async () => ({ ok: true })
  });

  const personal = await verifier.startReset({ email: "owner@gmail.com" });
  assert.equal(personal.ok, false);
  assert.equal(personal.error, "business_email_required");

  const missingSender = await verifier.startReset({ email: "owner@acme.example" });
  assert.equal(missingSender.ok, false);
  assert.equal(missingSender.error, "sender_not_configured");
});

function createVerifierWithCode(code, overrides = {}) {
  const indexes = [...code].map((character) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".indexOf(character));
  return createPasswordResetVerifier({
    env: {
      RESEND_API_KEY: "test-key",
      RESEND_FROM_EMAIL: "security@dnols.example"
    },
    now: () => Date.parse("2026-06-24T18:00:00.000Z"),
    randomBytes: sequenceRandomBytes([indexes, Array(16).fill(9)]),
    fetchImpl: async () => ({ ok: true }),
    ...overrides
  });
}

function sequenceRandomBytes(sequences) {
  let call = 0;
  return (size) => {
    const sequence = sequences[Math.min(call, sequences.length - 1)];
    call += 1;
    return Buffer.from([...sequence, ...Array(size).fill(0)].slice(0, size));
  };
}

function repeatingRandomBytes() {
  let call = 0;
  return (size) => {
    call += 1;
    if (size === 8) return Buffer.from([0, 1, 2, 3, 24, 25, 26, 27]);
    return Buffer.alloc(size, call);
  };
}
