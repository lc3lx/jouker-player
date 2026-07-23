/**
 * Bot system shared config: the seed catalog (names/avatars/bios/…), personality
 * & skill tuning tables, and localized chat lines. Static, code-level defaults;
 * admin-tunable global knobs live in models/botSettingsModel.js, and per-bot
 * overrides live on User.bot. Kept dependency-free so any layer can require it.
 */

const PERSONALITIES = [
  "aggressive",
  "passive",
  "funny",
  "silent",
  "professional",
  "risky",
  "beginner",
  "veteran",
];

const SKILLS = ["easy", "normal", "hard", "expert"];

/**
 * Per-personality behavior multipliers (applied to the EXISTING decision
 * thresholds — not a rewrite). raiseMul/bluffMul scale raise/bluff frequency;
 * callBias shifts call-vs-fold; timingScale scales think delay; chat/emojiMul
 * scale social frequency; leadAggro shifts card-game lead aggressiveness [-1..1].
 */
const PERSONALITY_TUNING = {
  aggressive:   { raiseMul: 1.8, bluffMul: 2.0, callBias: 1.05, timingScale: 0.8, chatMul: 1.0, emojiMul: 1.2, leadAggro: 0.6 },
  passive:      { raiseMul: 0.4, bluffMul: 0.3, callBias: 1.15, timingScale: 1.25, chatMul: 0.7, emojiMul: 0.6, leadAggro: -0.5 },
  funny:        { raiseMul: 1.1, bluffMul: 1.3, callBias: 1.0, timingScale: 1.0, chatMul: 2.2, emojiMul: 2.5, leadAggro: 0.1 },
  silent:       { raiseMul: 1.0, bluffMul: 0.8, callBias: 1.0, timingScale: 1.1, chatMul: 0.05, emojiMul: 0.1, leadAggro: 0.0 },
  professional: { raiseMul: 1.0, bluffMul: 0.7, callBias: 0.95, timingScale: 0.9, chatMul: 0.6, emojiMul: 0.4, leadAggro: 0.2 },
  risky:        { raiseMul: 2.1, bluffMul: 2.4, callBias: 1.2, timingScale: 0.7, chatMul: 1.1, emojiMul: 1.4, leadAggro: 0.8 },
  beginner:     { raiseMul: 0.7, bluffMul: 0.6, callBias: 1.25, timingScale: 1.4, chatMul: 0.9, emojiMul: 1.0, leadAggro: -0.3 },
  veteran:      { raiseMul: 1.15, bluffMul: 1.0, callBias: 0.9, timingScale: 0.85, chatMul: 0.8, emojiMul: 0.7, leadAggro: 0.3 },
};

/**
 * Per-skill quality. mistakeRate = chance of a deliberately sub-optimal choice
 * (card games); tightness scales how much trash is folded (poker). expert = the
 * current optimal behavior (mistakeRate 0).
 */
const SKILL_TUNING = {
  easy:   { mistakeRate: 0.35, tightness: 0.7 },
  normal: { mistakeRate: 0.18, tightness: 0.9 },
  hard:   { mistakeRate: 0.07, tightness: 1.05 },
  expert: { mistakeRate: 0.0, tightness: 1.2 },
};

/** Localized, personality-flavored one-liners. Never spammed; picked at random. */
const CHAT_LINES = {
  en: {
    generic: ["Good luck!", "Hello everyone.", "Nice hand!", "Well played.", "Close game.", "Good game."],
    aggressive: ["Bring it on.", "All day.", "Try me."],
    funny: ["Oops 😅", "Lucky river!", "You got me 😂", "Dealer loves you today."],
    professional: ["Well played.", "Solid line.", "gg."],
    veteran: ["Seen it all.", "Patience wins.", "Nice one."],
  },
  ar: {
    generic: ["بالتوفيق!", "مرحباً بالجميع.", "لعبة حلوة!", "أحسنت.", "جولة قوية.", "قيم قيم."],
    aggressive: ["هاتها.", "أنا جاهز.", "جرّبني."],
    funny: ["أوه 😅", "حظ اللحظة الأخيرة!", "أمسكتني 😂", "الموزّع يحبك اليوم."],
    professional: ["أحسنت.", "لعب سليم.", "قيم قيم."],
    veteran: ["شفت كل شيء.", "الصبر يفوز.", "حركة حلوة."],
  },
};

const EMOJIS = ["👍", "🔥", "😎", "😂", "😅", "🎉", "🤔", "👏", "💪", "🍀"];

/**
 * The seed catalog — 20 distinct bot identities. `avatarKey` resolves to a LOCAL
 * managed asset (assets/bots/<key>.png); never an internet URL. `seedKey` makes
 * seeding idempotent. Cosmetics are applied by cosmeticCombo index when available.
 */
