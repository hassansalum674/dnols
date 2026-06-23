import test from "node:test";
import assert from "node:assert/strict";
import {
  EAST_AFRICAN_COUNTRIES,
  normalizeEastAfricaPhone
} from "../../public/js/phone.js";

test("East African country list includes supported onboarding countries", () => {
  const codes = EAST_AFRICAN_COUNTRIES.map((country) => country.countryCode);

  assert.deepEqual(codes, ["254", "255", "256", "250", "257", "251", "211", "252", "243"]);
});

test("phone normalization accepts plus-prefixed East African numbers", () => {
  const result = normalizeEastAfricaPhone("+254 712 345 678");

  assert.equal(result.valid, true);
  assert.equal(result.phone, "+254712345678");
  assert.equal(result.country, "Kenya");
});

test("phone normalization accepts bare country code numbers", () => {
  const result = normalizeEastAfricaPhone("255712345678");

  assert.equal(result.valid, true);
  assert.equal(result.phone, "+255712345678");
  assert.equal(result.country, "Tanzania");
});

test("phone normalization uses selected country for local numbers", () => {
  const result = normalizeEastAfricaPhone("0712345678", { countryCode: "256" });

  assert.equal(result.valid, true);
  assert.equal(result.phone, "+256712345678");
  assert.equal(result.country, "Uganda");
});

test("phone normalization rejects obvious invalid or unsupported numbers", () => {
  assert.equal(normalizeEastAfricaPhone("").valid, false);
  assert.equal(normalizeEastAfricaPhone("+11234567890").valid, false);
  assert.equal(normalizeEastAfricaPhone("254").valid, false);
});
