import { randomBytes, randomInt } from "node:crypto";
import { validateBusinessEmail } from "../../public/js/business-email.js";

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_RESEND_URL = "https://api.resend.com/emails";
const verificationStore = new Map();

export function requestEmailVerification({
  email,
  env = process.env,
  fetchImpl = fetch,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS
}) {
  return requestEmailVerificationInternal({ email, env, fetchImpl, now, ttlMs });
}

export function confirmEmailVerification({ email, code, token, now = Date.now() }) {
  const validation = validateBusinessEmail(email);
  if (!validation.valid) {
    return {
      ok: false,
      statusCode: 422,
      error: "business_email_required",
      message: validation.message
    };
  }

  cleanupExpired(now);
  const record = verificationStore.get(validation.email);
  if (!record || record.expiresAt <= now) {
    verificationStore.delete(validation.email);
    return {
      ok: false,
      statusCode: 400,
      error: "verification_expired",
      message: "Verification expired. Request a new email."
    };
  }

  const submittedCode = String(code ?? "").trim();
  const submittedToken = String(token ?? "").trim();
  const matchesCode = submittedCode && submittedCode === record.code;
  const matchesToken = submittedToken && submittedToken === record.token;

  if (!matchesCode && !matchesToken) {
    return {
      ok: false,
      statusCode: 400,
      error: "verification_invalid",
      message: "Verification code is incorrect."
    };
  }

  verificationStore.delete(validation.email);
  return {
    ok: true,
    statusCode: 200,
    email: validation.email,
    domain: validation.domain,
    verified: true
  };
}

export function clearEmailVerificationStore() {
  verificationStore.clear();
}

export function getEmailVerificationRecord(email) {
  return verificationStore.get(String(email ?? "").trim().toLowerCase()) ?? null;
}

async function requestEmailVerificationInternal({ email, env, fetchImpl, now, ttlMs }) {
  const validation = validateBusinessEmail(email);
  if (!validation.valid) {
    return {
      ok: false,
      statusCode: 422,
      error: "business_email_required",
      message: validation.message
    };
  }

  const apiKey = clean(env.RESEND_API_KEY);
  const fromEmail = clean(env.RESEND_FROM_EMAIL);
  const fromName = clean(env.RESEND_FROM_NAME) || "Dnols";
  if (!apiKey || !fromEmail) {
    return {
      ok: false,
      statusCode: 503,
      error: "resend_not_configured",
      message: "Email verification is not configured."
    };
  }

  cleanupExpired(now);
  const code = String(randomInt(100000, 1000000));
  const token = randomBytes(24).toString("hex");
  const expiresAt = now + ttlMs;
  const appPublicUrl = clean(env.APP_PUBLIC_URL).replace(/\/+$/, "");
  const verificationUrl = appPublicUrl
    ? `${appPublicUrl}/login.html?verifyEmail=${encodeURIComponent(validation.email)}&token=${encodeURIComponent(token)}`
    : "";

  const payload = {
    from: `${fromName} <${fromEmail}>`,
    to: [validation.email],
    subject: "Verify your Dnols business email",
    text: buildTextEmail({ code, verificationUrl }),
    html: buildHtmlEmail({ code, verificationUrl })
  };

  const response = await fetchImpl(clean(env.RESEND_API_URL) || DEFAULT_RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    return {
      ok: false,
      statusCode: 502,
      error: "resend_send_failed",
      message: "Verification email could not be sent."
    };
  }

  verificationStore.set(validation.email, {
    code,
    token,
    domain: validation.domain,
    expiresAt,
    createdAt: now
  });

  return {
    ok: true,
    statusCode: 200,
    email: validation.email,
    domain: validation.domain,
    expiresAt,
    message: "Verification email sent."
  };
}

function buildTextEmail({ code, verificationUrl }) {
  return [
    "Verify your Dnols business email.",
    "",
    `Code: ${code}`,
    verificationUrl ? `Verification link: ${verificationUrl}` : "",
    "",
    "This code expires in 15 minutes."
  ]
    .filter(Boolean)
    .join("\n");
}

function buildHtmlEmail({ code, verificationUrl }) {
  const link = verificationUrl
    ? `<p><a href="${escapeHtml(verificationUrl)}">Verify this email</a></p>`
    : "";
  return `
    <p>Verify your Dnols business email.</p>
    <p><strong>${escapeHtml(code)}</strong></p>
    ${link}
    <p>This code expires in 15 minutes.</p>
  `;
}

function cleanupExpired(now) {
  for (const [email, record] of verificationStore.entries()) {
    if (record.expiresAt <= now) verificationStore.delete(email);
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
