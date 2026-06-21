'use strict';

// One-time recovery script: pulls back data from the interrupted first run instead of
// re-paying Apify for creators 1, 2, and 4. Writes preloaded_reels.json, which
// process_pipeline.js will pick up and use to skip already-covered handles.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ApifyClient } = require('apify-client');

const TRANSCRIPT_ACTOR_ID = 'crawlerbros/instagram-transcript-scraper';
const OUTPUT_PATH = path.join(__dirname, 'preloaded_reels.json');

function extractShortCode(url) {
  if (!url) return null;
  const match = url.match(/\/(?:p|reel|tv)\/([^/?]+)/);
  return match ? match[1] : null;
}

function mergeReelData(discoveredReels, transcriptItems) {
  const transcriptByShortCode = new Map();
  for (const item of transcriptItems) {
    const shortCode = item.shortCode || extractShortCode(item.postUrl);
    if (shortCode) transcriptByShortCode.set(shortCode, item);
  }

  return discoveredReels.map((reel) => {
    const match = transcriptByShortCode.get(reel.shortCode);
    const transcript = match && match.fullText && match.fullText.trim().length > 0
      ? match.fullText.trim()
      : null;

    return {
      handle: reel.handle,
      url: reel.url,
      views: reel.views,
      likes: match?.likeCount ?? reel.likes,
      comments: match?.commentCount ?? reel.comments,
      transcript,
      transcriptError: match?.errMsg || (!match ? 'No transcript result was returned for this reel.' : null),
    };
  });
}

function toDiscoveredReel(handle, item) {
  const url = item.url || (item.shortCode ? `https://www.instagram.com/reel/${item.shortCode}/` : null);
  return {
    handle,
    shortCode: item.shortCode || extractShortCode(url),
    url: url || 'N/A',
    views: item.videoViewCount ?? item.videoPlayCount ?? 'N/A',
    likes: item.likesCount ?? 'N/A',
    comments: item.commentsCount ?? 'N/A',
  };
}

async function main() {
  const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN });
  const allReels = [];

  // Creator 1: komalpandeyofficial - discovery + transcript already completed.
  {
    const { items: discoveryItems } = await client.dataset('zgtOpSUF260vMw1tf').listItems();
    const { items: transcriptItems } = await client.dataset('TdwQHRAUSqni64BIf').listItems();
    const discovered = discoveryItems.filter((i) => !i.error).map((i) => toDiscoveredReel('komalpandeyofficial', i));
    allReels.push(...mergeReelData(discovered, transcriptItems));
    console.log(`komalpandeyofficial: ${discovered.length} reels recovered`);
  }

  // Creator 2: thatbohogirl - discovery + transcript already completed.
  {
    const { items: discoveryItems } = await client.dataset('RmwD0flU6ThYwerGF').listItems();
    const { items: transcriptItems } = await client.dataset('qkvbnDYsBJTPdkhG2').listItems();
    const discovered = discoveryItems.filter((i) => !i.error).map((i) => toDiscoveredReel('thatbohogirl', i));
    allReels.push(...mergeReelData(discovered, transcriptItems));
    console.log(`thatbohogirl: ${discovered.length} reels recovered`);
  }

  // Creator 3: stylemeupwithsakshi - confirmed 404 (account not found on Instagram). No reels.
  console.log('stylemeupwithsakshi: 0 reels (account not found on Instagram, confirmed via Apify error item)');

  // Creator 4: juhigodambe - discovery completed, transcript stage never ran. Run it now (native only).
  {
    const { items: discoveryItems } = await client.dataset('zaLuwKbe7PKhr3zUV').listItems();
    const discovered = discoveryItems.filter((i) => !i.error).map((i) => toDiscoveredReel('juhigodambe', i));
    console.log(`juhigodambe: ${discovered.length} reels discovered, running transcript stage (native)...`);

    const run = await client.actor(TRANSCRIPT_ACTOR_ID).call({
      videoUrls: discovered.map((r) => r.url),
      transcriptionMethod: 'native',
      language: '',
      includeSegments: false,
    });
    const { items: transcriptItems } = await client.dataset(run.defaultDatasetId).listItems();
    allReels.push(...mergeReelData(discovered, transcriptItems));
    console.log(`juhigodambe: transcript stage complete`);
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allReels, null, 2));
  console.log(`\nWrote ${allReels.length} recovered reel(s) to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('Rescue failed:', err.message);
  process.exitCode = 1;
});
