const ApiError = require("../utils/apiError");
const Clan = require("../models/clanModel");
const ClanMember = require("../models/clanMemberModel");
const ClanEvent = require("../models/clanEventModel");
const clanService = require("./clanService");
const clanPermissionService = require("./clanPermissionService");
const clanMembershipService = require("./clanMembershipService");
const clanRealtime = require("./clanRealtime");
const chatService = require("./chatService");

const EVENT_TYPES = [
  "poker_night",
  "weekly_trix",
  "tarneeb_championship",
  "training",
  "meeting",
  "custom",
];

async function createEvent(actorId, clanId, payload = {}) {
  const clan = await Clan.findById(clanId);
  if (!clan || clan.status !== "active") throw new ApiError("Clan not available", 404);
  const actor = await ClanMember.findOne({ clan: clanId, user: actorId }).lean();
  if (!actor) throw new ApiError("You are not a member of this clan", 403);
  const settings = await clanService.getSettings();
  clanPermissionService.assertCan(clan, actor.role, "createEvents", settings);

  const type = EVENT_TYPES.includes(payload.type) ? payload.type : "custom";
  const scheduledAt = payload.scheduledAt ? new Date(payload.scheduledAt) : null;
  if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
    throw new ApiError("Valid scheduledAt required", 400);
  }
  const event = await ClanEvent.create({
    clan: clanId,
    createdBy: actorId,
    type,
    title: String(payload.title || "").trim().slice(0, 80) || "Clan Event",
    description: String(payload.description || "").slice(0, 500),
    game: ["poker", "trix", "tarneeb41"].includes(payload.game) ? payload.game : null,
    scheduledAt,
    attendees: [actorId],
  });

  // Notify all members (bounded by maxMembers).
  const members = await ClanMember.find({ clan: clanId }).select("user").lean();
  for (const m of members) {
    if (String(m.user) === String(actorId)) continue;
    clanMembershipService.notify(m.user, {
      title: "فعالية جديدة في العشيرة",
      subtitle: event.title,
      icon: "calendar",
      sourceType: "clan_event",
      sourceId: String(event._id),
      meta: { clanId: String(clanId), eventId: String(event._id) },
    });
  }
  clanRealtime.emitToClan(clanId, "clan:event_new", {
    eventId: String(event._id),
    title: event.title,
    scheduledAt: event.scheduledAt,
  });
  chatService
    .sendSystemMessage({
      channel: "clan",
      channelId: clanId,
      actorId,
      body: `📅 فعالية جديدة: ${event.title}`,
      meta: { event: "clan_event", eventId: String(event._id) },
    })
    .catch(() => {});
  return serialize(event);
}

async function listEvents(clanId, { upcoming = false } = {}) {
  const filter = { clan: clanId };
  if (upcoming) {
    filter.scheduledAt = { $gte: new Date() };
    filter.status = { $in: ["scheduled", "live"] };
  }
  const rows = await ClanEvent.find(filter).sort({ scheduledAt: 1 }).limit(50).lean();
  return rows.map(serialize);
}

async function rsvp(userId, eventId, attending = true) {
  const event = await ClanEvent.findById(eventId);
  if (!event) throw new ApiError("Event not found", 404);
  const member = await ClanMember.findOne({ clan: event.clan, user: userId }).lean();
  if (!member) throw new ApiError("You are not a member of this clan", 403);
  if (attending) {
    await ClanEvent.updateOne({ _id: eventId }, { $addToSet: { attendees: userId } });
  } else {
    await ClanEvent.updateOne({ _id: eventId }, { $pull: { attendees: userId } });
  }
  return { status: attending ? "attending" : "declined" };
}

async function cancelEvent(actorId, eventId) {
  const event = await ClanEvent.findById(eventId);
  if (!event) throw new ApiError("Event not found", 404);
  const clan = await Clan.findById(event.clan);
  const actor = await ClanMember.findOne({ clan: event.clan, user: actorId }).lean();
  const settings = await clanService.getSettings();
  const isCreator = String(event.createdBy) === String(actorId);
  if (!actor || (!isCreator && !clanPermissionService.can(clan, actor.role, "createEvents", settings))) {
    throw new ApiError("Not allowed to cancel this event", 403);
  }
  event.status = "cancelled";
  await event.save();
  clanRealtime.emitToClan(event.clan, "clan:event_update", { eventId: String(eventId), status: "cancelled" });
  return { status: "cancelled" };
}

function serialize(e) {
  return {
    id: String(e._id),
    type: e.type,
    title: e.title,
    description: e.description || "",
    game: e.game || null,
    scheduledAt: e.scheduledAt,
    status: e.status,
    attendeeCount: Array.isArray(e.attendees) ? e.attendees.length : 0,
    createdBy: String(e.createdBy),
    createdAt: e.createdAt,
  };
}

module.exports = { createEvent, listEvents, rsvp, cancelEvent };
