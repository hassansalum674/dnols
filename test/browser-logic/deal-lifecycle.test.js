import test from "node:test";
import assert from "node:assert/strict";
import {
  DEAL_ROOM_MESSAGE_KIND,
  DEAL_ROOM_STATUS,
  DEAL_STATUS,
  REJECTION_REASON_CATEGORY,
  TRUST_SCORE_EVENT,
  applyOrderConfirmation,
  applyTrustScoreChange,
  buildDealRoomMessage,
  createDealRoom,
  dealStatusText,
  evaluateBypassSuspicion,
  normalizeRejectionReason,
  openOrderDispute,
  summarizeDealRoom,
  updateDealRoomAfterMessage
} from "../../public/system-logic.js";

test("order confirmations wait for both buyer and seller", () => {
  const order = {
    id: "order-a",
    status: DEAL_STATUS.APPROVED,
    confirmations: {
      buyerPaid: false,
      sellerReceived: false
    }
  };

  const buyerPaid = applyOrderConfirmation(order, "buyer_paid", "2026-06-23T07:00:00.000Z");
  assert.equal(buyerPaid.status, DEAL_STATUS.PAYMENT_SENT);
  assert.equal(dealStatusText({ ...order, ...buyerPaid }), "awaiting seller confirmation");
  assert.deepEqual(buyerPaid.auditEvents, ["payment_sent"]);

  const sellerReceived = applyOrderConfirmation({ ...order, ...buyerPaid }, "seller_received", "2026-06-23T08:00:00.000Z");
  assert.equal(sellerReceived.status, DEAL_STATUS.COMPLETE);
  assert.equal(sellerReceived.trustScoreEvent, TRUST_SCORE_EVENT.CONFIRMED);
  assert.deepEqual(sellerReceived.auditEvents, ["delivered", "complete"]);
});

test("seller-only confirmation waits for buyer", () => {
  const sellerReceived = applyOrderConfirmation(
    {
      id: "order-b",
      status: DEAL_STATUS.APPROVED,
      confirmations: {
        buyerPaid: false,
        sellerReceived: false
      }
    },
    "seller_received",
    "2026-06-23T08:00:00.000Z"
  );

  assert.equal(sellerReceived.status, DEAL_STATUS.DELIVERED);
  assert.equal(dealStatusText({ ...sellerReceived }), "awaiting buyer confirmation");
});

test("rejection reason and trust deltas are explicit", () => {
  const rejection = normalizeRejectionReason({
    category: REJECTION_REASON_CATEGORY.FOUND_BETTER_OPTION_ELSEWHERE,
    note: "Buyer chose another provider."
  });

  assert.equal(rejection.status, DEAL_STATUS.REJECTED);
  assert.equal(rejection.category, REJECTION_REASON_CATEGORY.FOUND_BETTER_OPTION_ELSEWHERE);
  assert.equal(rejection.trustScoreDelta, -1);
  assert.equal(applyTrustScoreChange(50, TRUST_SCORE_EVENT.REJECTED_WITH_REASON).nextScore, 49);
  assert.equal(applyTrustScoreChange(50, TRUST_SCORE_EVENT.REJECTED_NO_REASON).nextScore, 47);
  assert.throws(() => normalizeRejectionReason({ note: "No category" }), /valid rejection reason category/);
});

test("bypass suspicion uses repeated rejection category and overdue confirmations", () => {
  const suspicion = evaluateBypassSuspicion({
    now: "2026-06-23T08:00:00.000Z",
    approvals: [
      {
        decision: DEAL_STATUS.REJECTED,
        rejectionReason: { category: REJECTION_REASON_CATEGORY.FOUND_BETTER_OPTION_ELSEWHERE }
      },
      {
        decision: DEAL_STATUS.REJECTED,
        reasonCategory: REJECTION_REASON_CATEGORY.FOUND_BETTER_OPTION_ELSEWHERE
      }
    ],
    orders: [
      {
        id: "order-overdue",
        status: DEAL_STATUS.PAYMENT_SENT,
        deadline: "2026-06-01",
        confirmations: {
          buyerPaid: true,
          sellerReceived: false
        }
      }
    ]
  });

  assert.equal(suspicion.suspected, true);
  assert.deepEqual(suspicion.reasons, ["repeated_found_better_option_rejections", "overdue_unconfirmed_deals"]);
  assert.deepEqual(suspicion.overdueOrderIds, ["order-overdue"]);
});

