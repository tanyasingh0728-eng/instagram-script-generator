'use strict';

/**
 * populate_creator_profiles.js
 *
 * For each creator already scraped (preloaded_reels.json), sends their real transcripts -
 * plus the niche/style context already in the sheet - to Gemini 2.5 Flash, and writes back
 * four analysis columns: "Who the Influencer Is", "Content Type", "Audience Mindset",
 * "Script Feel & Flow".
 *
 * Transcripts are read from preloaded_reels.json rather than re-parsing the PDF: PDF text
 * extraction reorders/garbles non-Latin scripts (confirmed earlier - several creators here
 * speak Hindi/Urdu), while preloaded_reels.json is the exact clean data the PDF was built
 * from in the first place.
 *
 * Required environment variables (.env in this folder):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL  - service account client_email (needs Editor on the sheet)
 *   GOOGLE_PRIVATE_KEY            - service account private_key
 *   GEMINI_API_KEY                - Google AI Studio API key
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { GoogleGenAI } = require('@google/genai');

const PRELOADED_REELS_PATH = path.join(__dirname, 'preloaded_reels.json');
const PIPELINE_SCRIPT_PATH = path.join(__dirname, 'process_pipeline.js');
const GEMINI_MODEL = 'gemini-2.5-flash';
const DELAY_BETWEEN_CREATORS_MS = 2_000;

const NEW_COLUMNS = ['Who the Influencer Is', 'Content Type', 'Audience Mindset', 'Script Feel & Flow'];

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

// Reads GOOGLE_SHEET_ID and SHEET_TAB_NAME out of process_pipeline.js's source text, without
// requiring/executing that file (requiring it would immediately kick off a full Apify scrape).
function readSheetConfigFromPipeline() {
  const source = fs.readFileSync(PIPELINE_SCRIPT_PATH, 'utf8');
  const idMatch = source.match(/GOOGLE_SHEET_ID\s*=\s*'([^']+)'/);
  const tabMatch = source.match(/SHEET_TAB_NAME\s*=\s*'([^']+)'/);
  if (!idMatch || !tabMatch) {
    throw new Error('Could not find GOOGLE_SHEET_ID / SHEET_TAB_NAME in process_pipeline.js');
  }
  return { sheetId: idMatch[1], tabName: tabMatch[1] };
}

function normalizeHandle(handle) {
  return (handle || '').toString().trim().replace(/^@/, '').toLowerCase();
}

async function loadSheet() {
  const { sheetId, tabName } = readSheetConfigFromPipeline();
  const jwt = new JWT({
    email: requireEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    key: requireEnv('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const doc = new GoogleSpreadsheet(sheetId, jwt);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle[tabName];
  if (!sheet) {
    throw new Error(`Tab "${tabName}" not found. Available: ${Object.keys(doc.sheetsByTitle).join(', ')}`);
  }
  await sheet.loadHeaderRow();
  return sheet;
}

async function ensureColumnsExist(sheet) {
  const missing = NEW_COLUMNS.filter((c) => !sheet.headerValues.includes(c));
  if (missing.length > 0) {
    await sheet.setHeaderRow([...sheet.headerValues, ...missing]);
    console.log(`Added missing column(s): ${missing.join(', ')}`);
  }
}

function groupReelsByHandle(reels) {
  const byHandle = new Map();
  for (const reel of reels) {
    const key = normalizeHandle(reel.handle);
    if (!byHandle.has(key)) byHandle.set(key, []);
    byHandle.get(key).push(reel);
  }
  return byHandle;
}

function buildPrompt(row, reels) {
  const niche = row.get('Creator Niche') || 'unknown';
  const contentFormat = row.get('Content Format') || 'unknown';
  const language = row.get('Language') || 'unknown';
  const targetAudience = row.get('Target Audience') || 'unknown';
  const styleFeel = row.get('Content Style Feel') || 'unknown';
  const styleInspiration = row.get('Style Inspiration / Liked Creators') || 'unknown';
  const transformation = row.get('Desired Viewer Transformation') || 'unknown';
  const hooks = row.get('Signature Hooks / Phrases') || 'unknown';

  const transcriptBlock = reels
    .map((reel, i) => {
      const body = reel.transcript || `[no spoken transcript - caption only: ${reel.caption || 'none'}]`;
      return `Reel ${i + 1} (views: ${reel.views}, likes: ${reel.likes}):\n${body}`;
    })
    .join('\n\n');

  return `You are a content strategist analyzing an Instagram creator to brief future scriptwriters.

Creator context already on file (from a research sheet, may be partial):
- Niche: ${niche}
- Content format: ${contentFormat}
- Language: ${language}
- Target audience: ${targetAudience}
- Style/feel: ${styleFeel}
- Style inspiration / liked creators: ${styleInspiration}
- Desired viewer transformation: ${transformation}
- Signature hooks/phrases: ${hooks}

Below are this creator's actual reel transcripts (their real spoken words):

${transcriptBlock}

Based on the actual transcripts above (not just the context), write four fields:

1. "Who the Influencer Is": their identity, core sub-niche, and pacing lane, grounded in how they actually speak in these transcripts.
2. "Content Type": the exact style of reels they make (e.g. transition lookbooks, conversational rants, screen-recording tutorials, aesthetic gym vlogs) - be specific to what's evidenced in the transcripts, not generic.
3. "Audience Mindset": how their target audience thinks - the emotional gap or practical need this creator fills for the urban Indian female consumer.
4. "Script Feel & Flow": practical, retention-focused scripting guidelines - how future scripts should be engineered to match this creator's exact hooks, conversational quirks, and delivery speed, citing specific phrasing patterns you observed.

Each field should be 2-4 sentences, specific and actionable, not generic marketing-speak.`;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    'Who the Influencer Is': { type: 'string' },
    'Content Type': { type: 'string' },
    'Audience Mindset': { type: 'string' },
    'Script Feel & Flow': { type: 'string' },
  },
  required: NEW_COLUMNS,
};

async function analyzeCreator(ai, row, reels) {
  const prompt = buildPrompt(row, reels);
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  });
  return JSON.parse(response.text);
}

async function main() {
  console.log('Loading Google Sheet...');
  const sheet = await loadSheet();
  await ensureColumnsExist(sheet);
  const rows = await sheet.getRows();

  console.log('Loading transcripts from preloaded_reels.json...');
  const preloaded = JSON.parse(fs.readFileSync(PRELOADED_REELS_PATH, 'utf8'));
  const reelsByHandle = groupReelsByHandle(preloaded.reels);

  const ai = new GoogleGenAI({ apiKey: requireEnv('GEMINI_API_KEY') });

  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const handle = normalizeHandle(row.get('Handle'));
    console.log(`[${i + 1}/${rows.length}] @${handle}`);

    const reels = reelsByHandle.get(handle) || [];
    if (reels.length === 0) {
      console.log('  No reels on file for this handle, skipping.');
      skipped++;
      continue;
    }

    try {
      const analysis = await analyzeCreator(ai, row, reels);
      for (const column of NEW_COLUMNS) {
        row.set(column, analysis[column] || '');
      }
      await row.save();
      console.log('  Updated.');
      updated++;
    } catch (err) {
      console.error(`  Failed: ${err.message}`);
    }

    const isLast = i === rows.length - 1;
    if (!isLast) await sleep(DELAY_BETWEEN_CREATORS_MS);
  }

  console.log(`\nDone. Updated ${updated} row(s), skipped ${skipped} (no reel data).`);
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exitCode = 1;
});