const BOT_SEEDS = [
  { seedKey: "bot_01", name: "Khalid", country: "SA", language: "ar", personality: "aggressive",   skill: "hard",   bio: "يلعب من أجل المتعة والإثارة." },
  { seedKey: "bot_02", name: "Sara", country: "AE", language: "ar", personality: "professional", skill: "expert", bio: "محترفة هادئة تحب اللعب الذكي." },
  { seedKey: "bot_03", name: "Omar", country: "EG", language: "ar", personality: "funny",        skill: "normal", bio: "دائماً يضحك على الطاولة." },
  { seedKey: "bot_04", name: "Layla", country: "KW", language: "ar", personality: "veteran",      skill: "expert", bio: "خبرة سنوات في الطاولات." },
  { seedKey: "bot_05", name: "Youssef", country: "JO", language: "ar", personality: "risky",       skill: "normal", bio: "لا يخاف من المخاطرة." },
  { seedKey: "bot_06", name: "Nour", country: "LB", language: "ar", personality: "silent",       skill: "hard",   bio: "يراقب بصمت ويضرب في الوقت المناسب." },
  { seedKey: "bot_07", name: "Ahmed", country: "QA", language: "ar", personality: "passive",      skill: "easy",   bio: "يفضل اللعب الآمن." },
  { seedKey: "bot_08", name: "Maya", country: "BH", language: "ar", personality: "aggressive",   skill: "normal", bio: "تحب الضغط على الخصوم." },
  { seedKey: "bot_09", name: "Alex", country: "US", language: "en", personality: "professional", skill: "hard",   bio: "Calculated and calm." },
  { seedKey: "bot_10", name: "Emma", country: "GB", language: "en", personality: "funny",        skill: "normal", bio: "Here for a good time." },
  { seedKey: "bot_11", name: "Liam", country: "CA", language: "en", personality: "veteran",      skill: "expert", bio: "Old-school grinder." },
  { seedKey: "bot_12", name: "Sofia", country: "ES", language: "en", personality: "risky",       skill: "hard",   bio: "High risk, high reward." },
  { seedKey: "bot_13", name: "Noah", country: "AU", language: "en", personality: "beginner",     skill: "easy",   bio: "Still learning the ropes." },
  { seedKey: "bot_14", name: "Mia", country: "FR", language: "en", personality: "silent",       skill: "normal", bio: "Lets the cards do the talking." },
  { seedKey: "bot_15", name: "Ethan", country: "DE", language: "en", personality: "aggressive",   skill: "expert", bio: "Relentless pressure." },
  { seedKey: "bot_16", name: "Zara", country: "TR", language: "en", personality: "professional", skill: "hard",   bio: "Disciplined and sharp." },
  { seedKey: "bot_17", name: "Adam", country: "MA", language: "ar", personality: "veteran",      skill: "hard",   bio: "صبور ومحنّك." },
  { seedKey: "bot_18", name: "Lina", country: "DZ", language: "ar", personality: "funny",        skill: "easy",   bio: "المرح أولاً." },
  { seedKey: "bot_19", name: "Karim", country: "TN", language: "ar", personality: "risky",       skill: "expert", bio: "يعشق اللعب الكبير." },
  { seedKey: "bot_20", name: "Hana", country: "OM", language: "ar", personality: "passive",      skill: "normal", bio: "تلعب بحذر وذكاء." },
];

/** Managed avatar catalog — LOCAL asset keys only. Admin may extend/edit. */
const AVATAR_CATALOG = Array.from({ length: 20 }, (_, i) => `bot_avatar_${String(i + 1).padStart(2, "0")}`);
const THEME_CATALOG = Array.from({ length: 20 }, (_, i) => `bot_theme_${String(i + 1).padStart(2, "0")}`);

/** Env-backed defaults for the global knobs (BotSettings overrides these). */
const BOT_DEFAULTS = {
  botsEnabled: true,
  maxBotsPerTable: 8,
  minHumansToKeepBots: 1,
  defaultSkill: "normal",
  chatFrequency: 0.18,   // base P(chat) per eligible event
  emojiFrequency: 0.22,  // base P(emoji) per eligible event
  joinDelayMs: Number(process.env.POKER_BOT_FILL_DELAY_MS) || 8000,
  leaveDelayMs: 12000,
  thinkMinMs: 800,
  thinkMaxMs: 3200,
  chatCooldownMs: 15000, // per-bot minimum gap between social messages
  tableChatCooldownMs: 6000, // per-table minimum gap so bots never talk over each other
};

module.exports = {
  PERSONALITIES,
  SKILLS,
  PERSONALITY_TUNING,
  SKILL_TUNING,
  CHAT_LINES,
  EMOJIS,
  BOT_SEEDS,
  AVATAR_CATALOG,
  THEME_CATALOG,
  BOT_DEFAULTS,
};
