#!/usr/bin/env node
// scripts/update-prices.js
//
// Fetches live gold/silver spot quotes from Metal Sentinel (via RapidAPI),
// reads the per-karat/fineness gram prices it already computes for us,
// applies the "sell used / buy new" market estimates from
// config/pricing-rules.js on top, updates prices.json (including its
// rolling 5-day history, refreshed once per calendar day, not every run),
// and regenerates index.html / silver.html from templates/*.template.html
// with the results baked directly into the markup.
//
// PREVIOUSLY used GoldAPI.io — switched to Metal Sentinel for better data
// quality (real ask/bid spreads, real change figures) and a higher free
// quota. See the git history of this file / config/pricing-rules.js if you
// ever need the GoldAPI integration for reference.
//
// RESPONSE SHAPE, confirmed against real calls (do not trust API docs or
// pasted samples over an actual live response — this project has been
// burned by that twice already with the previous provider):
//   GET https://metal-sentinel.p.rapidapi.com/gold-price?currency=USD
//   GET https://metal-sentinel.p.rapidapi.com/silver-price?currency=USD
//   Headers: x-rapidapi-host, x-rapidapi-key (standard RapidAPI auth)
//   Body: { "results": [ { ask, bid, mid, change, changePercentage,
//           open: 0, close: 0 (always — never rely on these two),
//           karat_prices: {"24k","18k","14k","9k"} (gold only — NO 22k/21k),
//           fineness_prices: {"999","958","925","900","800"} (silver only —
//           NO 750) } ] } — the metal data is nested in results[0], not
//   top-level.
// We always fetch ?currency=USD and convert to SAR ourselves with the fixed
// SAMA peg (3.75), the same principle as before: this is a peg, not a
// floating rate, so a live-fetched rate would simulate precision that
// doesn't exist, and it keeps the SAR conversion logic identical regardless
// of which upstream provider is behind it.
//
// Gold's karat_prices is missing 22k/21k (Saudi market karats we need) —
// derived from the real 24k (100%-pure) price using
// pricingRules.GOLD_PURITY_PARTIAL. Silver's fineness_prices has 900 but
// not 750 (our site shows 750, not 900) — 750 is derived from the real 999
// value backed out to a 100%-pure base, using pricingRules.SILVER_PURITY.
// Every other karat/fineness value used comes directly from the API.
//
// IMPORTANT: every buy/sell markup and flat deduction this script applies
// (the "بيع مستعمل / شراء جديد" market-estimate table) comes from
// config/pricing-rules.js and is an ESTIMATE, not live-sourced market data
// (that file's header comment says so too — deliberately repeated here).
//
// Usage: node scripts/update-prices.js   (or: npm run update-prices)
// Requires RAPIDAPI_KEY — set in .env locally, or as a GitHub Actions secret
// in CI. Requires Node 18+ (uses the built-in fetch). 2 API calls per run.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Minimal .env loader (local dev only). No "dotenv" dependency — this repo
// intentionally has zero npm dependencies. In CI, real env vars (GitHub
// Actions secrets) are already set, so this silently no-ops when .env is
// absent, and never overrides an already-set variable.
// ---------------------------------------------------------------------------
function loadDotEnvIfPresent() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    const isQuoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (isQuoted) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnvIfPresent();

const pricingRules = require('../config/pricing-rules');

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'metal-sentinel.p.rapidapi.com';
// Fixed SAMA peg, not a fetched/floating rate — see the top-of-file comment.
const USD_SAR_RATE = parseFloat(process.env.USD_SAR_RATE || '3.75');
const SITE_URL = (process.env.SITE_URL || 'https://your-domain.example').replace(/\/+$/, '');
// Metal Sentinel's karat_prices/fineness_prices are per OUNCE despite their
// names — see extractGoldGramsUsd()/extractSilverGramsUsd() below.
const TROY_OUNCE_GRAMS = 31.1034768;

const PRICES_JSON_PATH = path.join(ROOT, 'prices.json');
const TEMPLATES_DIR = path.join(ROOT, 'templates');

// Which columns each page's history table shows (a subset of the full set —
// matches the <thead> columns already in the HTML templates: gold drops
// 14k, silver drops 750, same "lowest purity omitted" pattern).
const GOLD_HISTORY_KEYS = [24, 22, 21, 18];
const SILVER_HISTORY_KEYS = [999, 958, 925, 800];

