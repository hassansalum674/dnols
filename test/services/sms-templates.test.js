import test from "node:test";
import assert from "node:assert/strict";
import {
  SMS_MAX_LENGTH,
  SMS_TYPE,
  feeAmount,
  renderSmsTemplate,
  sanitizeSmsText
} from "../../src/services/sms-templates.js";
import { FOUNDER_SMS_TYPE, renderFounderNotification } from "../../src/services/sms-notifier.js";

const ASCII_ONLY = /^[\x20-\x7E\n]*$/;

const sampleData = {
  buyerName: "Acme Buyer",
  sellerName: "Orbit Logistics",
  businessName: "Orbit Logistics",
  serviceDescription: "Freight Dar to Nairobi",
  amount: 1500,
  newAmount: 1800,
  newTerms: "Pay 50 percent upfront",
  deadline: "2026-07-30",
  dealId: "DL-10293",
  payNumber: "+254700000001"
};

test("every SMS template renders plain ASCII under 160 characters", () => {
  for (const type of Object.values(SMS_TYPE)) {
    const message = renderSmsTemplate(type, sampleData);
    assert.ok(message.length <= SMS_MAX_LENGTH, `${type} length ${message.length} exceeds ${SMS_MAX_LENGTH}`);
    assert.match(message, ASCII_ONLY, `${type} contains non-ASCII characters`);
    assert.match(message, /^DNOLS:/, `${type} must start with the DNOLS sender prefix`);
  }
});

test("templates stay under 160 even with very long inputs", () => {
  const longData = {
    buyerName: "A".repeat(120),
    sellerName: "B".repeat(120),
    businessName: "C".repeat(120),
    serviceDescription: "D".repeat(200),
    newTerms: "E".repeat(200),
    amount: 999999999,
    newAmount: 999999999,
    deadline: "F".repeat(80),
    dealId: "G".repeat(80),
    payNumber: "H".repeat(80)
  };
  for (const type of Object.values(SMS_TYPE)) {
    const message = renderSmsTemplate(type, longData);
    assert.ok(message.length <= SMS_MAX_LENGTH, `${type} length ${message.length} exceeds ${SMS_MAX_LENGTH}`);
  }
});

test("founder admin templates render management summaries under SMS length", () => {
  const deal = {
    dealId: "DNL-2024-0047",
    status: "initiated",
    buyer: { name: "ProTender", phone: "+255734000000" },
    seller: { name: "Orbit Logistics", phone: "+255712000000" },
    amount: 880
  };

  for (const type of Object.values(FOUNDER_SMS_TYPE)) {
    const message = renderFounderNotification(deal, type, { now: new Date("2026-06-14T09:12:00.000Z") });
    assert.ok(message.length <= SMS_MAX_LENGTH, `${type} length ${message.length} exceeds ${SMS_MAX_LENGTH}`);
    assert.match(message, ASCII_ONLY, `${type} contains non-ASCII characters`);
    assert.match(message, /^DNOLS ADMIN:/);
  }

  assert.match(renderFounderNotification(deal, FOUNDER_SMS_TYPE.NEW_DEAL), /Buyer: ProTender/);
  assert.match(renderFounderNotification(deal, FOUNDER_SMS_TYPE.DEAL_CLOSED), /Fee due: \$17\.60 \(x2\)/);
  assert.match(renderFounderNotification(deal, FOUNDER_SMS_TYPE.FEE_UNPAID), /Fee: \$8\.80/);
});

test("sanitizer strips emoji and normalizes smart punctuation", () => {
  const dirty = "DNOLS: deal \uD83D\uDE00 \u201Cquote\u201D \u2014 done\u2026";
  const clean = sanitizeSmsText(dirty);
  assert.match(clean, ASCII_ONLY);
  assert.ok(clean.includes('"quote"'));
  assert.ok(clean.includes("-"));
  assert.ok(clean.includes("..."));
  assert.ok(!clean.includes("\uD83D"));
});

test("new deal request keeps key fields and reply instructions", () => {
  const message = renderSmsTemplate(SMS_TYPE.NEW_DEAL_REQUEST, sampleData);
  assert.match(message, /New deal request/);
  assert.match(message, /Reply YES, NO or COUNTER/);
  assert.match(message, /Ref: DL-10293/);
  assert.match(message, /Amount: \$1500/);
});

test("fee invoice computes a 1 percent fee by default", () => {
  assert.equal(feeAmount({ amount: 1500 }), 15);
  assert.equal(feeAmount({ amount: 250 }), 2.5);
  assert.equal(feeAmount({ amount: 0 }), 0);
  assert.equal(feeAmount({ amount: 1500, feeAmount: 20 }), 20);

  const message = renderSmsTemplate(SMS_TYPE.FEE_INVOICE_BUYER, sampleData);
  assert.match(message, /Fee: \$15 \(1%\)/);
  assert.match(message, /M-Pesa/);
});

test("not understood reply lists the valid keywords", () => {
  const message = renderSmsTemplate(SMS_TYPE.NOT_UNDERSTOOD, { dealId: "DL-1" });
  assert.match(message, /Not understood/);
  assert.match(message, /YES, NO, COUNTER, PAID/);
  assert.match(message, /dnols\.app\/help\/DL-1/);
});

test("unknown template type throws", () => {
  assert.throws(() => renderSmsTemplate("nope", {}), /Unknown SMS template/);
});
