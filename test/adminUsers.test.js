/**
 * Admin users directory + role/agent assignment.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || "admin-users-test-secret";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");

const MONGO_URI = `mongodb://127.0.0.1:27017/admin_users_test_${process.pid}`;

let mongoAvailable = false;
let server;
let base;
let User;
let AgentProfile;
const users = {};

const createToken = require("../utils/createToken");
const globalError = require("../middlewares/errorMiddleware");

async function makeUser(name, role = "user") {
  const doc = await User.create({
    name,
    email: `${name}@test.local`,
    password: "secret123",
    role,
    playerId: Math.floor(Math.random() * 8000) + 2000,
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

function guarded(name, fn) {
  test(name, async (t) => {
    if (!mongoAvailable) {
      t.skip("mongo unavailable");
      return;
    }
    await fn();
  });
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
  const adminUserRoute = require("../routes/adminUserRoute");

  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin/users", adminUserRoute);
  app.use(globalError);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  users.super = await makeUser("super", "superadmin");
  users.player = await makeUser("anasqanbar31");
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (mongoAvailable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

guarded("resolves a user by messy or partial email", async () => {
  const { findRegisteredUser } = require("../utils/findRegisteredUser");
  const exact = await findRegisteredUser({
    email: "  ANASQANBAR31@test.local ",
  });
  assert.ok(exact);
  assert.equal(String(exact._id), String(users.player.doc._id));

  const partial = await findRegisteredUser({ email: "anasqanbar31" });
  assert.ok(partial);
  assert.equal(String(partial._id), String(users.player.doc._id));
});

guarded("lists registered users for the dashboard", async () => {
  const res = await api("GET", "/api/v1/admin/users?limit=20", users.super.token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.data.total >= 2);
  const row = res.body.data.rows.find((r) => r.email === "anasqanbar31@test.local");
  assert.ok(row);
  assert.equal(row.role, "user");
  assert.equal(row.isAgent, false);
});

guarded("finds a user by partial email", async () => {
  const res = await api(
    "GET",
    "/api/v1/admin/users?q=anasqanbar31",
    users.super.token
  );
  assert.equal(res.status, 200);
  assert.ok(res.body.data.rows.some((r) => r.email === "anasqanbar31@test.local"));
});

guarded("promotes a player to manager then admin", async () => {
  const id = String(users.player.doc._id);
  const manager = await api(
    "PATCH",
    `/api/v1/admin/users/${id}/access`,
    users.super.token,
    { role: "manager" }
  );
  assert.equal(manager.status, 200, JSON.stringify(manager.body));
  assert.equal(manager.body.data.role, "manager");

  const admin = await api(
    "PATCH",
    `/api/v1/admin/users/${id}/access`,
    users.super.token,
    { role: "admin" }
  );
  assert.equal(admin.status, 200);
  assert.equal(admin.body.data.role, "admin");
});

guarded("makes an existing account a deposit agent", async () => {
  const id = String(users.player.doc._id);
  const res = await api(
    "PATCH",
    `/api/v1/admin/users/${id}/access`,
    users.super.token,
    { makeAgent: true, countries: ["SA"] }
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.isAgent, true);
  assert.ok(res.body.data.agentProfileId);

  const profile = await AgentProfile.findOne({ user: users.player.doc._id });
  assert.ok(profile);
  assert.equal(profile.status, "approved");
  assert.equal(profile.deposit.enabled, true);
});
