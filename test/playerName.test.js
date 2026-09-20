"use strict";

/**
 * Paid display-name changes: the price ladder, the three-change cap, the
 * validation, and the free-rename hole this feature closes on /users/updateMe.
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../models/userModel");
const Player = require("../models/playerModel");
const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");
const {
  resetMongoTransactionProbeForTests,
} = require("../services/walletLedgerService");
const svc = require("../services/playerNameService");

let replSet = null;
const savedEnv = {};
let seq = 0;

async function makeUser(balance = 100_000_000) {
  seq += 1;
  const user = await User.create({
    name: `لاعب ${seq}`,
    email: `n${seq}.${Date.now()}@test.local`,
    password: "x".repeat(12),
  });
  await Wallet.create({ user: user._id, balance, lockedBalance: 0 });
  return user;
}

const balanceOf = async (u) =>
  (await Wallet.findOne({ user: u }).lean())?.balance ?? 0;
const nameOf = async (u) => (await User.findById(u).select("name").lean())?.name;
const countOf = async (u) =>
  (await User.findById(u).select("nameChangeCount").lean())?.nameChangeCount ?? 0;

test.before(async () => {
  for (const k of ["MONGODB_URI", "MONGO_URI", "DB_URI", "MONGO_STANDALONE"]) {
    savedEnv[k] = process.env[k];
  }
  delete process.env.MONGO_STANDALONE;
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGODB_URI = replSet.getUri();
  delete process.env.MONGO_URI;
  delete process.env.DB_URI;
  resetMongoTransactionProbeForTests();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(replSet.getUri(), { dbName: "player_name_test" });
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
  resetMongoTransactionProbeForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/* ------------------------------------------------------------- the ladder -- */

test("three renames cost 1M, then 5M, then 10M — and there is no fourth", async () => {
  const user = await makeUser(100_000_000);

  await svc.changeName({ userId: user._id, name: "الاسم الأول" });
  assert.equal(await balanceOf(user._id), 99_000_000);
  assert.equal(await nameOf(user._id), "الاسم الأول");

  await svc.changeName({ userId: user._id, name: "الاسم الثاني" });
  assert.equal(await balanceOf(user._id), 94_000_000);

  await svc.changeName({ userId: user._id, name: "الاسم الثالث" });
  assert.equal(await balanceOf(user._id), 84_000_000);
  assert.equal(await countOf(user._id), 3);

  const before = await balanceOf(user._id);
  await assert.rejects(
    () => svc.changeName({ userId: user._id, name: "الاسم الرابع" }),
    (err) => err.statusCode === 409
  );
  assert.equal(await balanceOf(user._id), before, "the refusal is free");
  assert.equal(await nameOf(user._id), "الاسم الثالث", "and changes nothing");
  assert.equal(await countOf(user._id), 3);
});

test("an account created before this feature can still rename", async () => {
  // The state every existing player is in on the day this deploys: mongoose
  // defaults only apply to documents mongoose creates, so `nameChangeCount` is
  // absent — and `$lt` does not match a missing field. Without the `$exists`
  // arm in the claim, the whole player base is told it has used up all three
  // changes and nobody can rename at all.
  const user = await makeUser(100_000_000);
  await User.collection.updateOne(
    { _id: user._id },
    { $unset: { nameChangeCount: "" } }
  );
  const raw = await User.collection.findOne({ _id: user._id });
  assert.equal("nameChangeCount" in raw, false, "the field really is absent");

  const res = await svc.changeName({ userId: user._id, name: "اسم بعد الترقية" });

  assert.equal(res.charged, 1_000_000, "charged the first slot, not a later one");
  assert.equal(await nameOf(user._id), "اسم بعد الترقية");
  assert.equal(await countOf(user._id), 1);
});

test("the quote tracks what is left", async () => {
  const user = await makeUser();
  let q = await svc.getQuote(user._id);
  assert.equal(q.used, 0);
  assert.equal(q.remaining, 3);
  assert.equal(q.nextPrice, 1_000_000);

  await svc.changeName({ userId: user._id, name: "اسم جديد" });
  q = await svc.getQuote(user._id);
  assert.equal(q.used, 1);
  assert.equal(q.remaining, 2);
  assert.equal(q.nextPrice, 5_000_000);
});

test("insufficient balance leaves both the name and the quota untouched", async () => {
  const user = await makeUser(500_000);
  const before = await nameOf(user._id);

  await assert.rejects(
    () => svc.changeName({ userId: user._id, name: "اسم غالي" }),
    (err) => err.statusCode === 402
  );

  assert.equal(await balanceOf(user._id), 500_000);
  assert.equal(await nameOf(user._id), before);
  assert.equal(
    await countOf(user._id),
    0,
    "the slot claim rolled back with the debit"
  );
});

/* ------------------------------------------------------------ concurrency -- */

