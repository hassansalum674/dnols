import { DEAL_EVENT } from "./deal-flow.js";
import { sendDealEvent } from "./sms-notifier.js";

export const DEFAULT_REMINDER_WINDOW_MS = 2 * 60 * 60 * 1000;

const AWAITING_RESPONSE_STATUSES = new Set([
  "initiated",
  "approved",
  "negotiating",
  "payment_sent"
]);

export function selectDealsNeedingReminder(deals = [], now = new Date(), { windowMs = DEFAULT_REMINDER_WINDOW_MS } = {}) {
  const nowMs = toTime(now);
  return deals.filter((deal) => {
    if (!AWAITING_RESPONSE_STATUSES.has(clean(deal.status))) return false;
    if (deal.remindedAt) return false;
    const lastNotifiedMs = toTime(deal.lastNotifiedAt);
    return Number.isFinite(lastNotifiedMs) && nowMs - lastNotifiedMs >= windowMs;
  });
}

export async function runDealReminders({
  store,
  env = process.env,
  fetchImpl = globalThis.fetch,
  smsService,
  now = () => new Date(),
  windowMs = DEFAULT_REMINDER_WINDOW_MS
} = {}) {
  if (!store) throw new Error("Deal reminder store is required.");
  const timestamp = now();
  const dueDeals = selectDealsNeedingReminder(await store.listActiveDeals(), timestamp, { windowMs });
  const results = [];

  for (const deal of dueDeals) {
    const result = await sendDealEvent({
      deal,
      event: DEAL_EVENT.REMINDER,
      store,
      env,
      fetchImpl,
      smsService,
      now: () => timestamp
    });
    const remindedAt = timestamp.toISOString();
    const updatedDeal = await store.updateDeal(deal.dealId, { remindedAt, lastNotifiedAt: remindedAt });
    results.push({ ...result, deal: updatedDeal || result.deal });
  }

  return {
    scanned: dueDeals.length,
    reminded: results.length,
    results
  };
}

export function startDealReminderInterval({
  store,
  env = process.env,
  intervalMs = Number(env.SMS_REMINDER_INTERVAL_MS || 15 * 60 * 1000),
  now = () => new Date()
} = {}) {
  if (!/^(1|true|yes)$/i.test(String(env.SMS_REMINDER_INTERVAL_ENABLED || ""))) return null;
  const timer = setInterval(() => {
    runDealReminders({ store, env, now }).catch((error) => {
      console.error("SMS reminder runner failed", error);
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
}

function clean(value) {
  return String(value ?? "").trim().toLowerCase();
}

function toTime(value) {
  if (value instanceof Date) return value.getTime();
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? time : NaN;
}
