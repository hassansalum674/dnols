import test from "node:test";
import assert from "node:assert/strict";
import { REPLY_INTENT, parseSmsReply } from "../../src/services/sms-replies.js";

test("classifies English and Swahili approval replies", () => {
  for (const text of ["NDIYO", "ndiyo", "Sawa", "Kubali", "Yes", "Ok proceed", "Fanya", "sawa fanya hiyo"]) {
    assert.equal(parseSmsReply(text).intent, REPLY_INTENT.APPROVE, text);
  }
});

test("classifies English and Swahili decline replies", () => {
  for (const text of ["HAPANA", "hapana", "No", "Reject", "Usiende"]) {
    assert.equal(parseSmsReply(text).intent, REPLY_INTENT.DECLINE, text);
  }
});

test("classifies counter offer language and preserves text", () => {
  for (const text of ["Bei ni ndogo sana", "Too expensive", "Can we do $1,500?", "Niongeze bei"]) {
    const reply = parseSmsReply(text);
    assert.equal(reply.intent, REPLY_INTENT.COUNTER, text);
    assert.equal(reply.message, text);
  }
});
