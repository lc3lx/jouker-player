const crypto = require("crypto");

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const sendEmail = require("../utils/sendEmail");
const createToken = require("../utils/createToken");

const User = require("../models/userModel");
const Wallet = require("../models/walletModel");
const AgentProfile = require("../models/agentProfileModel");
const referralInviteService = require("../modules/referral/services/referralInviteService");
const { publish } = require("../domain/events/domainEventBus");
const Events = require("../domain/events/eventTypes");

// @desc    Signup
// @route   GET /api/v1/auth/signup
// @access  Public
exports.signup = asyncHandler(async (req, res, next) => {
  let referredBy = undefined;
  const inviteRaw = (req.body.inviteCode || req.body.referralCode || "")
    .toString()
    .trim()
    .toUpperCase();

  const clientSignals = {
    deviceFingerprint: req.body.deviceFingerprint || null,
    appInstanceId: req.body.appInstanceId || null,
    emulator: !!req.body.emulator,
    rooted: !!req.body.rooted,
    registrationIp:
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.ip ||
      req.socket?.remoteAddress ||
      null,
  };

  if (inviteRaw) {
    const resolved = await referralInviteService.resolveInviteCode(inviteRaw);
    if (resolved.ok) referredBy = resolved.referrerId;
    else {
      const profile = await AgentProfile.findOne({
        referralCode: inviteRaw,
        status: "approved",
      });
      if (profile) referredBy = profile.user;
    }
  }

  const inviteCode = referralInviteService.generateInviteCode();

  let user;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      user = await User.create({
        name: req.body.name,
        email: req.body.email,
        password: req.body.password,
        referredBy,
        inviteCode: attempt === 0 ? inviteCode : referralInviteService.generateInviteCode(),
        referralMeta: referredBy
          ? {
              linkedAt: new Date(),
              source: inviteRaw ? "invite" : "agent",
              deviceFingerprint: clientSignals.deviceFingerprint,
              appInstanceId: clientSignals.appInstanceId,
            }
          : undefined,
      });
      break;
    } catch (err) {
      if (err?.code === 11000 && String(err.message).includes("inviteCode") && attempt < 4) {
        continue;
      }
      throw err;
    }
  }
  if (!user) return next(new ApiError("Could not create user", 500));

  // 2- Create wallet for the user
  const wallet = await Wallet.create({ user: user._id });

  // 3- Update user with wallet reference
  await User.findByIdAndUpdate(user._id, { wallet: wallet._id });

  if (referredBy && inviteRaw) {
    await referralInviteService.linkReferralOnSignup(user._id, inviteRaw, clientSignals);
  }

  publish(Events.PLAYER_REGISTERED, {
    userId: String(user._id),
    referredBy: referredBy ? String(referredBy) : null,
    clientSignals,
  });

  publish(Events.PLAYER_SESSION_STARTED, { userId: String(user._id) });

  // 4- Generate token
  const token = createToken(user._id, user.sessionVersion);

  const safeUser = user.toObject();
  delete safeUser.password;

  res.status(201).json({ data: safeUser, token });
});

// @desc    Login
// @route   GET /api/v1/auth/login
// @access  Public
exports.login = asyncHandler(async (req, res, next) => {
  // 1) check if password and email in the body (validation)
  // 2) check if user exist & check if password is correct
  const user = await User.findOne({ email: req.body.email }).select("+password");

  if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
    return next(new ApiError("Incorrect email or password", 401));
  }
  if (user.active === false) {
    return next(new ApiError("Account is deactivated", 403));
  }
  // 3) generate token
  const token = createToken(user._id, user.sessionVersion);

  // Delete password from response
  delete user._doc.password;
  const { publish } = require("../domain/events/domainEventBus");
  const Events = require("../domain/events/eventTypes");
  publish(Events.PLAYER_SESSION_STARTED, { userId: String(user._id) });
  res.status(200).json({ data: user, token });
});

// @desc   make sure the user is logged in
exports.protect = asyncHandler(async (req, res, next) => {
  // 1) Check if token exist, if exist get
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  }
  if (!token) {
    return next(
      new ApiError(
        "You are not login, Please login to get access this route",
        401
      )
    );
  }

  // 2) Verify token (no change happens, expired token)
  const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);

  // 3) Check if user exists
  const currentUser = await User.findById(decoded.userId);
  if (!currentUser) {
    return next(
      new ApiError(
        "The user that belong to this token does no longer exist",
        401
      )
    );
  }

  if (currentUser.active === false) {
    return next(
      new ApiError("Account is deactivated or suspended", 401)
    );
  }

  // 4) Check if user change his password after token created
  if (currentUser.passwordChangedAt) {
    const passChangedTimestamp = parseInt(
      currentUser.passwordChangedAt.getTime() / 1000,
      10
    );
    // Password changed after token created (Error)
    if (passChangedTimestamp > decoded.iat) {
      return next(
        new ApiError(
          "User recently changed his password. please login again..",
          401
        )
      );
    }
  }

  const tokenSession = Math.floor(Number(decoded.sessionVersion) || 0);
  const userSession = Math.floor(Number(currentUser.sessionVersion) || 0);
  if (tokenSession !== userSession) {
    return next(
      new ApiError("Session expired. Please login again.", 401)
    );
  }

  req.user = currentUser;
  next();
});

