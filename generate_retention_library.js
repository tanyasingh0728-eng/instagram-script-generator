'use strict';

/**
 * generate_retention_library.js
 *
 * Reads Competitor_Viral_Shorts_Transcripts.pdf, segments each real transcript into the
 * six-tier script anatomy via Gemini 2.5 Flash, and writes a structured Markdown knowledge
 * base: Structured_Retention_Masterpiece.md.
 *
 * PDF parsing note: extracts with `pdftotext` (plain mode, no -layout - layout mode reflows
 * the per-video cards into a columnar table format that's harder to parse reliably). Requires
 * poppler-utils installed (`brew install poppler`). Parsing was validated against the actual
 * file before writing this: all 79 video cards parsed with sequential ranks matching the PDF's
 * own per-section result counts.
 *
 * Verbatim preservation: the prompt instructs Gemini to segment only, never summarize or
 * paraphrase. Since that's a prompting goal, not an enforceable guarantee, each response is
 * checked by comparing word-overlap between the original transcript and the concatenated
 * segments - if a model drifts from verbatim, the markdown output flags it visibly rather
 * than silently shipping a summarized result as if it were preserved.
 *
 * Required environment variables (.env in this folder):
 *   GEMINI_API_KEY - Google AI Studio API key
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { GoogleGenAI } = require('@google/genai');
const { brandConfig } = require('./config');

const BRAND_DIR = path.join(__dirname, 'brands', brandConfig.folder);
const PDF_PATH = path.join(BRAND_DIR, 'Competitor_Viral_Shorts_Transcripts.pdf');
const MARKDOWN_OUTPUT_PATH = path.join(BRAND_DIR, 'Structured_Retention_Masterpiece.md');
const GEMINI_MODEL = 'gemini-2.5-flash';
const DELAY_BETWEEN_VIDEOS_MS = 1_500;
const VERBATIM_OVERLAP_WARN_THRESHOLD = 0.85;

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

// ---- Step 1: extract + parse the PDF ------------------------------------------------------------

function extractPdfText() {
  return execFileSync('pdftotext', [PDF_PATH, '-'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

function parseVideosFromPdfText(fullText) {
  const firstIdx = fullText.indexOf('Search term: "');
  if (firstIdx === -1) {
    throw new Error('Could not find any "Search term:" sections in the PDF text - is this the right file?');
  }

  const querySections = fullText.slice(firstIdx).split(/(?=Search term: ")/);
  const allVideos = [];

  for (const section of querySections) {
    const queryMatch = section.match(/^Search term: "([^"]+)"/);
    if (!queryMatch) continue;
    const query = queryMatch[1];

    let body = section.slice(queryMatch[0].length);
    const countMatch = body.match(/^\s*(\d+) result\(s\)/);
    const expectedCount = countMatch ? Number(countMatch[1]) : null;
    // Leading '\n' ensures the very first "#1" marker also matches the split regex below -
    // without it, stripping the "N result(s)" line leaves "#1" with no leading newline.
    body = '\n' + body.replace(/^\s*\d+ result\(s\)\s*/, '');

    const blocks = body.split(/\n#(\d+)\n/);
    const videos = [];
    for (let i = 1; i < blocks.length; i += 2) {
      const rank = Number(blocks[i]);
      const content = blocks[i + 1];
      const metaMatch = content.match(/Channel:\s*(.+?)\s*\|\s*Views:\s*([\d,]+)\s*\|\s*(https?:\/\/\S+)/);
      if (!metaMatch) {
        console.warn(`  Could not parse metadata for "${query}" rank ${rank}, skipping.`);
        continue;
      }

      const title = content.slice(0, metaMatch.index).trim();
      const afterMeta = content.slice(metaMatch.index + metaMatch[0].length).trim();
      const noTranscriptMatch = afterMeta.match(/^-+\s*\[Speech Transcript Unavailable\s*\/\s*Visual Loop Only\]\s*-+\s*/i);

      let transcript = null;
      let description = null;
      if (noTranscriptMatch) {
        description = afterMeta.slice(noTranscriptMatch[0].length).trim();
      } else {
        transcript = afterMeta.trim();
      }

      videos.push({ query, rank, title, channelName: metaMatch[1], views: metaMatch[2], url: metaMatch[3], transcript, description });
    }

    if (expectedCount !== null && videos.length !== expectedCount) {
      console.warn(`  WARNING: "${query}" expected ${expectedCount} videos but parsed ${videos.length}.`);
    }
    allVideos.push(...videos);
  }

  return allVideos;
}

