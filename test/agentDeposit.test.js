/**
 * Agent Deposit System — integration tests over the REAL route + services
 * against a throwaway local MongoDB database. Skipped automatically when no
 * local Mongo is reachable.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || "agent-deposit-test-secret";
process.env.ALLOW_NON_TRANSACTION_FALLBACK = "true";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");

const MONGO_URI = `mongodb://127.0.0.1:27017/agent_deposit_test_${process.pid}`;

let mongoAvailable = false;
let server;
let base;

const createToken = require("../utils/createToken");
const globalError = require("../middlewares/errorMiddleware");

let User;
let AgentProfile;
let DepositTicket;
let Wallet;
let ledger;

const users = {}; // name -> { doc, token }

async function makeUser(name, role = "user") {
  const doc = await User.create({
    name,
    email: `${name}@test.local`,
    password: "secret123",
    role,
  });
  return { doc, token: createToken(doc._id, doc.sessionVersion) };
}

async function api(method, path, token, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    json = null;
  }
  return { status: res.status, body: json };
}

async function balanceOf(userId) {
  const wallet = await ledger.getOrCreateWallet(userId, null);
  return wallet.balance;
}

before(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 2500 });
    mongoAvailable = true;
  } catch (_) {
    mongoAvailable = false;
    return;
  }

  User = require("../models/userModel");
  AgentProfile = require("../models/agentProfileModel");
  DepositTicket = require("../models/depositTicketModel");
  Wallet = require("../models/walletModel");
  ledger = require("../services/walletLedgerService");
  const agentDepositRoute = require("../routes/agentDepositRoute");

  const app = express();
  app.use(express.json());
  app.set("trust proxy", true);
  app.use("/api/v1/agent-deposits", agentDepositRoute);
  app.use(globalError);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  users.customer = await makeUser("customer");
  users.agent = await makeUser("agentuser");
  users.stranger = await makeUser("stranger");
  users.admin = await makeUser("adminuser", "admin");

  await AgentProfile.create({
    user: users.agent.doc._id,
    roleType: "agent",
    referralCode: AgentProfile.generateReferralCode(),
    status: "approved",
    deposit: {
      enabled: true,
      displayName: "صرافة الشام",
      countries: ["SY"],
      paymentMethods: ["حوالة", "كاش"],
      workingHours: "10:00 - 22:00",
    },
  });

  // seed the agent wallet
  await ledger.ledgerDeposit({
    session: null,
    userId: users.agent.doc._id,
    amount: 1000000,
    ledgerType: "admin_agent_credit",
    meta: { seed: true },
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoAvailable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

function guarded(name, fn) {
  test(name, async (t) => {
    if (!mongoAvailable) {
      t.skip("no local MongoDB");
      return;
    }
    await fn(t);
  });
}

guarded("countries list only includes countries with active agents", async () => {
  const res = await api("GET", "/api/v1/agent-deposits/countries", users.customer.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].code, "SY");
  assert.equal(res.body.data[0].agents, 1);
});

guarded("agents listed per country with card fields", async () => {
  const res = await api(
    "GET",
    "/api/v1/agent-deposits/countries/SY/agents",
    users.customer.token
  );
  assert.equal(res.status, 200);
  const card = res.body.data[0];
  assert.equal(card.name, "صرافة الشام");
  assert.deepEqual(card.paymentMethods, ["حوالة", "كاش"]);
  assert.equal(card.online, false);
  assert.ok(card.agentProfileId);
});

let ticketId;

guarded("full lifecycle: create → accept → chat → approve moves money atomically", async () => {
  const agents = await api(
    "GET",
    "/api/v1/agent-deposits/countries/SY/agents",
    users.customer.token
  );
  const agentProfileId = agents.body.data[0].agentProfileId;

  // create
  const created = await api("POST", "/api/v1/agent-deposits/tickets", users.customer.token, {
    agentProfileId,
    amount: 5000,
    paymentMethod: "حوالة",
    currency: "SYP",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.status, "pending");
  ticketId = created.body.data.id;

  // duplicate active ticket with same agent is rejected
  const dup = await api("POST", "/api/v1/agent-deposits/tickets", users.customer.token, {
    agentProfileId,
    amount: 100,
  });
  assert.equal(dup.status, 400);

  // stranger cannot read the chat
  const strangerRead = await api(
    "GET",
    `/api/v1/agent-deposits/tickets/${ticketId}/messages`,
    users.stranger.token
  );
  assert.equal(strangerRead.status, 403);

  // non-agent cannot use agent endpoints
  const notAgent = await api(
    "POST",
    `/api/v1/agent-deposits/agent/tickets/${ticketId}/accept`,
    users.customer.token
  );
  assert.equal(notAgent.status, 403);

  // accept
  const accepted = await api(
    "POST",
    `/api/v1/agent-deposits/agent/tickets/${ticketId}/accept`,
    users.agent.token
  );
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.data.status, "accepted");

  // chat both ways; agent message advances status to waiting_payment
  const userMsg = await api(
    "POST",
    `/api/v1/agent-deposits/tickets/${ticketId}/messages`,
    users.customer.token,
    { body: "مرحبا، جاهز للدفع" }
  );
  assert.equal(userMsg.status, 201);
  const agentMsg = await api(
    "POST",
    `/api/v1/agent-deposits/tickets/${ticketId}/messages`,
    users.agent.token,
    { body: "أرسل على الرقم 0999" }
  );
  assert.equal(agentMsg.status, 201);
  assert.equal(agentMsg.body.data.senderRole, "agent");

  const afterChat = await api(
    "GET",
    `/api/v1/agent-deposits/tickets/${ticketId}`,
    users.customer.token
  );
  assert.equal(afterChat.body.data.status, "waiting_payment");

  // approve — atomic transfer
  const agentBefore = await balanceOf(users.agent.doc._id);
  const customerBefore = await balanceOf(users.customer.doc._id);

  const approved = await api(
    "POST",
    `/api/v1/agent-deposits/agent/tickets/${ticketId}/approve`,
    users.agent.token,
    { amount: 5000 }
  );
  assert.equal(approved.status, 200);
  assert.equal(approved.body.data.status, "completed");
  assert.equal(approved.body.data.amountApproved, 5000);

  assert.equal(await balanceOf(users.agent.doc._id), agentBefore - 5000);
  assert.equal(await balanceOf(users.customer.doc._id), customerBefore + 5000);

  // double approval rejected
  const again = await api(
    "POST",
    `/api/v1/agent-deposits/agent/tickets/${ticketId}/approve`,
    users.agent.token,
    { amount: 5000 }
  );
  assert.equal(again.status, 409);
  assert.equal(await balanceOf(users.agent.doc._id), agentBefore - 5000);
});

guarded("insufficient agent balance → 402 and ticket status restored", async () => {
  const agents = await api(
    "GET",
    "/api/v1/agent-deposits/countries/SY/agents",
    users.customer.token
  );
  const agentProfileId = agents.body.data[0].agentProfileId;

  const created = await api("POST", "/api/v1/agent-deposits/tickets", users.customer.token, {
    agentProfileId,
    amount: 999999999,
  });
  assert.equal(created.status, 201);
  const id = created.body.data.id;

  await api(
    "POST",
    `/api/v1/agent-deposits/agent/tickets/${id}/accept`,
    users.agent.token
  );

  const customerBefore = await balanceOf(users.customer.doc._id);
  const approved = await api(
    "POST",
    `/api/v1/agent-deposits/agent/tickets/${id}/approve`,
    users.agent.token,
    { amount: 999999999 }
  );
  assert.equal(approved.status, 402);
  assert.equal(await balanceOf(users.customer.doc._id), customerBefore);

  const ticket = await DepositTicket.findById(id).lean();
  assert.equal(ticket.status, "accepted"); // restored, agent can retry/reject

  // clean up: reject it
  const rejected = await api(
    "POST",
    `/api/v1/agent-deposits/agent/tickets/${id}/reject`,
    users.agent.token,
    { reason: "مبلغ كبير جداً" }
  );
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.data.status, "rejected");
});

guarded("user can cancel a pending ticket; closed chat refuses messages", async () => {
  const agents = await api(
    "GET",
    "/api/v1/agent-deposits/countries/SY/agents",
    users.customer.token
  );
  const agentProfileId = agents.body.data[0].agentProfileId;

  const created = await api("POST", "/api/v1/agent-deposits/tickets", users.customer.token, {
    agentProfileId,
    amount: 700,
  });
  const id = created.body.data.id;

  const cancelled = await api(
    "POST",
    `/api/v1/agent-deposits/tickets/${id}/cancel`,
    users.customer.token,
    { reason: "غيرت رأيي" }
  );
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.status, "cancelled");

  const blocked = await api(
    "POST",
    `/api/v1/agent-deposits/tickets/${id}/messages`,
    users.customer.token,
    { body: "هل ما زلت هناك؟" }
  );
  assert.equal(blocked.status, 400);

  const cantAccept = await api(
    "POST",
    `/api/v1/agent-deposits/agent/tickets/${id}/accept`,
    users.agent.token
  );
  assert.equal(cantAccept.status, 400);
});

guarded("agent wallet summary aggregates deposit stats", async () => {
  const res = await api(
    "GET",
    "/api/v1/agent-deposits/agent/wallet",
    users.agent.token
  );
  assert.equal(res.status, 200);
  assert.ok(res.body.data.balance >= 0);
  assert.equal(res.body.data.lifetime.count, 1);
  assert.equal(res.body.data.lifetime.volume, 5000);
});

guarded("admin can create an agent from an existing email", async () => {
  const res = await api(
    "POST",
    "/api/v1/agent-deposits/admin/agents",
    users.admin.token,
    { email: "  Stranger@test.local ", countries: ["SA"], displayName: "غريب" }
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const profile = await AgentProfile.findOne({ user: users.stranger.doc._id });
  assert.ok(profile);
  assert.equal(profile.status, "approved");
  assert.equal(profile.deposit.enabled, true);
});

guarded("admin can recharge and withdraw the agent wallet", async () => {
  const profile = await AgentProfile.findOne({ user: users.agent.doc._id }).lean();
  const before = await balanceOf(users.agent.doc._id);

  const recharge = await api(
    "POST",
    `/api/v1/agent-deposits/admin/agents/${profile._id}/wallet/recharge`,
    users.admin.token,
    { amount: 20000 }
  );
  assert.equal(recharge.status, 200);
  assert.equal(recharge.body.data.balance, before + 20000);

  const withdraw = await api(
    "POST",
    `/api/v1/agent-deposits/admin/agents/${profile._id}/wallet/withdraw`,
    users.admin.token,
    { amount: 20000 }
  );
  assert.equal(withdraw.status, 200);
  assert.equal(withdraw.body.data.balance, before);

  // non-admin blocked
  const forbidden = await api(
    "POST",
    `/api/v1/agent-deposits/admin/agents/${profile._id}/wallet/recharge`,
    users.agent.token,
    { amount: 1 }
  );
  assert.equal(forbidden.status, 403);
});

guarded("admin statistics and ticket listing", async () => {
  const stats = await api(
    "GET",
    "/api/v1/agent-deposits/admin/statistics",
    users.admin.token
  );
  assert.equal(stats.status, 200);
  assert.equal(stats.body.data.completedCount, 1);
  assert.equal(stats.body.data.completedVolume, 5000);
  assert.equal(stats.body.data.activeAgents, 1);
  assert.ok(typeof stats.body.data.vipVolumeUsd === "number");

  const list = await api(
    "GET",
    "/api/v1/agent-deposits/admin/tickets?status=all",
    users.admin.token
  );
  assert.equal(list.status, 200);
  assert.ok(list.body.total >= 3);
});

guarded("admin dashboard sales APIs expose coin + VIP settlement fields", async () => {
  const overview = await api(
    "GET",
    "/api/v1/agent-deposits/admin/dashboard/overview",
    users.admin.token
  );
  assert.equal(overview.status, 200);
  assert.ok(overview.body.data.coins.salesCount >= 1);
  assert.ok(overview.body.data.coins.volume >= 5000);
  assert.ok(typeof overview.body.data.vip.activationsCount === "number");
  assert.ok(typeof overview.body.data.vip.volumeUsd === "number");

  const agentsDash = await api(
    "GET",
    "/api/v1/agent-deposits/admin/dashboard/agents",
    users.admin.token
  );
  assert.equal(agentsDash.status, 200);
  assert.ok(agentsDash.body.data.agents.length >= 1);
  const row = agentsDash.body.data.agents[0];
  assert.ok(row.agentProfileId);
  assert.ok(row.coins.volume >= 5000);
  assert.ok(typeof row.settlementUsd === "number");

  const detail = await api(
    "GET",
    `/api/v1/agent-deposits/admin/dashboard/agents/${row.agentProfileId}`,
    users.admin.token
  );
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.agent.agentProfileId, row.agentProfileId);
  assert.ok(detail.body.data.summary.coins.volume >= 5000);
  assert.ok(Array.isArray(detail.body.data.recentSales));

  const sales = await api(
    "GET",
    "/api/v1/agent-deposits/admin/dashboard/sales?ticketType=deposit&limit=20",
    users.admin.token
  );
  assert.equal(sales.status, 200);
  assert.ok(sales.body.data.length >= 1);
  assert.ok(sales.body.data.some((s) => s.coins >= 5000));

  // non-admin blocked
  const forbidden = await api(
    "GET",
    "/api/v1/agent-deposits/admin/dashboard/overview",
    users.agent.token
  );
  assert.equal(forbidden.status, 403);
});

// ── ratings ─────────────────────────────────────────────────────────────────
//
// A rating is a verdict on a transaction, so it hangs off a completed ticket
// rather than off the agent. That is what makes "rate an agent you never dealt
// with" and "rate the same deal twice to move their average" impossible by
// construction rather than by a check someone has to remember to write.

/** Drive one deposit all the way to `completed` and return its id. */
async function completedTicket(amount = 3000) {
  const agents = await api(
    "GET",
    "/api/v1/agent-deposits/countries/SY/agents",
    users.customer.token
  );
  const agentProfileId = agents.body.data[0].agentProfileId;

  const created = await api("POST", "/api/v1/agent-deposits/tickets", users.customer.token, {
    agentProfileId,
    amount,
    paymentMethod: "حوالة",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;

  await api("POST", `/api/v1/agent-deposits/agent/tickets/${id}/accept`, users.agent.token);
  const approved = await api(
    "POST",
    `/api/v1/agent-deposits/agent/tickets/${id}/approve`,
    users.agent.token,
    { amount }
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return { id, agentProfileId };
}

guarded("a completed deal can be rated once, and the average follows", async () => {
  const { id, agentProfileId } = await completedTicket();

  const before = await api(
    "GET",
    `/api/v1/agent-deposits/tickets/${id}/rating`,
    users.customer.token
  );
  assert.equal(before.status, 200);
  assert.equal(before.body.data, null, "nothing rated yet");

  const rated = await api(
    "POST",
    `/api/v1/agent-deposits/tickets/${id}/rate`,
    users.customer.token,
    { stars: 4, comment: "سريع ومحترم" }
  );
  assert.equal(rated.status, 201, JSON.stringify(rated.body));
  assert.equal(rated.body.data.rating, 4, "one 4-star rating averages to 4");
  assert.equal(rated.body.data.ratingCount, 1);

  const mine = await api(
    "GET",
    `/api/v1/agent-deposits/tickets/${id}/rating`,
    users.customer.token
  );
  assert.equal(mine.body.data.stars, 4);
  assert.equal(mine.body.data.comment, "سريع ومحترم");

  // The same deal cannot be rated again — this is the unique index, not a check.
  const twice = await api(
    "POST",
    `/api/v1/agent-deposits/tickets/${id}/rate`,
    users.customer.token,
    { stars: 1 }
  );
  assert.equal(twice.status, 409, "one verdict per deal");

  const list = await api(
    "GET",
    `/api/v1/agent-deposits/agents/${agentProfileId}/ratings`,
    users.customer.token
  );
  assert.equal(list.status, 200);
  assert.equal(list.body.data.ratingCount, 1);
  assert.equal(list.body.data.reviews[0].stars, 4);
  assert.equal(list.body.data.reviews[0].comment, "سريع ومحترم");
});

guarded("a second deal moves the average, and it is a real mean", async () => {
  const { id, agentProfileId } = await completedTicket(1500);

  const rated = await api(
    "POST",
    `/api/v1/agent-deposits/tickets/${id}/rate`,
    users.customer.token,
    { stars: 2 }
  );
  assert.equal(rated.status, 201);
  assert.equal(rated.body.data.ratingCount, 2);
  assert.equal(rated.body.data.rating, 3, "(4 + 2) / 2");

  const list = await api(
    "GET",
    `/api/v1/agent-deposits/agents/${agentProfileId}/ratings`,
    users.customer.token
  );
  assert.equal(list.body.data.reviews.length, 2, "newest first");
  assert.equal(list.body.data.reviews[0].stars, 2);
});

guarded("an unfinished deal cannot be rated", async () => {
  const agents = await api(
    "GET",
    "/api/v1/agent-deposits/countries/SY/agents",
    users.customer.token
  );
  const created = await api("POST", "/api/v1/agent-deposits/tickets", users.customer.token, {
    agentProfileId: agents.body.data[0].agentProfileId,
    amount: 700,
  });
  assert.equal(created.status, 201);

  const res = await api(
    "POST",
    `/api/v1/agent-deposits/tickets/${created.body.data.id}/rate`,
    users.customer.token,
    { stars: 5 }
  );
  assert.equal(res.status, 400, "no money moved, so there is nothing to judge");

  await api(
    "POST",
    `/api/v1/agent-deposits/tickets/${created.body.data.id}/cancel`,
    users.customer.token
  );
});

guarded("only the player who made the deal may rate it", async () => {
  const { id } = await completedTicket(900);

  const stranger = await api(
    "POST",
    `/api/v1/agent-deposits/tickets/${id}/rate`,
    users.stranger.token,
    { stars: 1 }
  );
  assert.equal(stranger.status, 404, "the ticket is not theirs to judge");

  const agentSelf = await api(
    "POST",
    `/api/v1/agent-deposits/tickets/${id}/rate`,
    users.agent.token,
    { stars: 5 }
  );
  assert.equal(agentSelf.status, 404, "an agent cannot rate themselves");
});

guarded("stars outside 1–5 are refused", async () => {
  const { id } = await completedTicket(800);
  for (const stars of [0, 6, -3, "abc", null]) {
    const res = await api(
      "POST",
      `/api/v1/agent-deposits/tickets/${id}/rate`,
      users.customer.token,
      { stars }
    );
    assert.equal(res.status, 400, `stars=${stars} should be refused`);
  }
});

guarded("the agent card carries the real rating, not a hardcoded 5", async () => {
  const res = await api(
    "GET",
    "/api/v1/agent-deposits/countries/SY/agents",
    users.customer.token
  );
  const card = res.body.data[0];
  assert.ok(card.ratingCount >= 2, "ratings were left above");
  assert.notEqual(card.rating, 5, "the seeded default must have been replaced");
  assert.equal(typeof card.avgResponseMinutes, "number");
});

// ── the agent's own sales log ───────────────────────────────────────────────
//
// The room already showed day/month/lifetime totals. An agent settling up needs
// the lines behind those numbers — the admin had them, the person who made the
// sales did not.

guarded("an agent can read their own itemised sales", async () => {
  const res = await api("GET", "/api/v1/agent-deposits/agent/sales", users.agent.token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.data.length > 0, "deals were completed earlier in this file");

  const line = res.body.data[0];
  assert.equal(typeof line.ticketId, "string");
  assert.ok(line.amount > 0, "a coin sale reports what was handed over");
  assert.equal(line.player.name, "customer");
  assert.ok(line.completedAt, "and when");

  // Newest first, so the log opens on what just happened.
  const times = res.body.data.map((r) => new Date(r.completedAt).getTime());
  const sorted = [...times].sort((a, b) => b - a);
  assert.deepEqual(times, sorted);
});

guarded("the sales log is the agent's own, and only theirs", async () => {
  const notAgent = await api(
    "GET",
    "/api/v1/agent-deposits/agent/sales",
    users.customer.token
  );
  assert.ok(
    notAgent.status === 403 || notAgent.status === 401,
    `a player must not read an agent's book, got ${notAgent.status}`
  );
});

guarded("the log pages backwards without repeating a sale", async () => {
  const first = await api(
    "GET",
    "/api/v1/agent-deposits/agent/sales?limit=1",
    users.agent.token
  );
  assert.equal(first.body.data.length, 1);

  const next = await api(
    "GET",
    `/api/v1/agent-deposits/agent/sales?limit=5&before=${encodeURIComponent(
      first.body.data[0].completedAt
    )}`,
    users.agent.token
  );
  const ids = next.body.data.map((r) => r.ticketId);
  assert.ok(
    !ids.includes(first.body.data[0].ticketId),
    "the cursor must not hand back the row it paged past"
  );
});

// ── handing coins over directly ─────────────────────────────────────────────
//
// The ticket flow exists because a deposit usually needs a conversation. A
// player standing in front of the agent needs none of it — but the money still
// has to move atomically and still has to be written down, or it is money that
// moved with no record anywhere a person looks.

guarded("a direct credit moves coins and is written down as a sale", async () => {
  const before = {
    agent: await balanceOf(users.agent.doc._id),
    player: await balanceOf(users.stranger.doc._id),
  };

  const res = await api(
    "POST",
    "/api/v1/agent-deposits/agent/direct-credit",
    users.agent.token,
    { playerId: String(users.stranger.doc._id), amount: 2500, note: "كاش" }
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.amount, 2500);
  assert.equal(res.body.data.player.name, "stranger");

  assert.equal(await balanceOf(users.agent.doc._id), before.agent - 2500);
  assert.equal(await balanceOf(users.stranger.doc._id), before.player + 2500);
  assert.equal(
    res.body.data.agentBalance,
    before.agent - 2500,
    "the response carries the agent's new balance so the UI need not refetch"
  );

  // It shows up as a sale, which is the whole reason it writes a ticket.
  const sales = await api("GET", "/api/v1/agent-deposits/agent/sales", users.agent.token);
  const line = sales.body.data.find((r) => r.ticketId === res.body.data.ticketId);
  assert.ok(line, "a direct credit must appear in the sales book");
  assert.equal(line.amount, 2500);
  assert.equal(line.player.name, "stranger");
});

guarded("a direct credit can be addressed by email instead of id", async () => {
  const before = await balanceOf(users.stranger.doc._id);
  const res = await api(
    "POST",
    "/api/v1/agent-deposits/agent/direct-credit",
    users.agent.token,
    { email: "stranger@test.local", amount: 400 }
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(await balanceOf(users.stranger.doc._id), before + 400);
});

guarded("sending more than the agent holds moves nothing", async () => {
  const before = {
    agent: await balanceOf(users.agent.doc._id),
    player: await balanceOf(users.stranger.doc._id),
  };

  const res = await api(
    "POST",
    "/api/v1/agent-deposits/agent/direct-credit",
    users.agent.token,
    { playerId: String(users.stranger.doc._id), amount: before.agent + 1 }
  );
  assert.equal(res.status, 402);

  assert.equal(await balanceOf(users.agent.doc._id), before.agent, "no debit");
  assert.equal(
    await balanceOf(users.stranger.doc._id),
    before.player,
    "and no credit — the pair is atomic"
  );
});

guarded("a direct credit needs a real player, and a real amount", async () => {
  const cases = [
    [{ amount: 100 }, 400, "no recipient at all"],
    [{ playerId: "not-an-id", amount: 100 }, 400, "a malformed id"],
    [{ email: "nobody@test.local", amount: 100 }, 404, "an unknown email"],
    [
      { playerId: String(users.customer.doc._id), amount: 0 },
      400,
      "a zero amount",
    ],
    [
      { playerId: String(users.customer.doc._id), amount: -50 },
      400,
      "a negative amount",
    ],
    [
      { playerId: String(users.customer.doc._id), amount: 1e13 },
      400,
      "an absurd amount",
    ],
  ];
  for (const [body, status, why] of cases) {
    const res = await api(
      "POST",
      "/api/v1/agent-deposits/agent/direct-credit",
      users.agent.token,
      body
    );
    assert.equal(res.status, status, `${why} should be refused`);
  }
});

guarded("an agent cannot credit themselves", async () => {
  const before = await balanceOf(users.agent.doc._id);
  const res = await api(
    "POST",
    "/api/v1/agent-deposits/agent/direct-credit",
    users.agent.token,
    { playerId: String(users.agent.doc._id), amount: 1000 }
  );
  assert.equal(res.status, 400);
  assert.equal(await balanceOf(users.agent.doc._id), before);
});

guarded("a player cannot use the agent's send endpoint", async () => {
  const res = await api(
    "POST",
    "/api/v1/agent-deposits/agent/direct-credit",
    users.customer.token,
    { playerId: String(users.stranger.doc._id), amount: 100 }
  );
  assert.ok(
    res.status === 403 || res.status === 401,
    `expected a refusal, got ${res.status}`
  );
});

guarded("looking a player up confirms who they are, without their address", async () => {
  const res = await api(
    "GET",
    `/api/v1/agent-deposits/agent/lookup-player?email=${encodeURIComponent(
      "stranger@test.local"
    )}`,
    users.agent.token
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.data.name, "stranger");
  assert.equal(res.body.data.id, String(users.stranger.doc._id));
  assert.ok(
    res.body.data.email.includes("***"),
    `the address should be masked, got ${res.body.data.email}`
  );
  assert.ok(
    !res.body.data.email.includes("stranger@"),
    "the full address must not come back"
  );

  const missing = await api(
    "GET",
    "/api/v1/agent-deposits/agent/lookup-player?email=nobody@test.local",
    users.agent.token
  );
  assert.equal(missing.status, 404);
});

// ── pictures in the chat ────────────────────────────────────────────────────
//
// Receipts already had an upload path, but only the player could use it and it
// moved the ticket to `receipt_uploaded`. An agent sharing a payment QR had
// nowhere to put it — the attach button on their side picked an image and then
// told them to type instead.

/** A tiny real JPEG, so sharp has something it can actually decode. */
async function jpegBytes() {
  const sharp = require("sharp");
  return sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  })
    .jpeg()
    .toBuffer();
}

async function postImage(path, token, bytes, caption) {
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/jpeg" }), "shot.jpg");
  if (caption) form.append("caption", caption);
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    json = null;
  }
  return { status: res.status, body: json };
}

guarded("both sides can put a picture in the chat", async () => {
  const agents = await api(
    "GET",
    "/api/v1/agent-deposits/countries/SY/agents",
    users.customer.token
  );
  const created = await api("POST", "/api/v1/agent-deposits/tickets", users.customer.token, {
    agentProfileId: agents.body.data[0].agentProfileId,
    amount: 1200,
  });
  const id = created.body.data.id;
  await api("POST", `/api/v1/agent-deposits/agent/tickets/${id}/accept`, users.agent.token);

  const bytes = await jpegBytes();

  // The agent — the side that previously had no way to send one at all.
  const fromAgent = await postImage(
    `/api/v1/agent-deposits/tickets/${id}/image`,
    users.agent.token,
    bytes,
    "تفاصيل الدفع"
  );
  assert.equal(fromAgent.status, 201, JSON.stringify(fromAgent.body));
  assert.equal(fromAgent.body.data.type, "image");
  assert.equal(fromAgent.body.data.senderRole, "agent");
  assert.ok(
    String(fromAgent.body.data.imageUrl).startsWith("uploads/deposit-chat/"),
    `chat images are kept apart from receipts, got ${fromAgent.body.data.imageUrl}`
  );
  assert.equal(fromAgent.body.data.body, "تفاصيل الدفع");

  const fromPlayer = await postImage(
    `/api/v1/agent-deposits/tickets/${id}/image`,
    users.customer.token,
    bytes
  );
  assert.equal(fromPlayer.status, 201);
  assert.equal(fromPlayer.body.data.senderRole, "user");

  // Both land in the same conversation, in order.
  const messages = await api(
    "GET",
    `/api/v1/agent-deposits/tickets/${id}/messages`,
    users.customer.token
  );
  const images = messages.body.data.filter((m) => m.type === "image");
  assert.equal(images.length, 2, "the chat holds both pictures");

  await api(`POST`, `/api/v1/agent-deposits/tickets/${id}/cancel`, users.customer.token);
});

guarded("a chat image does not masquerade as a receipt", async () => {
  const agents = await api(
    "GET",
    "/api/v1/agent-deposits/countries/SY/agents",
    users.customer.token
  );
  const created = await api("POST", "/api/v1/agent-deposits/tickets", users.customer.token, {
    agentProfileId: agents.body.data[0].agentProfileId,
    amount: 600,
  });
  const id = created.body.data.id;
  await api("POST", `/api/v1/agent-deposits/agent/tickets/${id}/accept`, users.agent.token);

  await postImage(
    `/api/v1/agent-deposits/tickets/${id}/image`,
    users.agent.token,
    await jpegBytes()
  );

  const ticket = await api(
    "GET",
    `/api/v1/agent-deposits/tickets/${id}`,
    users.customer.token
  );
  assert.notEqual(
    ticket.body.data.status,
    "receipt_uploaded",
    "only a real receipt moves the ticket on"
  );

  await api("POST", `/api/v1/agent-deposits/tickets/${id}/cancel`, users.customer.token);
});

guarded("a stranger cannot post into someone else's chat", async () => {
  const agents = await api(
    "GET",
    "/api/v1/agent-deposits/countries/SY/agents",
    users.customer.token
  );
  const created = await api("POST", "/api/v1/agent-deposits/tickets", users.customer.token, {
    agentProfileId: agents.body.data[0].agentProfileId,
    amount: 300,
  });
  const id = created.body.data.id;

  const res = await postImage(
    `/api/v1/agent-deposits/tickets/${id}/image`,
    users.stranger.token,
    await jpegBytes()
  );
  assert.equal(res.status, 403, "the ticket's own access rules decide");

  await api("POST", `/api/v1/agent-deposits/tickets/${id}/cancel`, users.customer.token);
});
