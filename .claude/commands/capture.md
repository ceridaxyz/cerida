# /capture — Playwright UI Capture & Replicate

Captures screenshots, HTML, and computed styles from the live Ultramarkets app, then repairs the local implementation to match.

## What to do when this skill is invoked

1. **Run the capture script:**
   ```bash
   node scripts/capture.js [url] 2>&1
   ```
   Default URL is the Elon tweets market page. The user can pass a different URL as an argument.

2. **Read the output files** from `scripts/capture-output/`:
   - `full.png` — full viewport screenshot (read as image)
   - `col-chart.png`, `col-orderbook.png`, `col-trading.png` — column crops
   - `header-area.png`, `bottom-tabs.png`, `navbar.png` — section crops
   - `regions.json` — detected layout regions with positions, colors, sizes
   - `tokens.json` — unique color/font/size combos from the live page
   - `page.html` — first 30kb of the live page HTML
   - `navbar.json` — nav element HTML + computed styles

3. **Compare each screenshot** against the current local implementation by reading the image files.

4. **Identify discrepancies** — list what's wrong (wrong color, wrong size, missing border, wrong font weight, wrong padding, etc.).

5. **Repair the relevant component files** — only fix what doesn't match. Do not add new components or features.

6. **Commit** with a single-line message after repairs are done.

## Notes
- The script needs Playwright installed: `npm install -D playwright` + `npx playwright install chromium`
- If the page needs auth or has paywalls, note it and use the last known good URL
- Cap repairs to what's visible in the screenshots — don't speculate about hidden state
