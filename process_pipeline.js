'use strict';

/**
 * process_pipeline.js
 *
 * Single-stage pipeline: apify/instagram-reel-scraper alone, with includeTranscript: true,
 * returns each reel's URL, view/like/comment counts, caption, AND its native transcript
 * (when Instagram generated one) in one call - no second actor needed.
 *
 * Required environment variables (.env in this folder, never commit it):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL  - service account client_email
 *   GOOGLE_PRIVATE_KEY            - service account private_key (keep the \n escapes)
 *   APIFY_API_TOKEN               - Apify API token
 *
 * The target sheet must be shared with the service account email as a Viewer/Editor.
 *
 * Cost note: includeTranscript is a paid add-on on top of the actor's per-reel charge,
 * billed per minute of audio. It does not filter/skip reels lacking a transcript - reels
 * without one simply come back with an empty transcript and fall back to the caption below.
 *
 * preloaded_reels.json (optional): a checkpoint of reels already fetched in a prior run.
 * When present, the handles listed in its `coveredHandles` are skipped here instead of
 * being re-scraped, and its `reels` are merged into the final PDF as-is.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { ApifyClient } = require('apify-client');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// ---- Fixed parameters from the task spec -----------------------------------------------------

const GOOGLE_SHEET_ID = '1oV9M2RnZnNModbhMWScIWDpEbrSnEaqOC6KydMzJqbw';
const SHEET_TAB_NAME = 'Sheet 1';
const HANDLE_COLUMN_HEADER = 'Handle';

const REEL_SCRAPER_ACTOR_ID = 'apify/instagram-reel-scraper';
const RESULTS_LIMIT_PER_CREATOR = 7;

const OUTPUT_PDF_PATH = path.join(__dirname, 'Influencer_Reels_Transcripts.pdf');
const PRELOADED_REELS_PATH = path.join(__dirname, 'preloaded_reels.json');

const DELAY_BETWEEN_CREATORS_MS = 10_000;

// ---- Env validation ----------------------------------------------------------------------------

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Set it in a .env file in this folder.`
    );
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Step 1: Google Sheet -> list of handles ---------------------------------------------------

async function fetchHandlesFromSheet() {
  const serviceAccountEmail = requireEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  // Private keys are usually stored in .env with literal "\n" sequences; un-escape them.
  const privateKey = requireEnv('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n');

  const jwt = new JWT({
    email: serviceAccountEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, jwt);
  await doc.loadInfo();

  const sheet = doc.sheetsByTitle[SHEET_TAB_NAME];
  if (!sheet) {
    const available = Object.keys(doc.sheetsByTitle).join(', ');
    throw new Error(
      `Tab "${SHEET_TAB_NAME}" not found in the spreadsheet. Available tabs: ${available}`
    );
  }

  await sheet.loadHeaderRow();
  const rows = await sheet.getRows();

  const headers = sheet.headerValues || [];
  if (!headers.includes(HANDLE_COLUMN_HEADER)) {
    throw new Error(
      `Column "${HANDLE_COLUMN_HEADER}" not found. Found columns: ${headers.join(', ')}`
    );
  }

  const handles = rows
    .map((row) => (row.get(HANDLE_COLUMN_HEADER) || '').toString().trim())
    .filter((handle) => handle.length > 0)
    .map((handle) => handle.replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/$/, ''));

  // De-dupe while preserving order.
  return [...new Set(handles)];
}

// ---- Step 2: single-stage scrape (discovery + transcript in one call) --------------------------

async function scrapeHandle(client, handle) {
  console.log(`  -> Scraping @${handle} via ${REEL_SCRAPER_ACTOR_ID} (resultsLimit=${RESULTS_LIMIT_PER_CREATOR}, includeTranscript=true)`);

  const run = await client.actor(REEL_SCRAPER_ACTOR_ID).call({
    username: [handle],
    resultsLimit: RESULTS_LIMIT_PER_CREATOR,
    includeTranscript: true,
    skipPinnedPosts: false,
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  // Failed lookups (e.g. deleted/renamed/private accounts) come back as a single
  // { error: "not_found", ... } item with no real post data - drop those.
  return items
    .filter((item) => !item.error)
    .map((item) => {
      // The exact transcript key isn't documented as a fixed contract, so check the
      // plausible candidates defensively rather than assuming one name.
      const transcriptRaw = item.transcript ?? item.videoTranscript ?? item.audioTranscript ?? item.transcriptText;
      const transcript = typeof transcriptRaw === 'string' && transcriptRaw.trim().length > 0
        ? transcriptRaw.trim()
        : null;

      return {
        handle,
        url: item.url || (item.shortCode ? `https://www.instagram.com/reel/${item.shortCode}/` : 'N/A'),
        views: item.videoViewCount ?? item.videoPlayCount ?? 'N/A',
        likes: item.likesCount ?? 'N/A',
        comments: item.commentsCount ?? 'N/A',
        transcript,
        caption: item.caption || '',
      };
    });
}

// ---- Step 3: PDF compilation ---------------------------------------------------------------------

// PDFKit's built-in fonts (Helvetica etc.) only support WinAnsi/Latin-1 encoding. Several
// creators in this sheet post Hindi/Hinglish/Punjabi/Urdu content, so transcripts routinely
// contain Devanagari, Gurmukhi, or Arabic-script text - rendering that with a Latin-only font
// doesn't error, it just silently draws garbage glyphs. These bundled fonts cover those scripts
// so the real text renders instead of being lost.
const SCRIPT_FONTS = [
  { name: 'Devanagari', file: path.join(__dirname, 'fonts', 'NotoSansDevanagari-Regular.ttf'), test: (code) => code >= 0x0900 && code <= 0x097F },
  { name: 'Gurmukhi', file: path.join(__dirname, 'fonts', 'NotoSansGurmukhi-Regular.ttf'), test: (code) => code >= 0x0A00 && code <= 0x0A7F },
  { name: 'Arabic', file: path.join(__dirname, 'fonts', 'NotoSansArabic-Regular.ttf'), test: (code) => (code >= 0x0600 && code <= 0x06FF) || (code >= 0x0750 && code <= 0x077F) || (code >= 0xFB50 && code <= 0xFDFF) || (code >= 0xFE70 && code <= 0xFEFF) },
];
const DEFAULT_FONT = 'Helvetica';

function registerScriptFonts(doc) {
  for (const script of SCRIPT_FONTS) {
    doc.registerFont(script.name, script.file);
  }
}

function fontForCodePoint(code) {
  for (const script of SCRIPT_FONTS) {
    if (script.test(code)) return script.name;
  }
  return DEFAULT_FONT;
}

// Splits text into runs of consecutive characters that share the same script font. Whitespace
// and punctuation are "neutral" - they stick with whichever script surrounds them instead of
// forcing a font switch for every space, which would otherwise fragment runs constantly.
function splitIntoScriptRuns(text) {
  const runs = [];
  let currentFont = null;
  let currentText = '';

  for (const char of text) {
    const code = char.codePointAt(0);
    const isNeutral = /[\s.,!?'"‘’“”\-:;()]/.test(char);
    const font = isNeutral ? (currentFont || DEFAULT_FONT) : fontForCodePoint(code);

    if (font === currentFont || currentFont === null) {
      currentFont = font;
      currentText += char;
    } else {
      runs.push({ font: currentFont, text: currentText });
      currentFont = font;
      currentText = char;
    }
  }
  if (currentText) runs.push({ font: currentFont, text: currentText });
  return runs;
}

// Renders text that may mix scripts (e.g. Hinglish: English + Devanagari in the same
// transcript) by switching fonts per run instead of stripping the characters PDFKit's
// default font can't draw.
function renderMultiScriptText(doc, text, options) {
  const runs = splitIntoScriptRuns(text);
  runs.forEach((run, index) => {
    const isLast = index === runs.length - 1;
    doc.font(run.font).text(run.text, { ...options, continued: !isLast });
  });
  doc.font(DEFAULT_FONT);
}

function compilePdf(reels, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    registerScriptFonts(doc);
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    if (reels.length === 0) {
      doc.fontSize(14).text('No reels were retrieved for any creator.');
    }

    reels.forEach((reel, index) => {
      if (index > 0) doc.addPage();

      doc
        .fontSize(20)
        .fillColor('#000000')
        .text(`@${reel.handle}`, { underline: true });

      doc.moveDown(0.5);

      doc
        .fontSize(10)
        .fillColor('#444444')
        .text(`Reel URL: ${reel.url}`)
        .text(`Views: ${reel.views}    |    Likes: ${reel.likes}    |    Comments: ${reel.comments}`);

      doc.moveDown(1);

      doc
        .fontSize(12)
        .fillColor('#000000')
        .text('Transcript:', { underline: true });

      doc.moveDown(0.5);

      const body = reel.transcript
        ? reel.transcript
        : `--- [Audio Transcript Not Available for this Reel] ---\n\n${reel.caption || '[No caption available either.]'}`;

      doc.fontSize(11).fillColor('#111111');
      renderMultiScriptText(doc, body, { align: 'left', lineGap: 4 });
    });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// ---- Orchestration ---------------------------------------------------------------------------

async function main() {
  console.log('Step 1/3: Reading creator handles from Google Sheet...');
  const handles = await fetchHandlesFromSheet();
  if (handles.length === 0) {
    throw new Error(`No handles found in the "${HANDLE_COLUMN_HEADER}" column.`);
  }
  console.log(`  Found ${handles.length} handle(s): ${handles.join(', ')}`);

  const apifyToken = requireEnv('APIFY_API_TOKEN');
  const client = new ApifyClient({ token: apifyToken });

  const allReels = [];
  let coveredHandles = new Set();
  if (fs.existsSync(PRELOADED_REELS_PATH)) {
    const preloaded = JSON.parse(fs.readFileSync(PRELOADED_REELS_PATH, 'utf8'));
    coveredHandles = new Set(preloaded.coveredHandles.map((h) => h.toLowerCase()));
    allReels.push(...preloaded.reels);
    console.log(`Loaded ${preloaded.reels.length} preloaded reel(s) from a prior run, skipping: ${preloaded.coveredHandles.join(', ')}`);
  }

  const handlesToScrape = handles.filter((h) => !coveredHandles.has(h.toLowerCase()));

  console.log('Step 2/3: Scraping reels sequentially (one creator at a time)...');
  for (let i = 0; i < handlesToScrape.length; i++) {
    const handle = handlesToScrape[i];
    console.log(`[${i + 1}/${handlesToScrape.length}] @${handle}`);
    try {
      const reels = await scrapeHandle(client, handle);
      allReels.push(...reels);
      console.log(`  Retrieved ${reels.length} reel(s).`);
    } catch (err) {
      console.error(`  Failed to process @${handle}: ${err.message}`);
    }

    const isLast = i === handlesToScrape.length - 1;
    if (!isLast) {
      console.log(`  Waiting ${DELAY_BETWEEN_CREATORS_MS / 1000}s before next creator...`);
      await sleep(DELAY_BETWEEN_CREATORS_MS);
    }
  }

  console.log('Step 3/3: Compiling PDF...');
  await compilePdf(allReels, OUTPUT_PDF_PATH);
  console.log(`Done. Wrote ${allReels.length} reel(s) to ${OUTPUT_PDF_PATH}`);
}

main().catch((err) => {
  console.error('Pipeline failed:', err.message);
  process.exitCode = 1;
});
