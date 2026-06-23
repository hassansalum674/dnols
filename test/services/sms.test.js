import test from "node:test";
import assert from "node:assert/strict";
import {
  createSmsService,
  getAfricaTalkingConfig,
  normalizePhoneNumber,
  sendSms
} from "../../src/services/sms.js";

test("SMS service normalizes E.164-ish phone numbers", () => {
  assert.deepEqual(normalizePhoneNumber(" +255 712-345-678 "), {
    valid: true,
    phone: "+255712345678"
  });
  assert.deepEqual(normalizePhoneNumber("00255712345678"), {
    valid: true,
    phone: "+255712345678"
  });

  const invalid = normalizePhoneNumber("0712345678");
  assert.equal(invalid.valid, false);
  assert.equal(invalid.error, "invalid_phone");
});

test("SMS service returns deterministic no-op when Africa's Talking env is missing", async () => {
  let fetchCalled = false;
  const sms = createSmsService({
    env: {},
    fetchImpl: async () => {
      fetchCalled = true;
      return { ok: true };
    }
  });

  const result = await sms.sendSms({
    to: "+255712345678",
    message: "Dnols verification code: 123456"
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.ok, true);
  assert.equal(result.delivered, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "sms_service_not_configured");
  assert.equal(result.provider, "africas-talking");
  assert.equal(result.to, "+255712345678");
});

test("SMS service sends sandbox Africa's Talking request with mocked transport", async () => {
  let requestUrl;
  let requestOptions;
  const result = await sendSms({
    to: "+255712345678",
    message: "Your Dnols code is 123456.",
    env: {
      AT_API_KEY: "test-at-key",
      AT_USERNAME: "sandbox",
      AT_SENDER_ID: "DNOLS",
      AT_ENV: "sandbox"
    },
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestOptions = options;
      assert.ok(options.signal instanceof AbortSignal);
      return {
        ok: true,
        async json() {
          return {
            SMSMessageData: {
              Recipients: [
                {
                  number: "+255712345678",
                  status: "Success",
                  statusCode: 101,
                  messageId: "ATXid_test",
                  cost: "KES 0.8000"
                }
              ]
            }
          };
        }
      };
    }
  });

  assert.equal(requestUrl, "https://api.sandbox.africastalking.com/version1/messaging");
  assert.equal(requestOptions.method, "POST");
  assert.equal(requestOptions.headers.apiKey, "test-at-key");
  assert.equal(requestOptions.headers["Content-Type"], "application/x-www-form-urlencoded");

  const body = Object.fromEntries(requestOptions.body.entries());
  assert.deepEqual(body, {
    username: "sandbox",
    to: "+255712345678",
    message: "Your Dnols code is 123456.",
    from: "DNOLS"
  });

  assert.equal(result.ok, true);
  assert.equal(result.delivered, true);
  assert.equal(result.environment, "sandbox");
  assert.deepEqual(result.recipients, [
    {
      number: "+255712345678",
      status: "Success",
      statusCode: 101,
      messageId: "ATXid_test",
      cost: "KES 0.8000"
    }
  ]);
});

test("SMS service selects production endpoint from AT_ENV", () => {
  const config = getAfricaTalkingConfig({
    AT_API_KEY: "test-at-key",
    AT_USERNAME: "dnols",
    AT_ENV: "production"
  });

  assert.equal(config.configured, true);
  assert.equal(config.environment, "production");
  assert.equal(config.endpoint, "https://api.africastalking.com/version1/messaging");
});