// ---------------------------------------------------------------------------
// Arabic date/time formatting (Asia/Riyadh, fixed UTC+3, no DST)
// ---------------------------------------------------------------------------

const AR_WEEKDAYS = {
  Sunday: 'الأحد', Monday: 'الاثنين', Tuesday: 'الثلاثاء', Wednesday: 'الأربعاء',
  Thursday: 'الخميس', Friday: 'الجمعة', Saturday: 'السبت',
};

const AR_MONTHS_BY_NAME = {
  January: 'يناير', February: 'فبراير', March: 'مارس', April: 'أبريل',
  May: 'مايو', June: 'يونيو', July: 'يوليو', August: 'أغسطس',
  September: 'سبتمبر', October: 'أكتوبر', November: 'نوفمبر', December: 'ديسمبر',
};

const AR_MONTHS_BY_INDEX = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

function riyadhDisplayParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Riyadh',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const parts = {};
  for (const part of fmt.formatToParts(date)) parts[part.type] = part.value;
  return parts;
}

function formatArabicDateTime(date) {
  const p = riyadhDisplayParts(date);
  const weekday = AR_WEEKDAYS[p.weekday] || p.weekday;
  const month = AR_MONTHS_BY_NAME[p.month] || p.month;
  const minute = p.minute.length < 2 ? '0' + p.minute : p.minute;
  return {
    dateAr: `${weekday} ${p.day} ${month} ${p.year}`,
    timeAr: `${p.hour}:${minute}`,
    // Short form ("م"/"ص") for compact contexts like the hero clock
    // ("11:42 م"). Do NOT build the long form by gluing a suffix onto this
    // ("م" + "اً" = "ماً", not a real word) — periodAr below is the correct
    // full word ("مساءً"/"صباحاً") for use in a sentence.
    ampmAr: p.dayPeriod === 'PM' ? 'م' : 'ص',
    periodAr: p.dayPeriod === 'PM' ? 'مساءً' : 'صباحاً',
  };
}

