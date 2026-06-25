import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import { classifyEmailDomain, extractEmailDomain, normalizeEmail } from "./business-email.js";
import { getFirebaseAdminConfig, isFirebaseAdminModuleMissing, loadFirebaseAuth } from "./firebase-admin.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const RESET_AUTH_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS_PER_EMAIL = 3;
const MAX_REQUESTS_PER_IP = 10;
const MAX_VERIFY_ATTEMPTS = 5;
const MAX_COMPLETE_ATTEMPTS = 5;
const CODE_LENGTH = 8;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DIGIT_PATTERN = /[0-9]/;
const LETTER_PATTERN = /[A-Z]/;
const LOWERCASE_PATTERN = /[a-z]/;
const UPPERCASE_PATTERN = /[A-Z]/;
const SYMBOL_PATTERN = /[^A-Za-z0-9]/;
const PASSWORD_MIN_LENGTH = 12;
const GENERIC_START_MESSAGE =
  "If this business email can reset a Dnols dashboard password, a security code was sent.";
const GENERIC_VERIFY_MESSAGE = "The reset code is incorrect or expired.";
const GENERIC_COMPLETE_MESSAGE = "The password reset session is incorrect or expired.";

export function createPasswordResetVerifier({
  env = process.env,
  fetchImpl = globalThis.fetch,
  randomBytes = nodeRandomBytes,
  now = () => Date.now(),
  store = new Map(),
  rateLimitStore = new Map(),
  passwordUpdater
} = {}) {
  const updateFirebasePassword = passwordUpdater || createFirebasePasswordUpdater({ env });

  return {
    async startReset(input = {}) {
      const email = normalizeEmail(input.email);
      const domain = extractEmailDomain(email);
      const classification = classifyEmailDomain(domain);
      if (!email || !classification.valid || !classification.business) {
        return failure(422, "business_email_required", "Use a business email address.");
      }

      pruneRateLimits(rateLimitStore, now());
      const emailLimit = checkRateLimit(rateLimitStore, `email:${email}`, MAX_REQUESTS_PER_EMAIL, now());
      const ipLimit = checkRateLimit(rateLimitStore, `ip:${cleanIp(input.ip)}`, MAX_REQUESTS_PER_IP, now());
      if (!emailLimit.ok || !ipLimit.ok) {
        return failure(429, "reset_rate_limited", "Too many reset requests. Try again later.");
      }

      const resendApiKey = env.RESEND_API_KEY;
      if (!resendApiKey) {
        return failure(503, "email_service_not_configured", "Password reset email is not configured yet.");
      }
      if (typeof fetchImpl !== "function") {
        return failure(503, "email_service_unavailable", "Email delivery is unavailable.");
      }

      const code = makeResetCode(randomBytes);
      const challengeId = randomBytes(16).toString("hex");
      const expiresAt = now() + DEFAULT_TTL_MS;
      store.set(challengeId, {
        email,
        domain,
        codeHash: hashCode(code, challengeId),
        expiresAt,
        attempts: 0,
        completeAttempts: 0
      });

      const delivery = await sendPasswordResetCodeEmail({
        fetchImpl,
        apiKey: resendApiKey,
        fromEmail: env.RESEND_FROM_EMAIL,
        fromName: env.RESEND_FROM_NAME || "Dnols",
        to: email,
        code
      });

      if (!delivery.ok) {
        store.delete(challengeId);
        return delivery;
      }

      return {
        ok: true,
        challengeId,
        expiresAt: new Date(expiresAt).toISOString(),
        message: GENERIC_START_MESSAGE
      };
    },

    verifyCode(input = {}) {
      const challengeId = String(input.challengeId || "");
      const email = normalizeEmail(input.email);
      const code = normalizeCode(input.code);
      const challenge = store.get(challengeId);

      if (!challenge || !challenge.codeHash) {
        return failure(400, "reset_challenge_not_found", GENERIC_VERIFY_MESSAGE);
      }
      if (challenge.expiresAt < now()) {
        store.delete(challengeId);
        return failure(400, "reset_code_expired", GENERIC_VERIFY_MESSAGE);
      }
      if (challenge.email !== email) {
        return failure(400, "reset_email_mismatch", GENERIC_VERIFY_MESSAGE);
      }
      if (challenge.attempts >= MAX_VERIFY_ATTEMPTS) {
        store.delete(challengeId);
        return failure(429, "reset_too_many_attempts", "Too many incorrect attempts. Request a new code.");
      }

      challenge.attempts += 1;
      if (!safeEqual(challenge.codeHash, hashCode(code, challengeId))) {
        return failure(400, "reset_invalid_code", GENERIC_VERIFY_MESSAGE);
      }

      const resetToken = randomBytes(32).toString("hex");
      const resetExpiresAt = now() + RESET_AUTH_TTL_MS;
      challenge.codeHash = "";
      challenge.resetTokenHash = hashResetToken(resetToken, challengeId);
      challenge.expiresAt = resetExpiresAt;
      challenge.completeAttempts = 0;

      return {
        ok: true,
        resetAuthorized: true,
        resetToken,
        expiresAt: new Date(resetExpiresAt).toISOString(),
        message: "Code verified. Enter a new password to finish resetting your account."
      };
    },

    async completeReset(input = {}) {
      const challengeId = String(input.challengeId || "");
      const resetToken = String(input.resetToken || "");
      const email = normalizeEmail(input.email);
      const password = String(input.newPassword ?? input.password ?? "");
      const challenge = store.get(challengeId);

      if (!challenge || !challenge.resetTokenHash) {
        return failure(400, "reset_session_not_found", GENERIC_COMPLETE_MESSAGE);
      }
      if (challenge.expiresAt < now()) {
        store.delete(challengeId);
        return failure(400, "reset_session_expired", GENERIC_COMPLETE_MESSAGE);
      }
      if (challenge.email !== email) {
        return failure(400, "reset_email_mismatch", GENERIC_COMPLETE_MESSAGE);
      }
      if (challenge.completeAttempts >= MAX_COMPLETE_ATTEMPTS) {
        store.delete(challengeId);
        return failure(429, "reset_too_many_attempts", "Too many incorrect attempts. Request a new code.");
      }

      if (!safeEqual(challenge.resetTokenHash, hashResetToken(resetToken, challengeId))) {
        challenge.completeAttempts += 1;
        return failure(400, "reset_invalid_session", GENERIC_COMPLETE_MESSAGE);
      }

      const passwordValidation = validateNewPassword(password, {
        email: challenge.email,
        domain: challenge.domain
      });
      if (!passwordValidation.ok) {
        return passwordValidation;
      }

      const update = await updateFirebasePassword({ email: challenge.email, password });
      if (!update.ok) {
        return update;
      }

      store.delete(challengeId);
      return {
        ok: true,
        passwordUpdated: true,
        message: "Password updated. You can sign in with your new password."
      };
    }
  };
}

