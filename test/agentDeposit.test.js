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

  const list = await api(
    "GET",
    "/api/v1/agent-deposits/admin/tickets?status=all",
    users.admin.token
  );
  assert.equal(list.status, 200);
  assert.ok(list.body.total >= 3);
});
