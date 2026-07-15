/** Default store catalog — synced when DB catalog is empty. */

const COUNTRY_SKINS = [
  { assetKey: "skin_algeria", name: "سكن الجزائر", file: "skin/skin_algeria.png" },
  { assetKey: "skin_almorocco", name: "سكن المغرب", file: "skin/skin_almorocco.png" },
  { assetKey: "skin_bahrain", name: "سكن البحرين", file: "skin/skin_bahrain.png" },
  { assetKey: "skin_djibouti", name: "سكن جيبوتي", file: "skin/skin_djibouti.png" },
  { assetKey: "skin_egupt", name: "سكن مصر", file: "skin/skin_egupt.png" },
  { assetKey: "skin_emirates", name: "سكن الإمارات", file: "skin/skin_emirates.png" },
  { assetKey: "skin_iraq", name: "سكن العراق", file: "skin/skin_iraq.png" },
  { assetKey: "skin_jordan", name: "سكن الأردن", file: "skin/skin_jordan.png" },
  { assetKey: "skin_kuwait", name: "سكن الكويت", file: "skin/skin_kuwait.png" },
  { assetKey: "skin_lebanon", name: "سكن لبنان", file: "skin/skin_lebanon.png" },
  { assetKey: "skin_libya", name: "سكن ليبيا", file: "skin/skin_libya.png" },
  { assetKey: "skin_mauritania", name: "سكن موريتانيا", file: "skin/skin_mauritania.png" },
  { assetKey: "skin_oman", name: "سكن عُمان", file: "skin/skin_oman.png" },
  { assetKey: "skin_qatar", name: "سكن قطر", file: "skin/skin_qatar.png" },
  { assetKey: "skin_saudi", name: "سكن السعودية", file: "skin/skin_saudi.png" },
  { assetKey: "skin_somalia", name: "سكن الصومال", file: "skin/skin_somalia.png" },
  { assetKey: "skin_sudan", name: "سكن السودان", file: "skin/skin_sudan.png" },
  { assetKey: "skin_syria", name: "سكن سوريا", file: "skin/skin_syria.png" },
  { assetKey: "skin_tunisia", name: "سكن تونس", file: "skin/skin_tunisia.png" },
  { assetKey: "skin_turkey", name: "سكن تركيا", file: "skin/skin_turkey.png" },
  { assetKey: "skin_yemen", name: "سكن اليمن", file: "skin/skin_yemen.png" },
];

function countrySkinRows() {
  return COUNTRY_SKINS.map((s, i) => ({
    type: "avatar_frame",
    name: s.name,
    assetKey: s.assetKey,
    price: 2500,
    rarity: i < 3 ? "epic" : i < 8 ? "rare" : "common",
    isActive: true,
    featured: i < 4,
    featuredOrder: i,
    /** Public URL path under /assets/ (served from backend/assets). */
    previewImage: s.file,
    promoMeta: { skinFile: s.file },
  }));
}

module.exports = [
  {
    type: "table_theme",
    name: "طاولة خضراء كلاسيكية",
    assetKey: "default",
    price: 0,
    rarity: "common",
    isActive: true,
  },
  {
    type: "table_theme",
    name: "طاولة الملكية الليلية",
    assetKey: "midnight_royal",
    price: 2500,
    rarity: "rare",
    isActive: true,
    featured: true,
    featuredOrder: 2,
  },
  {
    type: "table_theme",
    name: "طاولة المخملية",
    assetKey: "burgundy_velvet",
    price: 5000,
    rarity: "epic",
    isActive: true,
  },
  // Legacy frames kept inactive so country skins become the primary store skins.
  {
    type: "avatar_frame",
    name: "إطار الملك الذهبي",
    assetKey: "royal",
    price: 3500,
    rarity: "epic",
    isActive: false,
  },
  {
    type: "avatar_frame",
    name: "إطار فضي",
    assetKey: "silver",
    price: 1200,
    rarity: "common",
    isActive: false,
  },
  ...countrySkinRows(),
  {
    type: "card_skin",
    name: "أوراق كلاسيكية",
    assetKey: "default",
    price: 0,
    rarity: "common",
    isActive: true,
  },
  {
    type: "card_skin",
    name: "ظهر روبي أحمر",
    assetKey: "ruby",
    price: 1500,
    rarity: "rare",
    isActive: true,
    featured: true,
    featuredOrder: 3,
    promoMeta: {
      discountPercent: 15,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    },
  },
];

module.exports.COUNTRY_SKINS = COUNTRY_SKINS;
