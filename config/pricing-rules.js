// config/pricing-rules.js
//
// Centralizes every price-adjustment constant used by scripts/update-prices.js.
// Everything in this file is an estimate, not live-sourced market data,
// EXCEPT the purity ratio maps at the bottom (those are exact definitions,
// e.g. "18k gold" = 0.75 pure, nothing to verify) — update the estimates
// here, in one place, once real Saudi market figures are available. See
// scripts/update-prices.js for the calculation logic that consumes them.
//
// NOT in this file, because it's real Metal Sentinel API data rather than
// an estimate: most per-karat/fineness gram prices, and the ounce buy/sell
// quotes (real ask/bid). The purity ratio maps below exist only to fill in
// the handful of karats/finenesses that API doesn't provide directly — see
// scripts/update-prices.js's extractGoldGramsUsd / extractSilverGramsUsd.

module.exports = {
  // Flat SAR/gram deduction for "بيع مستعمل" (sell used gold/silver).
  // Applied the same across all karats/purities.
  USED_SELL_DEDUCTION_SAR: 5,

  // Percentage markup for "شراء جديد" (buy new gold) — estimated making
  // charges, not verified market data. Update these if real shop data
  // becomes available.
  NEW_BUY_MARKUP: {
    22: 0.17, // +17%
    21: 0.18, // +18%
    18: 0.34, // +34%
  },

  // Silver has no per-karat markup % supplied yet (unlike gold's
  // NEW_BUY_MARKUP above) — TBD, confirm real figures before treating this
  // as anything but a placeholder. Reuses the same flat/percentage shape as
  // gold so scripts/update-prices.js can share one code path for both
  // metals; only the numbers differ.
  SILVER_NEW_BUY_MARKUP: {
    958: 0.17,
    925: 0.18,
    800: 0.34,
    750: 0.34,
  },

  // Silver's own flat deduction for "بيع مستعمل" — deliberately NOT the same
  // constant as gold's USED_SELL_DEDUCTION_SAR above. Silver gram prices are
  // roughly 1-6 SAR vs gold's ~270-464 SAR; reusing gold's flat 5 SAR
  // deduction pushed silver's sell-used price below zero. Placeholder —
  // confirm a real figure before relying on this.
  SILVER_USED_SELL_DEDUCTION_SAR: 0.5,

  // Gold purity ratios for the TWO karats Metal Sentinel's karat_prices
  // does NOT provide (it has 24k/18k/14k/9k; the Saudi market needs 22k and
  // 21k too). Applied to the real 24k (100%-pure) price to derive these —
  // see extractGoldGramsUsd() in scripts/update-prices.js. Exact
  // definitions, not estimates.
  GOLD_PURITY_PARTIAL: {
    22: 0.9167,
    21: 0.875,
  },

  // Silver fineness ratios. Metal Sentinel's fineness_prices provides
  // 999/958/925/900/800 directly but not 750 (our site shows 750, not
  // 900) — 750 is derived from the real 999 value backed out to a
  // 100%-pure base, using this ratio. The other four keys here exist for
  // reference/documentation but aren't currently used for derivation since
  // the API provides them directly — see extractSilverGramsUsd(). Exact
  // definitions, not estimates ("999 silver" means 0.999 pure).
  SILVER_PURITY: {
    999: 0.999,
    958: 0.958,
    925: 0.925,
    800: 0.8,
    750: 0.75,
  },
};