export async function sendPasswordResetCodeEmail({ fetchImpl, apiKey, fromEmail, fromName, to, code }) {
  if (!fromEmail) {
    return failure(503, "sender_not_configured", "Password reset sender is not configured yet.");
  }

  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: `${fromName} <${fromEmail}>`,
      to: [to],
      subject: "Confirm your Dnols password reset",
      text: `Your Dnols password reset security code is ${code}. It expires in 10 minutes.`,
      html: `<p>Your Dnols password reset security code is <strong>${code}</strong>.</p><p>It expires in 10 minutes. If you did not request this, ignore this email.</p>`
    })
  });

  if (!response.ok) {
    return failure(502, "reset_email_delivery_failed", "Password reset email could not be sent.");
  }
  return { ok: true };
}

export function makeResetCode(randomBytes = nodeRandomBytes) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = sampleCode(randomBytes);
    if (LETTER_PATTERN.test(code) && DIGIT_PATTERN.test(code)) return code;
  }

  const fallback = sampleCode(randomBytes).split("");
  fallback[0] = "A";
  fallback[1] = "2";
  return fallback.join("");
}

function sampleCode(randomBytes) {
  let code = "";
  while (code.length < CODE_LENGTH) {
    const bytes = randomBytes(CODE_LENGTH);
    for (const byte of bytes) {
      if (byte >= 248) continue;
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code;
}

function normalizeCode(value) {
  return String(value ?? "").replace(/[\s-]+/g, "").toUpperCase();
}

function hashCode(code, challengeId) {
  return createHash("sha256").update(`${challengeId}:${String(code)}`).digest("hex");
}

function hashResetToken(token, challengeId) {
  return createHash("sha256").update(`${challengeId}:reset:${String(token)}`).digest("hex");
}

function validateNewPassword(password, { email = "", domain = "" } = {}) {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return failure(
      422,
      "weak_password",
      `Use at least ${PASSWORD_MIN_LENGTH} characters with uppercase, lowercase, number, and symbol.`
    );
  }
  if (
    !LOWERCASE_PATTERN.test(password) ||
    !UPPERCASE_PATTERN.test(password) ||
    !DIGIT_PATTERN.test(password) ||
    !SYMBOL_PATTERN.test(password)
  ) {
    return failure(422, "weak_password", "Use uppercase, lowercase, number, and symbol characters.");
  }

  const lowerPassword = password.toLowerCase();
  const emailValue = normalizeEmail(email);
  const disallowedParts = [
    emailValue,
    emailValue.split("@")[0],
    extractEmailDomain(emailValue),
    domain
  ].map((part) => clean(part).toLowerCase()).filter((part) => part.length >= 4);
  if (disallowedParts.some((part) => lowerPassword.includes(part))) {
    return failure(422, "weak_password", "Do not include your email address or business domain in the new password.");
  }
  return { ok: true };
}

function createFirebasePasswordUpdater({ env = process.env } = {}) {
  let authPromise;
  return async ({ email, password }) => {
    const config = getFirebaseAdminConfig(env);
    if (!config.enabled) {
      return failure(
        503,
        "firebase_admin_not_configured",
        "Password updates are not configured on the server yet."
      );
    }

    try {
      if (!authPromise) {
        authPromise = loadFirebaseAuth(config);
      }
      const auth = await authPromise;
      const user = await auth.getUserByEmail(email);
      await auth.updateUser(user.uid, { password });
      if (typeof auth.revokeRefreshTokens === "function") {
        await auth.revokeRefreshTokens(user.uid);
      }
      return { ok: true };
    } catch (error) {
      const code = String(error?.code || error?.errorInfo?.code || "");
      if (code === "auth/user-not-found" || code === "user-not-found") {
        return { ok: true };
      }
      if (code === "auth/invalid-password" || code === "invalid-password") {
        return failure(422, "weak_password", "Use a stronger new password.");
      }
      if (isFirebaseAdminModuleMissing(error)) {
        return failure(
          503,
          "firebase_admin_not_configured",
          "Password updates are not configured on the server yet."
        );
      }
      return failure(503, "firebase_password_update_failed", "Password could not be updated right now.");
    }
  };
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function checkRateLimit(rateLimitStore, key, maxRequests, timestamp) {
  const entries = rateLimitStore.get(key) ?? [];
  const recent = entries.filter((entry) => timestamp - entry < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= maxRequests) {
    rateLimitStore.set(key, recent);
    return { ok: false };
  }
  recent.push(timestamp);
  rateLimitStore.set(key, recent);
  return { ok: true };
}

function pruneRateLimits(rateLimitStore, timestamp) {
  for (const [key, entries] of rateLimitStore.entries()) {
    const recent = entries.filter((entry) => timestamp - entry < RATE_LIMIT_WINDOW_MS);
    if (recent.length) {
      rateLimitStore.set(key, recent);
    } else {
      rateLimitStore.delete(key);
    }
  }
}

function cleanIp(value) {
  return String(value ?? "unknown").split(",")[0].trim() || "unknown";
}

function clean(value) {
  return String(value ?? "").trim();
}

function failure(statusCode, error, message) {
  return { ok: false, statusCode, error, message };
}