test("two renames at once never share one charge", async () => {
  const user = await makeUser(100_000_000);

  await Promise.allSettled([
    svc.changeName({ userId: user._id, name: "اسم واحد" }),
    svc.changeName({ userId: user._id, name: "اسم اثنان" }),
  ]);

  const used = await countOf(user._id);
  const charges = await WalletTransaction.countDocuments({
    userId: user._id,
    type: "name_change_fee",
  });
  assert.equal(
    used,
    charges,
    "every consumed slot has exactly one fee behind it"
  );
});

test("the same requestKey is only honoured once", async () => {
  const user = await makeUser(100_000_000);
  const key = "rename-req-1";

  await svc.changeName({ userId: user._id, name: "اسم بمفتاح", requestKey: key });
  const second = await svc.changeName({
    userId: user._id,
    name: "اسم آخر",
    requestKey: key,
  });

  assert.equal(second.duplicate, true);
  assert.equal(await countOf(user._id), 1);
  assert.equal(await balanceOf(user._id), 99_000_000);
});

test("renaming to the same name is free and consumes nothing", async () => {
  const user = await makeUser();
  const current = await nameOf(user._id);

  const res = await svc.changeName({ userId: user._id, name: current });

  assert.equal(res.duplicate, true);
  assert.equal(res.charged, 0);
  assert.equal(await countOf(user._id), 0);
});

/* ------------------------------------------------------------- validation -- */

test("Arabic names pass whole", () => {
  assert.equal(svc.validateDisplayName("أبو خالد"), "أبو خالد");
  assert.equal(svc.validateDisplayName("ياسين الأسود"), "ياسين الأسود");
  assert.equal(svc.validateDisplayName("Player_99"), "Player_99");
});

test("Arabic diacritics are part of the name, not a rejection", () => {
  // Combining marks carry Script=Inherited, so `\p{Script=Arabic}` alone
  // rejects every vocalized name. This is the regression that guards it.
  assert.equal(svc.validateDisplayName("الاسم المحدّث"), "الاسم المحدّث");
  assert.equal(svc.validateDisplayName("مُحَمَّد"), "مُحَمَّد");
  assert.equal(svc.validateDisplayName("عبدُالله"), "عبدُالله");
});

test("whitespace is normalized rather than rejected", () => {
  assert.equal(svc.validateDisplayName("  اسم   طويل  "), "اسم طويل");
});

test("an all-digit name is refused", () => {
  // Otherwise a player names themselves "1001" in the same release that makes
  // 1001 somebody's actual identity.
  assert.throws(() => svc.validateDisplayName("12345"), /أرقام فقط/);
  assert.throws(() => svc.validateDisplayName("١٠٠١"), /أرقام فقط/);
});

test("direction and zero-width characters are refused", () => {
  assert.throws(() => svc.validateDisplayName("ab‮cd"), /غير مسموحة/);
  assert.throws(() => svc.validateDisplayName("اسم​خفي"), /غير مسموحة/);
});

test("length is measured in code points", () => {
  assert.throws(() => svc.validateDisplayName("ab"), /قصير/);
  assert.throws(() => svc.validateDisplayName("ا".repeat(21)), /طويل/);
  assert.equal(svc.validateDisplayName("ا".repeat(20)).length, 20);
});

test("reserved words are refused", () => {
  assert.throws(() => svc.validateDisplayName("admin99"), /محجوز/);
  assert.throws(() => svc.validateDisplayName("الدعم الفني"), /محجوز/);
});

test("symbols outside the allowlist are refused", () => {
  assert.throws(() => svc.validateDisplayName("اسم<script>"), /غير مسموحة/);
  assert.throws(() => svc.validateDisplayName("name@home"), /غير مسموحة/);
});

/* ------------------------------------------------ the denormalized copies -- */

test("renaming syncs the denormalized display name", async () => {
  const user = await makeUser();
  await Player.create({ user: user._id, displayName: "قديم" });

  await svc.changeName({ userId: user._id, name: "الاسم المحدّث" });

  const player = await Player.findOne({ user: user._id }).lean();
  assert.equal(player.displayName, "الاسم المحدّث");
});

/* --------------------------------------------- the hole this feature closes -- */

test("updateMe no longer renames", async () => {
  const { updateLoggedUserData } = require("../services/userService");
  const user = await makeUser();
  const original = await nameOf(user._id);

  // A real change is refused...
  const changed = await runHandler(updateLoggedUserData, {
    user: { _id: user._id, name: original },
    body: { name: "اسم مجاني" },
  });
  assert.equal(changed.error?.statusCode, 400);
  assert.equal(await nameOf(user._id), original, "and nothing was written");

  // ...but the avatar upload, which resends the unchanged name alongside the
  // image, still works. Breaking this would break every profile-photo change.
  const avatar = await runHandler(updateLoggedUserData, {
    user: { _id: user._id, name: original },
    body: { name: original, profileImg: "pic.png" },
  });
  assert.equal(avatar.error, undefined);
  const after = await User.findById(user._id).select("profileImg").lean();
  assert.equal(after.profileImg, "pic.png");
});

/** Drive an express handler without an HTTP server. */
function runHandler(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ statusCode: this.statusCode, body });
      },
    };
    const next = (err) => (err ? resolve({ error: err }) : resolve({}));
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}
