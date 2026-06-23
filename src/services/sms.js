const DEFAULT_TIMEOUT_MS = 5000;
const MAX_SMS_LENGTH = 1600;
const AFRICAS_TALKING_ENDPOINTS = {
  production: "https://api.africastalking.com/version1/messaging",
  sandbox: "https://api.sandbox.africastalking.com/version1/messaging"
};

export function normalizePhoneNumber(value) {
  const phone = String(value ?? "")
    .trim()
    .replace(/[\s().-]+/g, "");
  const normalized = phone.startsWith("00") ? `+${phone.slice(2)}` : phone;

  if (!normalized) {
    return { valid: false, phone: "", error: "phone_required", message: "Phone number is required." };
  }
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    return {
      valid: false,
      phone: normalized,
      error: "invalid_phone",
      message: "Use an international phone number like +255..."
    };
  }

  return { valid: true, phone: normalized };
}

export function createSmsService({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  return {
    normalizePhoneNumber,
    async sendSms(input = {}) {
      return sendSms({
        ...input,
        env,
        fetchImpl,
        timeoutMs
      });
    }
  };
}

export async function sendSms({
  to,
  message,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const phone = normalizePhoneNumber(to);
  if (!phone.valid) {
    return failure(400, phone.error, phone.message, { to: phone.phone });
  }

  const text = String(message ?? "").trim();
  if (!text) {
    return failure(400, "message_required", "SMS message is required.", { to: phone.phone });
  }
  if (text.length > MAX_SMS_LENGTH) {
    return failure(400, "message_too_long", "SMS message is too long.", { to: phone.phone });
  }

  const config = getAfricaTalkingConfig(env);
  if (!config.configured || typeof fetchImpl !== "function" || env.NODE_ENV === "test") {
    return {
      ok: true,
      delivered: false,
      skipped: true,
      provider: "africas-talking",
      environment: config.environment,
      to: phone.phone,
      reason: config.configured ? "sms_delivery_disabled_in_test" : "sms_service_not_configured"
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = new URLSearchParams({
      username: config.username,
      to: phone.phone,
      message: text
    });
    if (config.senderId) body.set("from", config.senderId);

    const response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey: config.apiKey
      },
      body,
      signal: controller.signal
    });
    const payload = await readJsonSafe(response);

    if (!response.ok) {
      return failure(502, "sms_delivery_failed", "SMS could not be sent.", {
        provider: "africas-talking",
        environment: config.environment,
        to: phone.phone,
        providerStatus: response.status
      });
    }

    return {
      ok: true,
      delivered: true,
      skipped: false,
      provider: "africas-talking",
      environment: config.environment,
      to: phone.phone,
      recipients: summarizeAfricaTalkingRecipients(payload)
    };
  } catch {
    return failure(502, "sms_delivery_failed", "SMS could not be sent.", {
      provider: "africas-talking",
      environment: config.environment,
      to: phone.phone
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function getAfricaTalkingConfig(env = process.env) {
  const environment = normalizeAfricaTalkingEnvironment(env.AT_ENV);
  const apiKey = String(env.AT_API_KEY || "");
  const username = String(env.AT_USERNAME || "");
  const senderId = String(env.AT_SENDER_ID || "").trim();

  return {
    configured: Boolean(apiKey && username),
    environment,
    endpoint: AFRICAS_TALKING_ENDPOINTS[environment],
    username,
    apiKey,
    senderId
  };
}

function normalizeAfricaTalkingEnvironment(value) {
  const normalized = String(value || "sandbox").trim().toLowerCase();
  return normalized === "production" || normalized === "prod" ? "production" : "sandbox";
}

async function readJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function summarizeAfricaTalkingRecipients(payload = {}) {
  const recipients = payload.SMSMessageData?.Recipients;
  if (!Array.isArray(recipients)) return [];

  return recipients.map((recipient) => ({
    number: String(recipient.number || ""),
    status: String(recipient.status || ""),
    statusCode: Number(recipient.statusCode || 0),
    messageId: String(recipient.messageId || ""),
    cost: String(recipient.cost || "")
  }));
}

function failure(statusCode, error, message, extra = {}) {
  return {
    ok: false,
    statusCode,
    error,
    message,
    ...extra
  };
}
