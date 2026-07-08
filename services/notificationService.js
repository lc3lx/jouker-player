const asyncHandler = require("express-async-handler");
const Notification = require("../models/notificationModel");
const Activity = require("../models/activityModel");
const FriendRequest = require("../models/friendRequestModel");
const User = require("../models/userModel");
const ApiError = require("../utils/apiError");

const SKIP_ACTIVITY_CATEGORIES = new Set(["loss"]);

function relativeAgeLabel(date, now = new Date()) {
  const ms = now.getTime() - new Date(date).getTime();
  if (ms < 0) return "الآن";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "الآن";
  if (mins < 60) return mins === 1 ? "منذ دقيقة" : `منذ ${mins} دقيقة`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? "منذ ساعة" : `منذ ${hours} ساعة`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "أمس";
  if (days < 7) return `منذ ${days} أيام`;
  return new Date(date).toLocaleDateString("ar-SA");
}

function mapActivityCategory(category) {
  switch (category) {
    case "task":
      return "task";
    case "bonus":
      return "bonus";
    case "win":
      return "tournament";
    case "friend":
    case "social":
      return "friend";
    case "tournament":
      return "tournament";
    default:
      return "other";
  }
}

function mapActivityIcon(icon, category) {
  if (icon && icon !== "default") return icon;
  switch (category) {
    case "task":
      return "star";
    case "bonus":
      return "gift";
    case "win":
    case "tournament":
      return "trophy";
    case "friend":
    case "social":
      return "people";
    default:
      return "default";
  }
}

function serializeNotification(row, now = new Date()) {
  return {
    id: String(row._id),
    title: row.title,
    subtitle: row.subtitle || relativeAgeLabel(row.createdAt, now),
    category: row.category,
    icon: row.icon || "default",
    isRead: row.isRead === true,
    createdAt: row.createdAt,
    ageLabel: relativeAgeLabel(row.createdAt, now),
  };
}

async function createNotification(payload) {
  const { userId, sourceType, sourceId } = payload;
  if (!userId || !payload.title) return null;

  if (sourceType && sourceId) {
    const existing = await Notification.findOne({ userId, sourceType, sourceId }).lean();
    if (existing) return existing;
  }

  try {
    return await Notification.create(payload);
  } catch (err) {
    if (err?.code === 11000 && sourceType && sourceId) {
      return Notification.findOne({ userId, sourceType, sourceId }).lean();
    }
    throw err;
  }
}

async function recordNotificationFromActivity(activity) {
  if (!activity?.userId || !activity?.label) return null;
  if (SKIP_ACTIVITY_CATEGORIES.has(activity.category)) return null;

  const category = mapActivityCategory(activity.category);
  const icon = mapActivityIcon(activity.icon, activity.category);
  const sourceType = activity.sourceType
    ? `activity:${activity.sourceType}`
    : `activity:${activity.category}`;
  const sourceId =
    activity.sourceId ||
    String(activity._id || `${activity.label}:${activity.createdAt || ""}`);

  return createNotification({
    userId: activity.userId,
    category,
    title: activity.label,
    subtitle: activity.subLabel || "",
    icon,
    sourceType,
    sourceId,
    meta: activity.meta || null,
    createdAt: activity.createdAt || new Date(),
  });
}

async function recordFriendRequestNotification(request, fromUser) {
  if (!request?.to || !request?._id) return null;
  const name = fromUser?.name?.trim() || "لاعب";
  return createNotification({
    userId: request.to,
    category: "friend",
    title: `أضافك ${name} كصديق`,
    subtitle: "الأصدقاء · الآن",
    icon: "people",
    sourceType: "friend_request",
    sourceId: String(request._id),
    meta: { fromUserId: String(request.from) },
  });
}

async function backfillNotifications(userId, limit = 40) {
  const count = await Notification.countDocuments({ userId });
  if (count > 0) return;

  const activities = await Activity.find({ userId, category: { $nin: ["loss"] } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  for (const activity of activities) {
    await recordNotificationFromActivity(activity);
  }

  const pending = await FriendRequest.find({ to: userId, status: "pending" })
    .sort({ createdAt: -1 })
    .limit(20)
    .populate("from", "name")
    .lean();

  for (const req of pending) {
    await recordFriendRequestNotification(req, req.from);
  }
}

exports.createNotification = createNotification;
exports.recordNotificationFromActivity = recordNotificationFromActivity;
exports.recordFriendRequestNotification = recordFriendRequestNotification;

exports.getNotifications = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  await backfillNotifications(userId);

  const filter = (req.query.filter || "all").toLowerCase();
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(50, parseInt(req.query.limit || "30", 10));
  const skip = (page - 1) * limit;

  const query = { userId };
  if (filter === "unread") query.isRead = false;

  const now = new Date();
  const [rows, total, unreadCount] = await Promise.all([
    Notification.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(query),
    Notification.countDocuments({ userId, isRead: false }),
  ]);

  res.status(200).json({
    status: "success",
    results: rows.length,
    pagination: {
      currentPage: page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      totalItems: total,
      limit,
    },
    data: {
      items: rows.map((row) => serializeNotification(row, now)),
      unreadCount,
    },
  });
});

exports.getUnreadCount = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const unreadCount = await Notification.countDocuments({ userId, isRead: false });
  res.status(200).json({
    status: "success",
    data: { unreadCount },
  });
});

exports.markNotificationRead = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const id = req.params.id;
  const row = await Notification.findOne({ _id: id, userId });
  if (!row) throw new ApiError("Notification not found", 404);

  if (!row.isRead) {
    row.isRead = true;
    row.readAt = new Date();
    await row.save();
  }

  const unreadCount = await Notification.countDocuments({ userId, isRead: false });
  res.status(200).json({
    status: "success",
    data: {
      notification: serializeNotification(row.toObject()),
      unreadCount,
    },
  });
});

exports.markAllNotificationsRead = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const now = new Date();
  await Notification.updateMany(
    { userId, isRead: false },
    { $set: { isRead: true, readAt: now } }
  );
  res.status(200).json({
    status: "success",
    data: { unreadCount: 0 },
  });
});