// "YYYY-MM-DD" calendar date in Asia/Riyadh — used as the stable key for
// "have we recorded history for today yet?" comparisons. Riyadh has no DST,
// so shifting the UTC timestamp by a fixed +3h and reading it back as UTC
// gives the correct Riyadh wall-clock date without relying on ICU parsing.
function riyadhDateKey(date) {
  const shifted = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

// Full ISO 8601 timestamp with the (always correct, no-DST) +03:00 offset.
function riyadhIsoString(date) {
  const shifted = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return shifted.toISOString().replace('Z', '+03:00');
}

// "22 أغسطس" from a plain "YYYY-MM-DD" calendar-date key (no Date() parsing
// needed or wanted here — it's already a Riyadh-local calendar date).
function formatArabicDayMonth(dateKey) {
  const [, monthStr, dayStr] = dateKey.split('-');
  const day = String(Number(dayStr));
  const month = AR_MONTHS_BY_INDEX[Number(monthStr) - 1];
  return `${day} ${month}`;
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

function formatNumber(value, decimals = 2) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatSigned(value, unit) {
  const sign = value >= 0 ? '+' : '-';
  return `${sign}${formatNumber(Math.abs(value))} ${unit}`;
}

function formatPercent(value) {
  return `${formatNumber(Math.abs(value))}%`;
}

// ---------------------------------------------------------------------------
// Metal Sentinel (RapidAPI)
// ---------------------------------------------------------------------------

// pathSegment: 'gold-price' | 'silver-price'. Returns the unwrapped
// results[0] object — NOT the raw response, which wraps it in
// { ID, results: [...] }. Validates only the fields common to both metals;
// karat_prices/fineness_prices are validated separately (per metal, with a
// more actionable error) in the extract*GramsUsd functions below.
async function fetchMetalQuote(pathSegment) {
  const res = await fetch(`https://${RAPIDAPI_HOST}/${pathSegment}?currency=USD`, {
    headers: {
      'Content-Type': 'application/json',
      'x-rapidapi-host': RAPIDAPI_HOST,
      'x-rapidapi-key': RAPIDAPI_KEY,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Metal Sentinel request failed for ${pathSegment}: ${res.status} ${res.statusText} ${body}`);
  }
  const data = await res.json();
  const result = data.results && data.results[0];
  if (!result) {
    throw new Error(`Metal Sentinel response for ${pathSegment} has no results[0]: ${JSON.stringify(data)}`);
  }
  const requiredFields = ['ask', 'bid', 'mid', 'change', 'changePercentage'];
  const missing = requiredFields.filter((f) => result[f] == null);
  if (missing.length) {
    throw new Error(`Metal Sentinel response for ${pathSegment} is missing field(s) [${missing.join(', ')}]: ${JSON.stringify(result)}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Price calculations — every ADJUSTABLE number comes from pricingRules; the
// gram/karat prices and ounce bid/ask themselves are real Metal Sentinel
// data, except the two gold karats and one silver fineness noted below,
// which the API doesn't provide and we derive from a real base value.
// ---------------------------------------------------------------------------

// GOLD: karat_prices has 24k/18k/14k/9k directly (9k unused by our site).
// 22k/21k aren't provided — derive from the real 24k (100%-pure) price
// using pricingRules.GOLD_PURITY_PARTIAL.
//
// IMPORTANT: karat_prices values are PER OUNCE, not per gram — confirmed by
// the response's own "unit":"OUNCE" field, and by karat_prices["24k"]
// being numerically identical to the top-level "mid" (ounce) price. The
// field name reads like GoldAPI's old per-gram "price_gram_24k" fields but
// isn't one; divide by TROY_OUNCE_GRAMS to get an actual gram price. (This
// was missed initially — the site briefly showed ounce-scale numbers in the
// gram table. Sanity check going forward: gold's gram price should be
// roughly 1/31st of its ounce price.)
function extractGoldGramsUsd(apiData) {
  const kp = apiData.karat_prices;
  if (!kp) {
    throw new Error(`Metal Sentinel gold response has no karat_prices object: ${JSON.stringify(apiData)}`);
  }
  const directFields = { 24: '24k', 18: '18k', 14: '14k' };
  const grams = {};
  for (const [ourKey, apiKey] of Object.entries(directFields)) {
    if (typeof kp[apiKey] !== 'number') {
      throw new Error(
        `Metal Sentinel gold response has no numeric karat_prices["${apiKey}"] (expected for ${ourKey}k). ` +
        `karat_prices keys present: ${Object.keys(kp).join(', ') || '(none)'}.`
      );
    }
    grams[ourKey] = kp[apiKey] / TROY_OUNCE_GRAMS;
  }
  const pureBaseUsd = grams[24];
  for (const [key, ratio] of Object.entries(pricingRules.GOLD_PURITY_PARTIAL)) {
    grams[key] = pureBaseUsd * ratio;
  }
  return grams; // USD per gram, keyed by karat
}

// SILVER: fineness_prices has 999/958/925/900/800 directly (900 unused by
// our site, which shows 750 instead). 750 isn't provided — back out the
// true 100%-pure base from the real 999 (99.9% pure) value, then derive 750
// from that, using pricingRules.SILVER_PURITY.
//
// Same per-OUNCE, not per-gram, gotcha as gold's karat_prices — see that
// comment above. fineness_prices["999"] is numerically close to the
// top-level "mid" (ounce) price, not a ~$2/gram figure.
function extractSilverGramsUsd(apiData) {
  const fp = apiData.fineness_prices;
  if (!fp) {
    throw new Error(`Metal Sentinel silver response has no fineness_prices object: ${JSON.stringify(apiData)}`);
  }
  const directFields = { 999: '999', 958: '958', 925: '925', 800: '800' };
  const grams = {};
  for (const [ourKey, apiKey] of Object.entries(directFields)) {
    if (typeof fp[apiKey] !== 'number') {
      throw new Error(
        `Metal Sentinel silver response has no numeric fineness_prices["${apiKey}"] (expected for ${ourKey}). ` +
        `fineness_prices keys present: ${Object.keys(fp).join(', ') || '(none)'}.`
      );
    }
    grams[ourKey] = fp[apiKey] / TROY_OUNCE_GRAMS;
  }
  const pureBaseUsd = grams[999] / pricingRules.SILVER_PURITY[999];
  grams[750] = pureBaseUsd * pricingRules.SILVER_PURITY[750];
  return grams; // USD per gram, keyed by fineness
}

function computeMetalPrices({ apiData, gramsUsd, buyMarkupMap, usedSellDeductionSar }) {
  const grams = {};
  for (const key of Object.keys(gramsUsd)) {
    const usd = gramsUsd[key];
    grams[key] = { usd, sar: usd * USD_SAR_RATE };
  }

  for (const key of Object.keys(buyMarkupMap)) {
    const markup = buyMarkupMap[key];
    const sar = grams[key].sar;
    grams[key].sellUsedSar = sar - usedSellDeductionSar;
    grams[key].buyNewSar = sar * (1 + markup);
  }

  return {
    ounceUsd: apiData.mid,
    ounceSar: apiData.mid * USD_SAR_RATE,
    // بيع (sell) = bid — what you're paid selling to the market.
    // شراء (buy)  = ask — what you pay buying from the market.
    // Same sell-gets-less/buy-costs-more convention as the gram figures.
    ounceSellSar: apiData.bid * USD_SAR_RATE,
    ounceBuySar: apiData.ask * USD_SAR_RATE,
    grams,
  };
}

// Real day-over-day change from Metal Sentinel, not derived from our own
// prices.json history — more accurate, since it reflects the upstream
// market's actual prior close rather than just whenever our last cron run
// happened to be.
function computeChangeFromApi(apiData) {
  return {
    trend: apiData.change >= 0 ? 'up' : 'down',
    changeSar: apiData.change * USD_SAR_RATE,
    changePercent: apiData.changePercentage,
  };
}

// ---------------------------------------------------------------------------
// prices.json (current snapshot + rolling 5-day history)
// ---------------------------------------------------------------------------

function loadPricesData() {
  try {
    return JSON.parse(fs.readFileSync(PRICES_JSON_PATH, 'utf8'));
  } catch (e) {
    return { gold: { history: [] }, silver: { history: [] } };
  }
}

// History is updated ONCE PER CALENDAR DAY: if today's entry already exists
// (an earlier cron run today already recorded it), this is a no-op — later
// runs on the same day never overwrite today's snapshot.
function updateHistoryOncePerDay(history, todayKey, ounceSar, gramsSarByKey) {
  if (history.some((h) => h.date === todayKey)) return history;
  const entry = { date: todayKey, ounceSar, grams: gramsSarByKey };
  return [entry, ...history].slice(0, 5);
}

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

function trendIconSvgPair(trend) {
  return `<span class="trend-icon-wrap trend-icon-wrap--${trend}" aria-hidden="true">
                  <svg class="trend-icon trend-icon--up" width="1.3em" height="1.3em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" focusable="false"><polyline points="3 17 9.5 10.5 13.5 14.5 21 7"></polyline><polyline points="15 7 21 7 21 13"></polyline></svg>
                  <svg class="trend-icon trend-icon--down" width="1.3em" height="1.3em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" focusable="false"><polyline points="3 7 9.5 13.5 13.5 9.5 21 17"></polyline><polyline points="15 17 21 17 21 11"></polyline></svg>
                </span>`;
}

function buildHistoryRowsHtml(history, keys) {
  return history
    .map((entry, idx) => {
      const olderEntry = history[idx + 1];
      const mainKey = keys[0];
      const trend = olderEntry
        ? (entry.grams[mainKey] >= olderEntry.grams[mainKey] ? 'up' : 'down')
        : 'up';
      const cells = keys
        .map((key, i) => {
          const cls = i === 0 ? 'history-table__cell--main num' : 'num';
          const value = entry.grams[key];
          return `              <td class="${cls}">${value != null ? formatNumber(value) : '—'}</td>`;
        })
        .join('\n');
      return `            <tr>
              <th scope="row" class="history-table__date num">
                <span class="cell-value">
                  ${formatArabicDayMonth(entry.date)}
                  ${trendIconSvgPair(trend)}
                </span>
              </th>
${cells}
            </tr>`;
    })
    .join('\n');
}

// The {{HISTORY_ROWS}} token sits inside an explanatory <!-- --> comment in
// the templates (documenting the row shape for a human reader) immediately
// followed by the bare live token. We need to remove that specific comment
// + token pair, not just the bare token text — the literal string
// "{{HISTORY_ROWS}}" also appears twice more, purely as documentation (the
// head-comment token reference, and inside the explanation comment itself).
//
// This is done with explicit index math, not a regex. An earlier version
// used /<!--[\s\S]*?-->\s*\{\{HISTORY_ROWS\}\}/, which is a real trap: with
// no anchored start, the engine tries matching from the FIRST "<!--" in the
// whole document (the head "GENERATED FILE" comment) and lazily expands
// until it finds *any* "-->" immediately followed by "{{HISTORY_ROWS}}" —
// which is a true match, just the wrong one, since HTML comments don't
// nest and there's exactly one such sequence in the file. That deleted
// everything from the head comment through the entire header/hero/tables,
// not just the small comment meant to be replaced.
function replaceHistoryBlock(html, rowsHtml) {
  const token = '{{HISTORY_ROWS}}';

  // There are three occurrences of this literal string in the template: the
  // head-comment doc reference, the mention inside the explanatory comment
  // itself, and the real live token — only the last one is immediately
  // preceded (aside from whitespace) by a comment close "-->". Scan every
  // occurrence rather than trusting indexOf's first match to be the right one.
  let searchFrom = 0;
  for (;;) {
    const tokenIdx = html.indexOf(token, searchFrom);
    if (tokenIdx === -1) {
      throw new Error('No occurrence of HISTORY_ROWS immediately preceded by a comment close ("-->") was found in template');
    }

    let beforeToken = tokenIdx;
    while (beforeToken > 0 && /\s/.test(html[beforeToken - 1])) beforeToken--;

    if (html.slice(beforeToken - 3, beforeToken) === '-->') {
      const commentStart = html.lastIndexOf('<!--', beforeToken - 3);
      if (commentStart === -1) {
        throw new Error('Could not find the opening "<!--" for the comment preceding HISTORY_ROWS');
      }
      const tokenEnd = tokenIdx + token.length;
      return html.slice(0, commentStart) + rowsHtml + html.slice(tokenEnd);
    }

    searchFrom = tokenIdx + token.length;
  }
}

// Plain {{TOKEN}} -> value substitution for everything else. split/join
// (not a regex .replace) so a value containing "$"-prefixed sequences can
// never be misinterpreted as a replacement pattern.
function renderTokens(html, tokens) {
  let out = html;
  for (const [key, value] of Object.entries(tokens)) {
    out = out.split(`{{${key}}}`).join(String(value));
  }
  return out;
}

// Minimal sitemap.xml — just the two real pages, kept in sync with the same
// dateModified timestamp baked into each page's own JSON-LD.
function buildSitemapXml(entries) {
  const urlEntries = entries
    .map(({ url, lastmod }) => `  <url>\n    <loc>${url}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>\n`;
}

function buildGoldTokens({ computed, change, dateParts, isoNow, priceValidUntil, canonicalUrl }) {
  const g = computed.grams;
  return {
    GOLD_OUNCE_SAR: formatNumber(computed.ounceSar),
    GOLD_OUNCE_USD: formatNumber(computed.ounceUsd),
    GOLD_CHANGE_TREND: change.trend,
    GOLD_CHANGE_PERCENT: formatPercent(change.changePercent),
    GOLD_CHANGE_SAR: formatSigned(change.changeSar, '﷼'),
    LAST_UPDATE_DATE_AR: dateParts.dateAr,
    LAST_UPDATE_TIME_AR: dateParts.timeAr,
    LAST_UPDATE_AMPM_AR: dateParts.ampmAr,
    LAST_UPDATE_PERIOD_AR: dateParts.periodAr,

    GOLD_24K_SAR: formatNumber(g[24].sar), GOLD_24K_USD: formatNumber(g[24].usd), GOLD_24K_TREND: change.trend,
    GOLD_22K_SAR: formatNumber(g[22].sar), GOLD_22K_USD: formatNumber(g[22].usd), GOLD_22K_TREND: change.trend,
    GOLD_21K_SAR: formatNumber(g[21].sar), GOLD_21K_USD: formatNumber(g[21].usd), GOLD_21K_TREND: change.trend,
    GOLD_18K_SAR: formatNumber(g[18].sar), GOLD_18K_USD: formatNumber(g[18].usd), GOLD_18K_TREND: change.trend,
    GOLD_14K_SAR: formatNumber(g[14].sar), GOLD_14K_USD: formatNumber(g[14].usd), GOLD_14K_TREND: change.trend,

    GOLD_OUNCE_SELL_SAR: formatNumber(computed.ounceSellSar),
    GOLD_OUNCE_SELL_TREND: change.trend,
    GOLD_OUNCE_BUY_SAR: formatNumber(computed.ounceBuySar),
    GOLD_OUNCE_BUY_TREND: change.trend,

    GOLD_22K_SELL_USED_SAR: formatNumber(g[22].sellUsedSar), GOLD_22K_BUY_NEW_SAR: formatNumber(g[22].buyNewSar),
    GOLD_21K_SELL_USED_SAR: formatNumber(g[21].sellUsedSar), GOLD_21K_BUY_NEW_SAR: formatNumber(g[21].buyNewSar),
    GOLD_18K_SELL_USED_SAR: formatNumber(g[18].sellUsedSar), GOLD_18K_BUY_NEW_SAR: formatNumber(g[18].buyNewSar),

    DATE_MODIFIED_ISO: isoNow,
    PRICE_VALID_UNTIL: priceValidUntil,
    CANONICAL_URL: canonicalUrl,
    OG_IMAGE_URL: `${SITE_URL}/assets/images/og-image.jpg`,
  };
}

function buildSilverTokens({ computed, change, dateParts, isoNow, priceValidUntil, canonicalUrl }) {
  const g = computed.grams;
  return {
    SILVER_OUNCE_SAR: formatNumber(computed.ounceSar),
    SILVER_OUNCE_USD: formatNumber(computed.ounceUsd),
    SILVER_CHANGE_TREND: change.trend,
    SILVER_CHANGE_PERCENT: formatPercent(change.changePercent),
    SILVER_CHANGE_SAR: formatSigned(change.changeSar, '﷼'),
    LAST_UPDATE_DATE_AR: dateParts.dateAr,
    LAST_UPDATE_TIME_AR: dateParts.timeAr,
    LAST_UPDATE_AMPM_AR: dateParts.ampmAr,
    LAST_UPDATE_PERIOD_AR: dateParts.periodAr,

    SILVER_999_SAR: formatNumber(g[999].sar), SILVER_999_USD: formatNumber(g[999].usd), SILVER_999_TREND: change.trend,
    SILVER_958_SAR: formatNumber(g[958].sar), SILVER_958_USD: formatNumber(g[958].usd), SILVER_958_TREND: change.trend,
    SILVER_925_SAR: formatNumber(g[925].sar), SILVER_925_USD: formatNumber(g[925].usd), SILVER_925_TREND: change.trend,
    SILVER_800_SAR: formatNumber(g[800].sar), SILVER_800_USD: formatNumber(g[800].usd), SILVER_800_TREND: change.trend,
    SILVER_750_SAR: formatNumber(g[750].sar), SILVER_750_USD: formatNumber(g[750].usd), SILVER_750_TREND: change.trend,

    SILVER_OUNCE_SELL_SAR: formatNumber(computed.ounceSellSar),
    SILVER_OUNCE_SELL_TREND: change.trend,
    SILVER_OUNCE_BUY_SAR: formatNumber(computed.ounceBuySar),
    SILVER_OUNCE_BUY_TREND: change.trend,

    SILVER_958_SELL_USED_SAR: formatNumber(g[958].sellUsedSar), SILVER_958_BUY_NEW_SAR: formatNumber(g[958].buyNewSar),
    SILVER_925_SELL_USED_SAR: formatNumber(g[925].sellUsedSar), SILVER_925_BUY_NEW_SAR: formatNumber(g[925].buyNewSar),
    SILVER_800_SELL_USED_SAR: formatNumber(g[800].sellUsedSar), SILVER_800_BUY_NEW_SAR: formatNumber(g[800].buyNewSar),
    SILVER_750_SELL_USED_SAR: formatNumber(g[750].sellUsedSar), SILVER_750_BUY_NEW_SAR: formatNumber(g[750].buyNewSar),

    DATE_MODIFIED_ISO: isoNow,
    PRICE_VALID_UNTIL: priceValidUntil,
    CANONICAL_URL: canonicalUrl,
    OG_IMAGE_URL: `${SITE_URL}/assets/images/og-image.jpg`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!RAPIDAPI_KEY) {
    throw new Error('RAPIDAPI_KEY is not set (copy .env.example to .env locally, or set it as a GitHub Actions secret in CI)');
  }

  const now = new Date();
  const todayKey = riyadhDateKey(now);
  const dateParts = formatArabicDateTime(now);
  const isoNow = riyadhIsoString(now);
  // Generous-but-conservative validity window for the JSON-LD Offer, since
  // prices actually change roughly every 3h in reality.
  const priceValidUntil = riyadhDateKey(new Date(now.getTime() + 24 * 60 * 60 * 1000));

  const data = loadPricesData();
  data.gold = data.gold || { history: [] };
  data.silver = data.silver || { history: [] };
  data.gold.history = data.gold.history || [];
  data.silver.history = data.silver.history || [];

  console.log('Fetching gold from Metal Sentinel...');
  const goldApiData = await fetchMetalQuote('gold-price');
  console.log('Fetching silver from Metal Sentinel...');
  const silverApiData = await fetchMetalQuote('silver-price');

  const goldComputed = computeMetalPrices({
    apiData: goldApiData,
    gramsUsd: extractGoldGramsUsd(goldApiData),
    buyMarkupMap: pricingRules.NEW_BUY_MARKUP,
    usedSellDeductionSar: pricingRules.USED_SELL_DEDUCTION_SAR,
  });
  const silverComputed = computeMetalPrices({
    apiData: silverApiData,
    gramsUsd: extractSilverGramsUsd(silverApiData),
    buyMarkupMap: pricingRules.SILVER_NEW_BUY_MARKUP,
    usedSellDeductionSar: pricingRules.SILVER_USED_SELL_DEDUCTION_SAR,
  });

  const goldChange = computeChangeFromApi(goldApiData);
  const silverChange = computeChangeFromApi(silverApiData);

  const goldGramsSarForHistory = Object.fromEntries(
    GOLD_HISTORY_KEYS.map((k) => [k, goldComputed.grams[k].sar])
  );
  const silverGramsSarForHistory = Object.fromEntries(
    SILVER_HISTORY_KEYS.map((k) => [k, silverComputed.grams[k].sar])
  );

  data.gold.history = updateHistoryOncePerDay(data.gold.history, todayKey, goldComputed.ounceSar, goldGramsSarForHistory);
  data.silver.history = updateHistoryOncePerDay(data.silver.history, todayKey, silverComputed.ounceSar, silverGramsSarForHistory);
  data.gold.current = goldComputed;
  data.silver.current = silverComputed;
  data.lastUpdatedIso = isoNow;
  data.usdSarRate = USD_SAR_RATE;

  const goldTokens = buildGoldTokens({
    computed: goldComputed,
    change: goldChange,
    dateParts,
    isoNow,
    priceValidUntil,
    canonicalUrl: `${SITE_URL}/`,
  });
  const silverTokens = buildSilverTokens({
    computed: silverComputed,
    change: silverChange,
    dateParts,
    isoNow,
    priceValidUntil,
    canonicalUrl: `${SITE_URL}/silver.html`,
  });

  const goldTemplate = fs.readFileSync(path.join(TEMPLATES_DIR, 'index.template.html'), 'utf8');
  const silverTemplate = fs.readFileSync(path.join(TEMPLATES_DIR, 'silver.template.html'), 'utf8');

  const goldRowsHtml = buildHistoryRowsHtml(data.gold.history, GOLD_HISTORY_KEYS);
  const silverRowsHtml = buildHistoryRowsHtml(data.silver.history, SILVER_HISTORY_KEYS);

  const goldHtml = renderTokens(replaceHistoryBlock(goldTemplate, goldRowsHtml), goldTokens);
  const silverHtml = renderTokens(replaceHistoryBlock(silverTemplate, silverRowsHtml), silverTokens);

  const sitemapXml = buildSitemapXml([
    { url: `${SITE_URL}/`, lastmod: isoNow },
    { url: `${SITE_URL}/silver.html`, lastmod: isoNow },
  ]);

  // All output is fully built and validated in memory above before any file
  // is touched. The writes below happen back-to-back with nothing that can
  // throw between them, so a failure anywhere upstream (API errors, a
  // malformed template) never leaves prices.json out of sync with the HTML
  // it's supposed to match — either everything here lands together, or
  // nothing does.
  fs.writeFileSync(PRICES_JSON_PATH, JSON.stringify(data, null, 2) + '\n');
  fs.writeFileSync(path.join(ROOT, 'index.html'), goldHtml);
  fs.writeFileSync(path.join(ROOT, 'silver.html'), silverHtml);
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemapXml);
  console.log(`Wrote ${path.relative(ROOT, PRICES_JSON_PATH)}, index.html, silver.html, sitemap.xml`);
}

main().catch((err) => {
  console.error('update-prices failed:', err.message);
  process.exit(1);
});
