'use strict';

/**
 * config.js
 *
 * Centralized multi-brand blueprint for the agency engine. Each brand owns an isolated
 * subfolder under ./brands/<folder>/ holding its BRAND_GUIDELINES.md, its generated
 * Structured_Retention_Masterpiece.md, and its scraped Competitor_Viral_Shorts_Transcripts.pdf.
 *
 * To onboard a new brand: add an entry to BRANDS, create ./brands/<folder>/BRAND_GUIDELINES.md,
 * and flip ACTIVE_BRAND. Everything else (scrape_shorts_trends.js, generate_retention_library.js,
 * generate_all_scripts.js) reads from this file rather than hardcoding paths or sheet IDs.
 */

const BRANDS = {
  'be-bodywise': {
    folder: 'be-bodywise',
    displayName: 'Be Bodywise',
    productName: 'Be Bodywise Underarm Roll-On',
    coreStrategicFocus: 'Dual-action odor protection + pigmentation treatment',
    searchKeywords: [
      'underarm roll on',
      'underarm care',
      'chemist at play underarm roll on',
      'wish care underarm roll on',
    ],
    // Sheet 1: Category Intelligence Playbook (Pillar 3 + 4 source) - read-only.
    playbookSpreadsheetId: '1ll9n4VubMv_pkvuJBac_9JeOkfo7MRWkiVNwkcs4VJY',
    playbookTabGid: 1293314538,
    // Sheet 2: primary creator tracker - read creator profiles, write the "Script" tab.
    creatorSpreadsheetId: '1oV9M2RnZnNModbhMWScIWDpEbrSnEaqOC6KydMzJqbw',
  },
};

const ACTIVE_BRAND = 'be-bodywise';

const brandConfig = BRANDS[ACTIVE_BRAND];
if (!brandConfig) {
  throw new Error(`Unknown ACTIVE_BRAND "${ACTIVE_BRAND}". Known brands: ${Object.keys(BRANDS).join(', ')}`);
}

module.exports = { ACTIVE_BRAND, brandConfig, BRANDS };