// ---- Step 2: Gemini six-tier segmentation -----------------------------------------------------

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    musicOnlyNote: {
      type: 'string',
      description: 'If this transcript is clearly background music/song lyrics rather than spoken commentary about the product/topic, explain that here. Otherwise, empty string.',
    },
    hook: { type: 'string' },
    buildUp: { type: 'string' },
    mainContent: { type: 'string' },
    rehooksOpenLoops: { type: 'string' },
    engagementTactics: { type: 'string' },
    cta: { type: 'string' },
    pacingSpeed: { type: 'string' },
    toneDialect: { type: 'string' },
    curiosityPatterns: { type: 'string' },
    emotionalTriggers: { type: 'string' },
    retentionMechanics: { type: 'string' },
  },
  required: [
    'musicOnlyNote', 'hook', 'buildUp', 'mainContent', 'rehooksOpenLoops', 'engagementTactics', 'cta',
    'pacingSpeed', 'toneDialect', 'curiosityPatterns', 'emotionalTriggers', 'retentionMechanics',
  ],
};

function buildPrompt(video) {
  return `You are dissecting a viral YouTube Short's spoken transcript for a script-engineering knowledge base.

Video: "${video.title}" (Channel: ${video.channelName}, ${video.views} views)

EXACT transcript (verbatim, as auto-captioned - may include multiple languages, e.g. Hindi/Tamil/Malayalam/Gujarati mixed with English):
"""
${video.transcript}
"""

Segment this transcript into six structural categories. CRITICAL RULES:
- Copy the exact words from the transcript verbatim into each category. Do NOT summarize, paraphrase, translate, or truncate.
- Every word in the transcript must appear in exactly one category, in original order, original language/script.
- If a category genuinely has no corresponding text in this script, write exactly: "None identified in this script."
- If this transcript reads as background music/song lyrics unrelated to the stated video topic (a known YouTube auto-caption artifact that picks up background audio), say so in musicOnlyNote and still do your best to segment whatever spoken/sung words exist - do not fabricate a fake product script.

Categories:
1. hook: The opening 0-3 second physical action, overlay text, or verbal shockwave.
2. buildUp: The transition layer bridging the hook into the core logic; identifying the active problem.
3. mainContent: The body explanation, product usage walkthrough, or active value drops.
4. rehooksOpenLoops: Mid-video curiosity injections used to stop the user from dropping off.
5. engagementTactics: Specific verbal prompts, text overlay cues, or interactive questions.
6. cta: The closing follow/save/share action mechanic.

Also provide qualitative analysis (these CAN be your own analytical observations, not verbatim):
- pacingSpeed: e.g. "Ultra-fast chopped", "rhythmic slow-to-fast", "conversational pause-heavy"
- toneDialect: e.g. "Casual authentic bff", "clinical authoritative expert", "witty sarcastic skeptic"
- curiosityPatterns: how information is withheld or teased to create dopamine spikes
- emotionalTriggers: e.g. "social judgment anxiety", "body care relief", "hygiene insecurity validation"
- retentionMechanics: hidden loops or visual-text combos designed to make the user rewatch or read the caption`;
}

function wordOverlapRatio(original, segmentsCombined) {
  const normalize = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);
  const originalWords = normalize(original);
  const segmentWords = new Set(normalize(segmentsCombined));
  if (originalWords.length === 0) return 1;
  const matched = originalWords.filter((w) => segmentWords.has(w)).length;
  return matched / originalWords.length;
}

async function analyzeTranscript(ai, video) {
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: buildPrompt(video),
    config: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  });
  return JSON.parse(response.text);
}

// ---- Step 3: Markdown rendering ----------------------------------------------------------------

function renderVideoHeader(video, index, total) {
  return `## Video ${index} of ${total}: ${video.title}\n\n` +
    `**Channel:** ${video.channelName} &middot; **Views:** ${video.views} &middot; **Source query:** "${video.query}" &middot; **URL:** ${video.url}\n\n`;
}

function renderNoTranscriptEntry(video, index, total) {
  return renderVideoHeader(video, index, total) +
    `**No spoken transcript available - visual loop only.** Caption/description on file:\n\n> ${(video.description || 'No description available either.').replace(/\n/g, '\n> ')}\n\n---\n\n`;
}

