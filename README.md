# 🚀 Automated Content Agency Engine

A highly scalable, multi-brand automated pipeline that scrapes viral short-form trends, extracts psychological retention layers, incorporates custom brand tone rules, and dynamically populates influencer-specific production scripts directly back into Google Sheets.

---

## 📂 Project Architecture

```text
instagram-reel-scraper/
├── config.js               # Central switchboard (Active brand & Sheet ID mappings)
├── generate_all_scripts.js # Universal script factory engine (Gemini 2.5 Flash)
├── scrape_shorts_trends.js # Universal short-form scraper
├── .env                    # Local private API keys & credentials (GIT IGNORED)
└── brands/
    └── be-bodywise/        # Isolated campaign vault
        ├── BRAND_GUIDELINES.md
        ├── Structured_Retention_Masterpiece.md
        └── Competitor_Viral_Shorts_Transcripts.pdf
```

---

## 🛠️ Getting Started

```bash
git clone https://github.com/tanyasingh0728-eng/instagram-script-generator.git
cd instagram-reel-scraper
npm install
```

Copy `.env.example` to `.env` and fill in your own credentials:

```bash
cp .env.example .env
```

Required environment variables:

- `GOOGLE_SERVICE_ACCOUNT_EMAIL` — Google service account email
- `GOOGLE_PRIVATE_KEY` — Google service account private key
- `APIFY_API_TOKEN` — Apify API token for scraping
