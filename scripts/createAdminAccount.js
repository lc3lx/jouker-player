/**
 * Create (or promote) a staff account directly in the database.
 *
 * The bootstrap case: `POST /admin/staff` is the normal way to add staff, but
 * it requires an existing superadmin to call it. On a fresh database there is
 * nobody to call it, so the first account has to be made here.
 *
 * Usage:
 *   node backend/scripts/createAdminAccount.js \
 *     --email=someone@example.com --password='...' [--name='...'] \
 *     [--role=superadmin|admin|manager|support] [--reset-password]
 *
 * Every value can also come from the environment
 * (ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME / ADMIN_ROLE), which is the
 * better option on a shared machine — a command line ends up in shell history.
 *
 * The password is never hardcoded here: this file is in the repository, and a
 * live staff credential committed to it is a credential that cannot be taken
 * back.
 *
 * Safe to re-run. An account that already exists is promoted in place — its
 * role and permissions are brought up to date and its wallet and invite code
 * are filled in if missing. Its password is only overwritten when you ask for
 * that explicitly with --reset-password, because replacing a working password
 * cannot be undone.
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const mongoose = require("mongoose");
const dbConnection = require("../config/database");
const User = require("../models/userModel");
const Wallet = require("../models/walletModel");
const {
  ROLE_DEFAULTS,
  STAFF_ROLES,
} = require("../services/platformPermissions");
const referralInviteService = require("../modules/referral/services/referralInviteService");

/** `--key=value` and `--flag` from argv, merged over the environment. */
function readOptions(argv) {
  const flags = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const body = raw.slice(2);
    const eq = body.indexOf("=");
    if (eq === -1) flags[body] = true;
    else flags[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return {
    email: String(flags.email || process.env.ADMIN_EMAIL || "").trim(),
    password: String(flags.password || process.env.ADMIN_PASSWORD || ""),
    name: String(flags.name || process.env.ADMIN_NAME || "").trim(),
    // superadmin by default: this script exists for the *first* account, and an
    // `admin` has every capability except STAFF_WRITE — it could not go on to
    // create the rest of the staff from the panel.
    role: String(flags.role || process.env.ADMIN_ROLE || "superadmin")
      .toLowerCase()
      .trim(),
    resetPassword: flags["reset-password"] === true,
  };
}

function usage(message) {
  console.error(`\n${message}\n`);
  console.error(
    "Usage: node backend/scripts/createAdminAccount.js " +
      "--email=<email> --password=<password> [--name=<name>] " +
      `[--role=${STAFF_ROLES.join("|")}] [--reset-password]\n`
  );
  process.exit(1);
}

/** The local part of an email, as a passable display name. */
function nameFromEmail(email) {
  const local = email.split("@")[0] || "admin";
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function validate(opts) {
  if (!opts.email || !opts.email.includes("@")) {
    usage("A valid --email is required.");
  }
  if (!opts.password) {
    usage("A --password is required (or set ADMIN_PASSWORD).");
  }
  // Matches the model's own `minlength: 6`; catching it here gives a readable
  // message instead of a Mongoose validation dump.
  if (opts.password.length < 6) {
    usage("The password must be at least 6 characters.");
  }
  if (!STAFF_ROLES.includes(opts.role)) {
    usage(`--role must be one of: ${STAFF_ROLES.join(", ")}`);
  }
}

/**
 * The capability list for a role.
 *
 * A superadmin is checked by role everywhere (`isSuperAdmin`) and ignores this
 * list entirely, so it stays empty — exactly what `adminCreateStaff` writes.
 */
function permissionsFor(role) {
  if (role === "superadmin") return [];
  return (ROLE_DEFAULTS[role] || []).slice();
}

/** Every staff account still needs a wallet; nothing checks for one first. */
async function ensureWallet(user) {
  if (user.wallet) {
    const existing = await Wallet.findById(user.wallet).select("_id");
    if (existing) return { walletId: existing._id, created: false };
  }
  const found = await Wallet.findOne({ user: user._id }).select("_id");
  const wallet = found || (await Wallet.create({ user: user._id }));
  if (String(user.wallet || "") !== String(wallet._id)) {
    await User.findByIdAndUpdate(user._id, { wallet: wallet._id });
  }
  return { walletId: wallet._id, created: !found };
}

async function main() {
  const opts = readOptions(process.argv.slice(2));
  validate(opts);

  const email = opts.email.toLowerCase();
  const name = opts.name || nameFromEmail(email);
  const permissions = permissionsFor(opts.role);

  await dbConnection();
  try {
    const existing = await User.findOne({ email });

    if (!existing) {
      // `pre("save")` hashes the password, so it goes in as plain text here and
      // must never be pre-hashed by the caller.
      const user = await User.create({
        name,
        email,
        password: opts.password,
        role: opts.role,
        permissions,
        active: true,
      });
      const wallet = await ensureWallet(user);
      const inviteCode = await referralInviteService.ensureInviteCode(user._id);

      console.log("admin_account_created", {
        id: String(user._id),
        email: user.email,
        name: user.name,
        role: user.role,
        permissions: permissions.length || "all (superadmin)",
        walletId: String(wallet.walletId),
        inviteCode,
      });
      return;
    }

    // Already there: bring it up to the requested role rather than failing,
    // so re-running after a partial run finishes the job.
    const previousRole = existing.role;
    existing.name = opts.name || existing.name || name;
    existing.role = opts.role;
    existing.permissions = permissions;
    existing.active = true;

    if (opts.resetPassword) {
      existing.password = opts.password;
      // Logs every existing session out, so an old session cannot outlive the
      // password it was issued under.
      existing.sessionVersion = (existing.sessionVersion || 0) + 1;
      existing.passwordChangedAt = new Date();
    }

    await existing.save();
    const wallet = await ensureWallet(existing);
    const inviteCode = await referralInviteService.ensureInviteCode(existing._id);

    console.log("admin_account_updated", {
      id: String(existing._id),
      email: existing.email,
      name: existing.name,
      roleBefore: previousRole,
      roleAfter: existing.role,
      permissions: permissions.length || "all (superadmin)",
      passwordChanged: opts.resetPassword,
      walletId: String(wallet.walletId),
      inviteCode,
    });

    if (!opts.resetPassword) {
      console.log(
        "\nThis account already existed, so its password was left alone.\n" +
          "Re-run with --reset-password to set the one you passed."
      );
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  if (err && err.code === 11000) {
    console.error("createAdminAccount failed: that email is already taken.");
  } else {
    console.error("createAdminAccount failed:", err?.message || err);
  }
  process.exit(1);
});