// @desc    Authorization (User Permissions)
// ["admin", "manager"] — superadmin passes any staff gate; support only when listed.
exports.allowedTo = (...roles) =>
  asyncHandler(async (req, res, next) => {
    const role = String(req.user?.role || "");
    if (roles.includes(role)) return next();

    const staffGate = roles.some((r) =>
      ["admin", "manager", "support", "superadmin"].includes(r)
    );
    // Superadmin inherits every staff allow-list (dashboard owner).
    if (role === "superadmin" && staffGate) return next();

    // Admin inherits manager/support gates when those roles are listed.
    if (role === "admin") {
      if (roles.includes("manager") || roles.includes("support")) return next();
    }

    // Manager can work the support desk when support is allowed.
    if (role === "manager" && roles.includes("support")) return next();

    return next(
      new ApiError("You are not allowed to access this route", 403)
    );
  });

/** Optional capability gate for fine-grained admin dashboard modules. */
exports.requirePermission = (...capabilities) => {
  const { requirePermission } = require("./platformPermissions");
  return requirePermission(...capabilities);
};

// @desc    Forgot password
// @route   POST /api/v1/auth/forgotPassword
// @access  Public
exports.forgotPassword = asyncHandler(async (req, res, next) => {
  // 1) Get user by email
  const user = await User.findOne({ email: req.body.email });
  if (!user) {
    return next(
      new ApiError(`There is no user with that email ${req.body.email}`, 404)
    );
  }
  // 2) If user exist, Generate hash reset random 6 digits and save it in db
  const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
  const hashedResetCode = crypto
    .createHash("sha256")
    .update(resetCode)
    .digest("hex");

  // Save hashed password reset code into db
  user.passwordResetCode = hashedResetCode;
  // Add expiration time for password reset code (10 min)
  user.passwordResetExpires = Date.now() + 10 * 60 * 1000;
  user.passwordResetVerified = false;

  await user.save();

  // 3) Send the reset code via email
  const message = `Hi ${user.name},\n We received a request to reset the password on your E-shop Account. \n ${resetCode} \n Enter this code to complete the reset. \n Thanks for helping us keep your account secure.\n The E-shop Team`;
  try {
    await sendEmail({
      email: user.email,
      subject: "Your password reset code (valid for 10 min)",
      message,
    });
  } catch (err) {
    user.passwordResetCode = undefined;
    user.passwordResetExpires = undefined;
    user.passwordResetVerified = undefined;

    await user.save();
    return next(new ApiError("There is an error in sending email", 500));
  }

  res
    .status(200)
    .json({ status: "Success", message: "Reset code sent to email" });
});

// @desc    Verify password reset code
// @route   POST /api/v1/auth/verifyResetCode
// @access  Public
exports.verifyPassResetCode = asyncHandler(async (req, res, next) => {
  const resetCode = String(req.body?.resetCode || "");
  if (!resetCode) {
    return next(new ApiError("Reset code is required", 400));
  }

  // 1) Get user based on reset code
  const hashedResetCode = crypto
    .createHash("sha256")
    .update(resetCode)
    .digest("hex");

  const user = await User.findOne({
    passwordResetCode: hashedResetCode,
    passwordResetExpires: { $gt: Date.now() },
  });
  if (!user) {
    return next(new ApiError("Reset code invalid or expired", 400));
  }

  // 2) Generate cryptographically secure one-time reset token (10 min expiry)
  const resetToken = crypto.randomBytes(32).toString("hex");
  const hashedResetToken = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");

  user.passwordResetToken = hashedResetToken;
  user.passwordResetTokenExpires = new Date(Date.now() + 10 * 60 * 1000);
  user.passwordResetVerified = true;
  user.passwordResetCode = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  res.status(200).json({
    status: "Success",
    resetToken,
  });
});

// @desc    Reset password
// @route   POST /api/v1/auth/resetPassword
// @access  Public
exports.resetPassword = asyncHandler(async (req, res, next) => {
  const email = req.body?.email;
  const newPassword = req.body?.newPassword;
  const resetToken = req.body?.resetToken || req.headers["x-reset-token"];

  if (!email || !newPassword) {
    return next(new ApiError("Email and new password are required", 400));
  }

  // 1) Get user based on email
  const user = await User.findOne({ email });
  if (!user) {
    return next(
      new ApiError(`There is no user with email ${email}`, 404)
    );
  }

  // 2) Verify reset token and expiration
  if (resetToken) {
    const hashedResetToken = crypto
      .createHash("sha256")
      .update(String(resetToken))
      .digest("hex");

    const isTokenValid =
      user.passwordResetToken &&
      user.passwordResetToken === hashedResetToken &&
      user.passwordResetTokenExpires &&
      user.passwordResetTokenExpires.getTime() > Date.now();

    if (!isTokenValid) {
      return next(new ApiError("Reset token is invalid or expired", 400));
    }
  } else {
    // Require verified state within an unexpired window
    const hasValidExpiry =
      (user.passwordResetTokenExpires && user.passwordResetTokenExpires.getTime() > Date.now()) ||
      (user.passwordResetExpires && user.passwordResetExpires.getTime() > Date.now());

    if (!user.passwordResetVerified || !hasValidExpiry) {
      return next(new ApiError("Password reset authorization missing or expired", 400));
    }
  }

  user.password = newPassword;
  user.passwordChangedAt = new Date();
  user.sessionVersion = Math.floor(Number(user.sessionVersion) || 0) + 1;
  user.passwordResetCode = undefined;
  user.passwordResetExpires = undefined;
  user.passwordResetVerified = undefined;
  user.passwordResetToken = undefined;
  user.passwordResetTokenExpires = undefined;

  await user.save();

  // 3) if everything is ok, generate token with new session version
  const token = createToken(user._id, user.sessionVersion);
  res.status(200).json({ token });
});
