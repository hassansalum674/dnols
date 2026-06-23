import { createHash, createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";

export const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "rocketmail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "aol.com",
  "mail.com",
  "email.com",
  "yandex.com",
  "yandex.ru",
  "zoho.com",
  "zohomail.com",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "fastmail.com",
  "hey.com",
  "tutanota.com",
  "tuta.com",
  "mail.ru",
  "inbox.com",
  "qq.com",
  "163.com",
  "126.com",
  "rediffmail.com"
]);

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const CODE_BYTES = 3;
const BUSINESS_EMAIL_ERROR = "Use a business email address.";

export function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function extractEmailDomain(email) {
  const normalized = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return "";
  return normalized.split("@").at(-1).replace(/\.$/, "");
}

export function normalizeDomain(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .replace(/\.$/, "");
}

export function classifyEmailDomain(emailOrDomain) {
  const domain = normalizeDomain(String(emailOrDomain).includes("@") ? extractEmailDomain(emailOrDomain) : emailOrDomain);
  if (!domain) {
    return { valid: false, domain: "", business: false, reason: "invalid_email_domain" };
  }
  if (PERSONAL_EMAIL_DOMAINS.has(domain)) {
    return { valid: true, domain, business: false, reason: "personal_email_domain" };
  }
  return { valid: true, domain, business: true, reason: "business_email_domain" };
}

export function createBusinessEmailVerifier({
  env = process.env,
  fetchImpl = globalThis.fetch,
  randomBytes = nodeRandomBytes,
  now = () => Date.now(),
  store = new Map()
} = {}) {
  return {
    classifyEmailDomain,
    async startVerification(input = {}) {
      const email = normalizeEmail(input.email);
      const domain = extractEmailDomain(email);
      const classification = classifyEmailDomain(domain);
      if (!email || !classification.valid) {
        return failure(400, "invalid_email", BUSINESS_EMAIL_ERROR);
      }
      if (!classification.business) {
        return failure(422, "personal_email_not_allowed", BUSINESS_EMAIL_ERROR);
      }

      const expectedDomain = normalizeDomain(input.expectedDomain);
      if (expectedDomain && expectedDomain !== domain) {
        return failure(422, "domain_mismatch", `Use an email address at ${expectedDomain}.`);
      }

      const resendApiKey = env.RESEND_API_KEY;
      if (!resendApiKey) {
        return failure(503, "email_service_not_configured", "Business email verification is not configured yet.");
      }
      if (typeof fetchImpl !== "function") {
        return failure(503, "email_service_unavailable", "Email delivery is unavailable.");
      }

      const code = makeVerificationCode(randomBytes);
      const challengeId = randomBytes(16).toString("hex");
      const expiresAt = now() + DEFAULT_TTL_MS;
      store.set(challengeId, {
        email,
        domain,
        codeHash: hashCode(code),
        expiresAt,
        attempts: 0,
        ownerUid: String(input.ownerUid || "")
      });

      const delivery = await sendVerificationEmail({
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
        businessEmail: email,
        businessDomain: domain,
        expiresAt: new Date(expiresAt).toISOString()
      };
    },
    verifyCode(input = {}) {
      const challengeId = String(input.challengeId || "");
      const email = normalizeEmail(input.email);
      const code = String(input.code || "").replace(/\s+/g, "");
      const challenge = store.get(challengeId);

      if (!challenge) {
        return failure(400, "verification_not_found", "Verification request was not found or expired.");
      }
      if (challenge.expiresAt < now()) {
        store.delete(challengeId);
        return failure(400, "verification_expired", "Verification code expired. Send a new code.");
      }
      if (challenge.email !== email) {
        return failure(400, "email_mismatch", "Verification email does not match this request.");
      }
      if (challenge.attempts >= MAX_ATTEMPTS) {
        store.delete(challengeId);
        return failure(429, "too_many_attempts", "Too many incorrect attempts. Send a new code.");
      }

      challenge.attempts += 1;
      if (!safeEqual(challenge.codeHash, hashCode(code))) {
        return failure(400, "invalid_code", "Verification code is incorrect.");
      }

      store.delete(challengeId);
      const verifiedAtServer = new Date(now()).toISOString();
      return {
        ok: true,
        businessEmail: challenge.email,
        businessDomain: challenge.domain,
        businessEmailVerified: true,
        businessDomainVerified: true,
        verifiedAtServer,
        verificationToken: signVerification({
          env,
          email: challenge.email,
          domain: challenge.domain,
          ownerUid: challenge.ownerUid,
          verifiedAtServer
        })
      };
    }
  };
}

export async function sendVerificationEmail({ fetchImpl, apiKey, fromEmail, fromName, to, code }) {
  if (!fromEmail) {
    return failure(503, "sender_not_configured", "Business email sender is not configured yet.");
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
      subject: "Verify your Dnols business email",
      text: `Your Dnols business email verification code is ${code}. It expires in 15 minutes.`,
      html: `<p>Your Dnols business email verification code is <strong>${code}</strong>.</p><p>It expires in 15 minutes.</p>`
    })
  });

  if (!response.ok) {
    return failure(502, "email_delivery_failed", "Verification email could not be sent.");
  }
  return { ok: true };
}

function makeVerificationCode(randomBytes) {
  const value = randomBytes(CODE_BYTES).readUIntBE(0, CODE_BYTES) % 1000000;
  return String(value).padStart(6, "0");
}

function hashCode(code) {
  return createHash("sha256").update(String(code)).digest("hex");
}

function signVerification({ env, email, domain, ownerUid, verifiedAtServer }) {
  const secret = env.BUSINESS_EMAIL_VERIFICATION_SECRET || env.RESEND_API_KEY;
  if (!secret) return "";
  const payload = Buffer.from(JSON.stringify({ email, domain, ownerUid, verifiedAtServer })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function failure(statusCode, error, message) {
  return { ok: false, statusCode, error, message };
}
