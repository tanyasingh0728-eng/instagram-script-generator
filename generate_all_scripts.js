'use strict';

/**
 * generate_all_scripts.js
 *
 * Multi-brand script factory, driven entirely by config.js's active brand: pulls Pillar 3/4
 * framework rules from that brand's Category Intelligence sheet, creator profiles from that
 * brand's tracker, and that brand's local BRAND_GUIDELINES.md + Structured_Retention_Masterpiece.md
 * (under ./brands/<folder>/), then generates one script per creator via Gemini 2.5 Flash and
 * writes the results into a "Script" tab on the tracker.
 *
 * Required environment variables (.env in this folder):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL  - service account client_email (needs Editor on the tracker sheet)
 *   GOOGLE_PRIVATE_KEY            - service account private_key
 *   GEMINI_API_KEY                - Google AI Studio API key
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { GoogleGenAI } = require('@google/genai');
const { brandConfig } = require('./config');

const BRAND_DIR = path.join(__dirname, 'brands', brandConfig.folder);
const BRAND_GUIDELINES_PATH = path.join(BRAND_DIR, 'BRAND_GUIDELINES.md');
const RETENTION_LIBRARY_PATH = path.join(BRAND_DIR, 'Structured_Retention_Masterpiece.md');

const SCRIPT_TAB_NAME = 'Script';
const SCRIPT_TAB_HEADERS = ['Creator handle', 'Instagram URL', 'Script'];

const GEMINI_MODEL = 'gemini-2.5-flash';
const MIN_DELAY_MS = 3_000;
const MAX_DELAY_MS = 5_000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Set it in a .env file in this folder.`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

function buildJwt() {
  return new JWT({
    email: requireEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    key: requireEnv('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// ---- Source 1: Category Playbook (Pillar 3 + 4) -------------------------------------------------

async function fetchPlaybookPillars(jwt) {
  const doc = new GoogleSpreadsheet(brandConfig.playbookSpreadsheetId, jwt);
  await doc.loadInfo();
  const sheet = doc.sheetsById[brandConfig.playbookTabGid];
  if (!sheet) {
    throw new Error(`Tab with gid ${brandConfig.playbookTabGid} not found in the Category Playbook sheet.`);
  }
  await sheet.loadHeaderRow();
  const rows = await sheet.getRows();
  const colKey = sheet.headerValues[0];
  const lines = rows.map((row) => row.get(colKey) || '');

  const findPillarIndex = (n) => lines.findIndex((line) => new RegExp(`PILLAR\\s*${n}\\s*:`, 'i').test(line));
  const pillar3Start = findPillarIndex(3);
  const pillar4Start = findPillarIndex(4);
  const pillar5Start = findPillarIndex(5);
  if (pillar3Start === -1 || pillar4Start === -1) {
    throw new Error('Could not locate PILLAR 3 / PILLAR 4 markers in the Category Playbook sheet.');
  }
  const endIdx = pillar5Start !== -1 ? pillar5Start : lines.length;
  return lines.slice(pillar3Start, endIdx).join('\n');
}

// ---- Source 2: primary creator tracker -----------------------------------------------------------

function extractUrl(profileLinkCell) {
  const match = (profileLinkCell || '').match(/(https?:\/\/[^\s\]\)]+)/);
  return match ? match[1] : (profileLinkCell || 'N/A');
}

async function fetchCreatorRows(jwt, sheetId) {
  const doc = new GoogleSpreadsheet(sheetId, jwt);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle['Sheet 1'];
  if (!sheet) {
    throw new Error(`Tab "Sheet 1" not found. Available: ${Object.keys(doc.sheetsByTitle).join(', ')}`);
  }
  await sheet.loadHeaderRow();
  const rows = await sheet.getRows();
  return { doc, rows };
}

async function getOrCreateScriptTab(doc) {
  let sheet = doc.sheetsByTitle[SCRIPT_TAB_NAME];
  if (!sheet) {
    console.log(`Creating "${SCRIPT_TAB_NAME}" tab...`);
    sheet = await doc.addSheet({ title: SCRIPT_TAB_NAME, headerValues: SCRIPT_TAB_HEADERS });
    return sheet;
  }

  console.log(`Found existing "${SCRIPT_TAB_NAME}" tab - resetting header row and clearing stale rows.`);
  await sheet.clear();
  await sheet.setHeaderRow(SCRIPT_TAB_HEADERS);
  return sheet;
}

// ---- Gemini prompt --------------------------------------------------------------------------------

function buildPrompt({ brandGuidelines, retentionLibrary, playbookPillars, creator }) {
  return `You are writing a ${brandConfig.productName} short-form video script, custom-fit to a specific creator's voice.

=== BRAND GUIDELINES (BRAND_GUIDELINES.md) ===
${brandGuidelines}

=== VIRAL HOOK CADENCE LIBRARY (Structured_Retention_Masterpiece.md - real dissected viral scripts in this category) ===
${retentionLibrary}

=== CATEGORY INTELLIGENCE PLAYBOOK - PILLARS 3 & 4 (competitor vulnerabilities, marketing hooks, education/safety rules) ===
${playbookPillars}

=== THIS CREATOR'S PROFILE ===
Handle: ${creator.handle}
Who the Influencer Is: ${creator.whoTheyAre}
Content Type: ${creator.contentType}
Audience Mindset: ${creator.audienceMindset}
Script Feel & Flow: ${creator.scriptFeelFlow}

CRITICAL SCRIPTING & QUALITY CONSTRAINTS:
- TONALITY & VOICE: Adhere strictly to the "Empathetic Chemist BFF" voice guidelines loaded from BRAND_GUIDELINES.md. Tone must be clinical but accessible, deeply validating, and non-judgmental.
- LANGUAGE: Write in natural, conversational Urban Hinglish or English, mirroring the exact vocabulary choices and dialect quirks defined for this creator in our sheet.
- PLAYBOOK PILLARS 3 & 4 ALIGNMENT: Ground the edutainment sections in the precise competitor vulnerabilities and active ingredient explanations (AHA/BHA) pulled directly from the separate Category Intelligence sheet. Weave in the onboarding safety/patch-test rule cleanly.
- NO AD AESTHETICS: Start completely mid-action. Never use generic intro phrasing like "Hey guys" or state the creator's name.

Please output the final script section-by-section using this exact Dual-Column Markdown Layout table matrix:

---
### 🎬 PRODUCTION SCRIPT FOR: ${creator.handle}
**Target Product**: ${brandConfig.productName}
**Core Strategic Focus**: ${brandConfig.coreStrategicFocus}

| VISUAL ACTION & CAMERA CUES | SPOKEN DIALOGUE / AUDIO TEXT |
| :--- | :--- |
| **[HOOK (0-3s)]** <br> *[Define precise framing, movement, camera angle, and on-screen text overlay here]* | *[Insert highly disruptive, vulnerable, or shocking opening line matching the creator's style]* |
| **[BUILD-UP (4-7s)]** <br> *[Visual transition cue bridging hook to the active underarm problem]* | *[Acknowledge the core daily friction or competitor product failure in a highly relatable way]* |
| **[MAIN CONTENT - PROGRESSIVE EDUTAINMENT]** <br> *[Visual demonstration actions showing the product bottle, correct clean/dry application habit, or text pop-ups]* | *[Explain the active ingredients (AHA/BHA) with simple utility, using concrete examples. Weave in the onboarding safety/patch-test rule here naturally.]* |
| **[MID-VIDEO REHOOK / OPEN LOOP]** <br> *[Sudden visual pattern interrupt or close-up angle switch]* | *[Inject a curiosity trigger to withhold a final realization and stop the viewer from swiping away]* |
| **[CLOSING ACTION / CTA]** <br> *[Natural visual wrap-up or product packing action]* | *[Deliver a high-intent community action prompt focused on saving the video or fixing their routine]* |
---
Analyze the core assets, step into this creator's creative shoes, and stream out their custom script now!`;
}

async function generateScript(ai, promptInputs) {
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: buildPrompt(promptInputs),
  });
  return response.text;
}

// ---- Orchestration ------------------------------------------------------------------------------

async function main() {
  console.log('Reading local brand/retention markdown files...');
  const brandGuidelines = fs.readFileSync(BRAND_GUIDELINES_PATH, 'utf8');
  const retentionLibrary = fs.readFileSync(RETENTION_LIBRARY_PATH, 'utf8');
  console.log(`  BRAND_GUIDELINES.md: ${brandGuidelines.length} chars`);
  console.log(`  Structured_Retention_Masterpiece.md: ${retentionLibrary.length} chars`);

  const jwt = buildJwt();

  console.log('Fetching Pillar 3 & 4 from the Category Intelligence Playbook...');
  const playbookPillars = await fetchPlaybookPillars(jwt);
  console.log(`  Extracted ${playbookPillars.length} chars of playbook text.`);

  console.log('Loading creator tracker...');
  const { doc, rows } = await fetchCreatorRows(jwt, brandConfig.creatorSpreadsheetId);
  console.log(`  Found ${rows.length} creator row(s).`);

  const scriptSheet = await getOrCreateScriptTab(doc);

  const ai = new GoogleGenAI({ apiKey: requireEnv('GEMINI_API_KEY') });

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const handle = row.get('Handle') || 'unknown';
    console.log(`[${i + 1}/${rows.length}] Generating script for ${handle}...`);

    const creator = {
      handle,
      whoTheyAre: row.get('Who the Influencer Is') || '',
      contentType: row.get('Content Type') || '',
      audienceMindset: row.get('Audience Mindset') || '',
      scriptFeelFlow: row.get('Script Feel & Flow') || '',
    };
    const instagramUrl = extractUrl(row.get('Profile Link'));

    try {
      const script = await generateScript(ai, { brandGuidelines, retentionLibrary, playbookPillars, creator });
      if (script.length > 45_000) {
        console.warn(`  WARNING: generated script is ${script.length} chars, approaching the Google Sheets per-cell limit.`);
      }
      await scriptSheet.addRow({
        'Creator handle': handle,
        'Instagram URL': instagramUrl,
        'Script': script,
      });
      console.log('  Saved to Script tab.');
      succeeded++;
    } catch (err) {
      console.error(`  Failed: ${err.message}`);
      failed++;
    }

    const isLast = i === rows.length - 1;
    if (!isLast) {
      const delay = randomDelay();
      console.log(`  Waiting ${(delay / 1000).toFixed(1)}s before next creator...`);
      await sleep(delay);
    }
  }

  console.log(`\nDone. ${succeeded} script(s) saved, ${failed} failed.`);
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exitCode = 1;
});