test("disputes create private trust signal without public punishment", () => {
  const dispute = openOrderDispute({ id: "order-c", status: DEAL_STATUS.DELIVERED }, "2026-06-23T09:00:00.000Z");

  assert.equal(dispute.status, DEAL_STATUS.DISPUTED);
  assert.equal(dispute.trustScoreEvent, TRUST_SCORE_EVENT.DISPUTE_RAISED);
  assert.deepEqual(dispute.auditEvents, ["dispute_opened"]);
  assert.equal(applyTrustScoreChange(50, dispute.trustScoreEvent).nextScore, 42);
});

test("deal rooms start with proof timeline and safe agreed terms", () => {
  const room = createDealRoom(
    {
      id: "order-room",
      title: "Freight deal",
      budgetAmount: 880,
      currency: "USD",
      deadline: "2026-07-01"
    },
    { partnerName: "Orbit Logistics" },
    "2026-06-23T09:00:00.000Z"
  );

  assert.equal(room.status, DEAL_ROOM_STATUS.OPEN);
  assert.equal(room.partnerName, "Orbit Logistics");
  assert.equal(room.agreedTerms.price, 880);
  assert.equal(room.timeline.length, 3);
  assert.equal(room.timeline[0].kind, DEAL_ROOM_MESSAGE_KIND.AGENT_TERM);
});

test("deal room messages keep routing fields for future webhooks", () => {
  const message = buildDealRoomMessage(
    {
      orderId: "order-room",
      roomId: "room-order-room",
      ownerUid: "owner-123",
      senderName: "ProTender",
      recipientName: "Orbit Logistics",
      body: "Pickup address is Kariakoo Warehouse Gate 3",
      channel: "dashboard"
    },
    "2026-06-23T09:05:00.000Z"
  );

  assert.equal(message.kind, DEAL_ROOM_MESSAGE_KIND.MESSAGE);
  assert.equal(message.route.command, "MSG");
  assert.equal(message.recipientRole, "partner");
  assert.deepEqual(message.sender, { uid: "owner-123", role: "owner", name: "ProTender" });
  assert.deepEqual(message.recipient, { role: "partner", name: "Orbit Logistics" });
  assert.equal(message.createdAtClient, "2026-06-23T09:05:00.000Z");
});

test("message updates room summary without exposing unrelated data", () => {
  const room = createDealRoom({ id: "order-room", title: "Freight deal" });
  const message = buildDealRoomMessage({
    orderId: "order-room",
    roomId: room.roomId,
    senderName: "ProTender",
    body: "Delivery contact is David at the warehouse."
  });
  const updatedRoom = updateDealRoomAfterMessage(room, message);
  const summary = summarizeDealRoom(updatedRoom, [message]);

  assert.equal(summary.messageCount, 1);
  assert.equal(summary.lastMessagePreview, "Delivery contact is David at the warehouse.");
  assert.equal(updatedRoom.timeline.at(-1).kind, DEAL_ROOM_MESSAGE_KIND.MESSAGE);
});

test("confirmations append deal room timeline", () => {
  const order = {
    id: "order-room",
    status: DEAL_STATUS.APPROVED,
    dealRoom: createDealRoom({ id: "order-room", title: "Freight deal" }),
    confirmations: {
      buyerPaid: false,
      sellerReceived: false
    }
  };
  const transition = applyOrderConfirmation(order, "buyer_paid", "2026-06-23T10:00:00.000Z");

  assert.equal(transition.status, DEAL_STATUS.PAYMENT_SENT);
  assert.equal(transition.dealRoom.timeline.at(-1).label, "Buyer marked payment sent");
  assert.equal(transition.dealRoom.timeline.at(-1).kind, DEAL_ROOM_MESSAGE_KIND.DELIVERY);
});
