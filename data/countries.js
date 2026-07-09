/**
 * Canonical country list for the agent deposit system.
 * `code` is stored on AgentProfile.deposit.countries and DepositTicket.country.
 */
const COUNTRIES = Object.freeze([
  { code: "SY", nameAr: "سوريا", flag: "🇸🇾", currency: "SYP" },
  { code: "LB", nameAr: "لبنان", flag: "🇱🇧", currency: "LBP" },
  { code: "JO", nameAr: "الأردن", flag: "🇯🇴", currency: "JOD" },
  { code: "IQ", nameAr: "العراق", flag: "🇮🇶", currency: "IQD" },
  { code: "EG", nameAr: "مصر", flag: "🇪🇬", currency: "EGP" },
  { code: "SA", nameAr: "السعودية", flag: "🇸🇦", currency: "SAR" },
  { code: "AE", nameAr: "الإمارات", flag: "🇦🇪", currency: "AED" },
  { code: "KW", nameAr: "الكويت", flag: "🇰🇼", currency: "KWD" },
  { code: "QA", nameAr: "قطر", flag: "🇶🇦", currency: "QAR" },
  { code: "BH", nameAr: "البحرين", flag: "🇧🇭", currency: "BHD" },
  { code: "OM", nameAr: "عُمان", flag: "🇴🇲", currency: "OMR" },
  { code: "PS", nameAr: "فلسطين", flag: "🇵🇸", currency: "ILS" },
  { code: "YE", nameAr: "اليمن", flag: "🇾🇪", currency: "YER" },
  { code: "LY", nameAr: "ليبيا", flag: "🇱🇾", currency: "LYD" },
  { code: "DZ", nameAr: "الجزائر", flag: "🇩🇿", currency: "DZD" },
  { code: "MA", nameAr: "المغرب", flag: "🇲🇦", currency: "MAD" },
  { code: "TN", nameAr: "تونس", flag: "🇹🇳", currency: "TND" },
  { code: "SD", nameAr: "السودان", flag: "🇸🇩", currency: "SDG" },
  { code: "TR", nameAr: "تركيا", flag: "🇹🇷", currency: "TRY" },
  { code: "DE", nameAr: "ألمانيا", flag: "🇩🇪", currency: "EUR" },
]);

const COUNTRY_CODES = new Set(COUNTRIES.map((c) => c.code));

function findCountry(code) {
  return COUNTRIES.find((c) => c.code === String(code || "").toUpperCase()) || null;
}

module.exports = { COUNTRIES, COUNTRY_CODES, findCountry };