function renderAnalyzedEntry(video, index, total, analysis, overlapRatio) {
  let out = renderVideoHeader(video, index, total);

  if (analysis.musicOnlyNote && analysis.musicOnlyNote.trim()) {
    out += `> ⚠️ **Caption note:** ${analysis.musicOnlyNote.trim()}\n\n`;
  }
  if (overlapRatio < VERBATIM_OVERLAP_WARN_THRESHOLD) {
    out += `> ⚠️ **Verbatim check warning:** segmented output only matched ${(overlapRatio * 100).toFixed(0)}% of the original transcript's words - the model may have paraphrased or dropped content instead of preserving it exactly. Review against the source.\n\n`;
  }

  out += '### Script Breakdown\n\n';
  out += `**[HOOK]**\n${analysis.hook}\n\n`;
  out += `**[BUILD-UP]**\n${analysis.buildUp}\n\n`;
  out += `**[MAIN CONTENT]**\n${analysis.mainContent}\n\n`;
  out += `**[REHOOKS / OPEN LOOPS]**\n${analysis.rehooksOpenLoops}\n\n`;
  out += `**[ENGAGEMENT TACTICS]**\n${analysis.engagementTactics}\n\n`;
  out += `**[CTA]**\n${analysis.cta}\n\n`;

  out += '### Qualitative Analysis\n\n';
  out += '| Marker | Analysis |\n';
  out += '|---|---|\n';
  out += `| Pacing & Speed | ${analysis.pacingSpeed} |\n`;
  out += `| Tone & Dialect | ${analysis.toneDialect} |\n`;
  out += `| Curiosity Patterns | ${analysis.curiosityPatterns} |\n`;
  out += `| Emotional Triggers Used | ${analysis.emotionalTriggers} |\n`;
  out += `| Retention Mechanics | ${analysis.retentionMechanics} |\n\n`;
  out += '---\n\n';

  return out;
}

// ---- Orchestration ------------------------------------------------------------------------------

async function main() {
  console.log('Extracting text from PDF...');
  const fullText = extractPdfText();
  const videos = parseVideosFromPdfText(fullText);
  console.log(`Parsed ${videos.length} video(s) from the PDF.`);

  const withTranscript = videos.filter((v) => v.transcript).length;
  console.log(`  ${withTranscript} with real transcripts, ${videos.length - withTranscript} visual-loop-only.`);

  const ai = new GoogleGenAI({ apiKey: requireEnv('GEMINI_API_KEY') });

  const header = `# Structured Retention Masterpiece\n\n` +
    `Six-tier script anatomy + retention analysis for ${videos.length} viral underarm-care YouTube Shorts, ` +
    `sourced from Competitor_Viral_Shorts_Transcripts.pdf. Generated ${new Date().toISOString().slice(0, 10)} via ${GEMINI_MODEL}.\n\n` +
    `---\n\n`;
  fs.writeFileSync(MARKDOWN_OUTPUT_PATH, header);

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    const index = i + 1;
    console.log(`Processing Video ${index} of ${videos.length}...`);

    if (!video.transcript) {
      console.log('  No spoken transcript - writing visual-loop-only entry.');
      fs.appendFileSync(MARKDOWN_OUTPUT_PATH, renderNoTranscriptEntry(video, index, videos.length));
      continue;
    }

    try {
      const analysis = await analyzeTranscript(ai, video);
      const combined = [analysis.hook, analysis.buildUp, analysis.mainContent, analysis.rehooksOpenLoops, analysis.engagementTactics, analysis.cta].join(' ');
      const overlapRatio = wordOverlapRatio(video.transcript, combined);
      if (overlapRatio < VERBATIM_OVERLAP_WARN_THRESHOLD) {
        console.warn(`  Verbatim check: only ${(overlapRatio * 100).toFixed(0)}% word overlap - flagging in output.`);
      }
      fs.appendFileSync(MARKDOWN_OUTPUT_PATH, renderAnalyzedEntry(video, index, videos.length, analysis, overlapRatio));
      console.log('  Done.');
    } catch (err) {
      console.error(`  Failed: ${err.message}`);
      fs.appendFileSync(
        MARKDOWN_OUTPUT_PATH,
        renderVideoHeader(video, index, videos.length) + `**Analysis failed:** ${err.message}\n\n---\n\n`
      );
    }

    const isLast = i === videos.length - 1;
    if (!isLast) await sleep(DELAY_BETWEEN_VIDEOS_MS);
  }

  console.log(`\nDone. Wrote ${MARKDOWN_OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exitCode = 1;
});
