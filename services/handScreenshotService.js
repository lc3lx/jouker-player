const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const HandScreenshot = require("../models/handScreenshotModel");
const HandHistory = require("../models/handHistoryModel");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "hand-screenshots");

function ensureDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

function formatCard(c) {
  if (!c || typeof c !== "string") return "??";
  return c;
}

function buildSvgSnapshot(meta) {
  const lines = [];
  const push = (y, text, size = 22, bold = false) => {
    lines.push(
      `<text x="40" y="${y}" font-family="Arial,sans-serif" font-size="${size}" font-weight="${bold ? "700" : "400"}" fill="#fff">${text}</text>`
    );
  };

  push(50, `Hand ${meta.handId}`, 28, true);
  push(85, `Table ${meta.tableId} · ${meta.gameType}`, 18);
  push(115, new Date(meta.timestamp).toISOString(), 16);
  push(150, `Pot: ${meta.pot} · Winner: ${meta.winnerNames}`, 20, true);
  push(185, `Hand: ${meta.handCategory || "N/A"}`, 18);
  push(220, `Community: ${(meta.community || []).map(formatCard).join(" ")}`, 18);

  let y = 260;
  for (const s of meta.seats || []) {
    const hole = (s.hole || []).map(formatCard).join(" ");
    push(y, `Seat ${s.seatIndex} ${s.name}: ${s.chipsAfter} chips · ${hole}`, 16);
    y += 28;
  }

  const h = Math.max(500, y + 40);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${h}">
  <rect width="100%" height="100%" fill="#0d2818"/>
  <rect x="20" y="20" width="860" height="${h - 40}" rx="16" fill="#143d24" stroke="#c9a227" stroke-width="3"/>
  ${lines.join("\n")}
</svg>`;
}

async function generateHandScreenshot({
  handId,
  handHistoryId,
  tableId,
  gameType = "poker",
  auditHash,
  meta,
}) {
  ensureDir();
  const filename = `${handId}.png`;
  const fullPath = path.join(UPLOAD_DIR, filename);
  const svg = buildSvgSnapshot({
    handId,
    tableId: String(tableId),
    gameType,
    timestamp: meta.timestamp || Date.now(),
    pot: meta.pot,
    winnerNames: meta.winnerNames || "—",
    handCategory: meta.handCategory,
    community: meta.community,
    seats: meta.seats,
  });

  const img = sharp(Buffer.from(svg));
  const info = await img.png().toFile(fullPath);
  const publicUrl = `/uploads/hand-screenshots/${filename}`;

  const doc = await HandScreenshot.findOneAndUpdate(
    { handId },
    {
      $set: {
        handHistory: handHistoryId,
        table: tableId,
        gameType,
        storageProvider: "local",
        storageKey: filename,
        publicUrl,
        width: info.width,
        height: info.height,
        snapshotMeta: meta,
        auditHash: auditHash || null,
      },
    },
    { upsert: true, new: true }
  );

  if (handHistoryId) {
    await HandHistory.findByIdAndUpdate(handHistoryId, {
      $set: { screenshot: doc._id },
    });
  }

  return doc;
}

module.exports = { generateHandScreenshot, buildSvgSnapshot };
