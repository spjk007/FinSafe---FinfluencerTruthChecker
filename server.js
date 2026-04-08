import express from "express";
import { ApifyClient } from 'apify-client';
import cors from "cors";
import dotenv from "dotenv";
import YahooFinance from 'yahoo-finance2';
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const yahooFinance = new YahooFinance();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ── ENV vars ──────────────────────────────────────────────────────────────────
const APIFY_TOKEN      = process.env.APIFY_API_TOKEN;
const COHERE_API_KEY   = process.env.COHERE_API_KEY;
const SERP_API_KEY     = process.env.SERP_API_KEY;
const VT_API_KEY       = process.env.VT_API_KEY;
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_SECRET  = process.env.SUPABASE_SECRET_KEY;
const FINNHUB_KEY      = process.env.FINNHUB_API_KEY;
const SCIRA_API_KEY    = process.env.SCIRA_API_KEY;
const SUPABASE_KEY     = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// ── Clients ───────────────────────────────────────────────────────────────────
const client   = new ApifyClient({ token: APIFY_TOKEN });
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET);

// ── PAGE ROUTES (must be BEFORE express.static) ───────────────────────────────
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "app.html"));
});

app.get("/newsfeed", (req, res) => {
    res.sendFile(path.join(__dirname, "newsfeed.html"));
});

app.get("/blindsimulation", (req, res) => {
    res.sendFile(path.join(__dirname, "blindsimulation.html"));
});

app.get("/about", (req, res) => {
    res.sendFile(path.join(__dirname, "about.html"));
});
app.get("/auth", (req, res) => {
    res.sendFile(path.join(__dirname, "auth.html"));
});

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(__dirname));

// ── /api/config ───────────────────────────────────────────────────────────────
app.get("/api/config", (req, res) => {
    res.json({ finnhubKey: FINNHUB_KEY || null, supabaseUrl: SUPABASE_URL || null });
});

// ── /get-stock-data ───────────────────────────────────────────────────────────
app.post("/get-stock-data", async (req, res) => {
    const { symbol, from, to } = req.body;
    if (!symbol) return res.status(400).json({ error: "symbol is required" });
    try {
        const period1 = new Date(from);
        const period2 = new Date(to);
        period2.setDate(period2.getDate() + 1);
        console.log(`[yahoo] ${symbol}  ${period1.toISOString().split('T')[0]} → ${period2.toISOString().split('T')[0]}`);
        const result = await yahooFinance.chart(symbol, { period1, period2, interval: '1d' });
        const quotes = result?.quotes || [];
        console.log(`[yahoo] ${symbol} got ${quotes.length} quotes`);
        if (!quotes.length) return res.status(404).json({ error: "No data returned" });
        const out = { t: [], o: [], h: [], l: [], c: [], v: [] };
        for (const q of quotes) {
            if (!q.open || !q.close) continue;
            out.t.push(Math.floor(new Date(q.date).getTime() / 1000));
            out.o.push(q.open); out.h.push(q.high); out.l.push(q.low);
            out.c.push(q.close); out.v.push(q.volume || 0);
        }
        if (!out.t.length) return res.status(404).json({ error: "No valid candles" });
        res.json(out);
    } catch (err) {
        console.error(`[yahoo] error for ${symbol}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── /resolve-ticker ───────────────────────────────────────────────────────────
app.post("/resolve-ticker", async (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "query is required" });
    try {
        const results = await yahooFinance.search(query, { quotesCount: 10 });
        const quotes  = (results?.quotes || [])
            .filter(q => q.quoteType === 'EQUITY')
            .sort((a, b) => {
                const aClean = !/[.\-]/.test(a.symbol) ? 0 : 1;
                const bClean = !/[.\-]/.test(b.symbol) ? 0 : 1;
                return aClean - bClean;
            });
        const best = quotes[0];
        if (!best) return res.status(404).json({ error: "No match found" });
        res.json({ symbol: best.symbol, name: best.shortname || best.longname || best.symbol });
    } catch (err) {
        console.error(`[resolve-ticker] error for "${query}":`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── /extract-companies ────────────────────────────────────────────────────────
app.post("/extract-companies", async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "text is required" });
    if (!COHERE_API_KEY) return res.status(500).json({ error: "Cohere key not set" });
    try {
        const prompt = `List every company or stock ticker mentioned in this financial analysis text.
Return ONLY a JSON array. No markdown, no backticks, no explanation.
Format exactly: [{"name":"Company Name","ticker":"SYMBOL"}]
Use empty string "" for ticker if you don't know it. Maximum 5 items.

Text: ${text.substring(0, 3000)}`;

        const r = await fetch("https://api.cohere.com/v1/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${COHERE_API_KEY}` },
            body: JSON.stringify({ model: "command-a-03-2025", message: prompt, temperature: 0.1, max_tokens: 400 })
        });
        const data = await r.json();
        const raw  = data.text || "";
        console.log('[extract-companies] raw:', raw.substring(0, 200));

        let companies = [];
        const strategies = [
            () => JSON.parse(raw.trim()),
            () => JSON.parse(raw.replace(/```[a-z]*\n?|```/g, '').trim()),
            () => { const m = raw.match(/\[\s*\{[\s\S]*?\}\s*\]/); return m ? JSON.parse(m[0]) : null; },
        ];
        for (const fn of strategies) {
            try { const r = fn(); if (Array.isArray(r) && r.length) { companies = r; break; } } catch(e) {}
        }
        if (!companies.length) {
            const nameRe = /"name"\s*:\s*"([^"]+)"/g;
            const tickRe = /"ticker"\s*:\s*"([^"]*)"/g;
            let nm;
            while ((nm = nameRe.exec(raw)) !== null) {
                tickRe.lastIndex = nm.index;
                const tk = tickRe.exec(raw);
                companies.push({ name: nm[1], ticker: (tk && tk.index < nm.index + 150) ? tk[1] : '' });
            }
        }
        res.json({ companies: companies.slice(0, 5) });
    } catch(err) {
        console.error('[extract-companies]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── /save-analysis ────────────────────────────────────────────────────────────
app.post("/save-analysis", async (req, res) => {
    if (!SUPABASE_URL || !SUPABASE_SECRET) {
        return res.status(500).json({ error: "Supabase not configured in .env" });
    }
    try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/finsafe_results`, {
            method: "POST",
            headers: {
                "Content-Type":  "application/json",
                "apikey":        SUPABASE_SECRET,
                "Authorization": `Bearer ${SUPABASE_SECRET}`,
                "Prefer":        "return=minimal"
            },
            body: JSON.stringify(req.body)
        });
        if (!r.ok) {
            const err = await r.text();
            console.error('[supabase] insert error:', err);
            return res.status(500).json({ error: err });
        }
        console.log('[supabase] ✓ saved to finsafe_results');
        res.json({ success: true });
    } catch(err) {
        console.error('[supabase] error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── /get-supabase-key ─────────────────────────────────────────────────────────
app.get("/get-supabase-key", (req, res) => {
    if (!SUPABASE_SECRET) return res.status(500).json({ error: "SUPABASE_SECRET_KEY not set in .env" });
    res.json({ anonKey: SUPABASE_SECRET });
});
// ── /get-supabase-anon-key ────────────────────────────────────────────────────
app.get("/get-supabase-anon-key", (req, res) => {
    if (!SUPABASE_ANON_KEY) return res.status(500).json({ error: "SUPABASE_ANON_KEY not set in .env" });
    res.json({ anonKey: SUPABASE_ANON_KEY });
});
// ── /get-cohere-key ───────────────────────────────────────────────────────────
app.get("/get-cohere-key", (req, res) => {
    if (!COHERE_API_KEY) return res.status(500).json({ error: "Cohere API key not configured" });
    res.json({ apiKey: COHERE_API_KEY });
});

// ── /get-serp-key ─────────────────────────────────────────────────────────────
app.get("/get-serp-key", (req, res) => {
    if (!SERP_API_KEY) return res.status(500).json({ error: "SERP API key not configured" });
    res.json({ apiKey: SERP_API_KEY });
});

// ── /search-news ──────────────────────────────────────────────────────────────
app.post("/search-news", async (req, res) => {
    const { query } = req.body;
    if (!query)        return res.status(400).json({ error: "Query is required" });
    if (!SERP_API_KEY) return res.status(500).json({ error: "SERP API key not configured" });
    try {
        const url  = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${SERP_API_KEY}&tbm=nws&num=5`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || "SerpAPI request failed");
        res.json(data.news_results || []);
    } catch (err) {
        console.error("SerpAPI error:", err.message);
        res.status(500).json({ error: "News search failed: " + err.message });
    }
});

// ── /finnhub-news ─────────────────────────────────────────────────────────────
app.get("/finnhub-news", async (req, res) => {
    if (!FINNHUB_KEY) return res.status(500).json({ error: "Finnhub key not configured" });
    const { category = "general", symbol, from, to } = req.query;
    try {
        let url;
        if (category === "company" && symbol) {
            const f = from || (() => { const d=new Date(); d.setDate(d.getDate()-7); return d.toISOString().split('T')[0]; })();
            const t = to   || new Date().toISOString().split('T')[0];
            url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${f}&to=${t}&token=${FINNHUB_KEY}`;
        } else {
            url = `https://finnhub.io/api/v1/news?category=${encodeURIComponent(category)}&token=${FINNHUB_KEY}`;
        }
        const resp = await fetch(url);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || "Finnhub request failed");
        res.json(Array.isArray(data) ? data : []);
    } catch (err) {
        console.error("Finnhub news error:", err.message);
        res.status(500).json({ error: "Finnhub news failed: " + err.message });
    }
});

// ── /check-website ────────────────────────────────────────────────────────────
app.post("/check-website", async (req, res) => {
    const { url } = req.body;
    if (!url)        return res.status(400).json({ error: "URL is required" });
    if (!VT_API_KEY) return res.status(500).json({ error: "VirusTotal API key not configured" });
    try {
        const urlId  = Buffer.from(url).toString("base64").replace(/=/g, "");
        const resp   = await fetch(`https://www.virustotal.com/api/v3/urls/${urlId}`, {
            headers: { "x-apikey": VT_API_KEY }
        });
        if (resp.status === 404) {
            const submitRes  = await fetch("https://www.virustotal.com/api/v3/urls", {
                method: "POST",
                headers: { "x-apikey": VT_API_KEY, "Content-Type": "application/x-www-form-urlencoded" },
                body: `url=${encodeURIComponent(url)}`
            });
            const submitData = await submitRes.json();
            const analysisId = submitData.data?.id;
            if (!analysisId) return res.json({ safe: null, message: "Could not submit URL for scanning" });
            for (let i = 0; i < 5; i++) {
                await new Promise(r => setTimeout(r, 3000));
                const aRes  = await fetch(`https://www.virustotal.com/api/v3/analyses/${analysisId}`, {
                    headers: { "x-apikey": VT_API_KEY }
                });
                const aData = await aRes.json();
                if (aData.data?.attributes?.status === "completed") {
                    const s = aData.data.attributes.stats;
                    return res.json({ safe: s.malicious===0&&s.suspicious===0, malicious:s.malicious, suspicious:s.suspicious, harmless:s.harmless });
                }
            }
            return res.json({ safe: null, message: "Analysis timed out" });
        }
        const data  = await resp.json();
        const stats = data.data?.attributes?.last_analysis_stats;
        if (!stats) return res.json({ safe: null, message: "No analysis data available" });
        res.json({ safe: stats.malicious===0&&stats.suspicious===0, malicious:stats.malicious, suspicious:stats.suspicious, harmless:stats.harmless });
    } catch (err) {
        console.error("VirusTotal error:", err.message);
        res.status(500).json({ error: "Website check failed: " + err.message });
    }
});

// ── /get-video-data ───────────────────────────────────────────────────────────
// ── /get-video-data ───────────────────────────────────────────────────────────
app.post("/get-video-data", async (req, res) => {
    const { youtubeUrl } = req.body;
    if (!youtubeUrl) return res.status(400).json({ error: "YouTube URL required" });

    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });

    const MAX_RETRIES = 4;
    const RETRY_DELAY_MS = 4000;

    async function runApify(attempt) {
        console.log(`[get-video-data] Attempt ${attempt}/${MAX_RETRIES} for ${videoId}`);

        // ── Start the Apify run via REST (same as fetchTranscript helper) ──────
        const runRes = await fetch(
            `https://api.apify.com/v2/acts/automation-lab~youtube-transcript/runs?token=${APIFY_TOKEN}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    urls: [youtubeUrl],
                    language: "en",
                    includeAutoGenerated: true,
                    mergeSegments: true,
                }),
            }
        );
        if (!runRes.ok) {
            const errText = await runRes.text();
            throw new Error(`Apify failed to start (HTTP ${runRes.status}): ${errText}`);
        }
        const runData = await runRes.json();
        const runId   = runData.data?.id;
        if (!runId) throw new Error("Apify did not return a run ID.");

        console.log(`[get-video-data] Run ID: ${runId} — polling every 5s...`);

        // ── Poll until SUCCEEDED / FAILED / timeout ───────────────────────────
        for (let poll = 1; poll <= 24; poll++) {
            await new Promise(r => setTimeout(r, 5000));

            const statusRes = await fetch(
                `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
            );
            if (!statusRes.ok) {
                console.warn(`[get-video-data] Poll ${poll} HTTP error, skipping`);
                continue;
            }
            const statusData = await statusRes.json();
            const status     = statusData.data?.status;
            console.log(`[get-video-data] Poll ${poll}: ${status}`);

            if (status === "SUCCEEDED") {
                const datasetId = statusData.data?.defaultDatasetId;
                const itemsRes  = await fetch(
                    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&format=json`
                );
                const items = await itemsRes.json();
                if (!items?.length) throw new Error("Apify run succeeded but returned no items.");

                const v          = items[0];
                const transcript = v.fullText || (v.segments || []).map(s => s.text).join(" ") || "";

                // Empty transcript → treat as a retryable failure
                if (!transcript || transcript.trim().length < 50) {
                    throw new Error("Transcript returned was empty or too short.");
                }

                console.log('[get-video-data] available fields:', Object.keys(v));

                // ── Date resolution (same logic as before) ────────────────────
                const thumb = v.thumbnailUrl || v.thumbnail
                    || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;

                let rawUploadDate = v.publishDate || v.uploadDate || v.publishedAt || v.datePublished || null;
                if (!rawUploadDate) {
                    try {
                        console.log(`[date-fallback] Fetching date from YouTube page for ${videoId}`);
                        const pageRes  = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
                            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                        });
                        const pageHtml = await pageRes.text();
                        const patterns = [
                            /"publishDate":"(\d{4}-\d{2}-\d{2})/,
                            /"uploadDate":"(\d{4}-\d{2}-\d{2})/,
                            /itemprop="datePublished" content="(\d{4}-\d{2}-\d{2})/,
                            /"dateText":\{"simpleText":"(\w+ \d+, \d{4})"\}/,
                        ];
                        for (const pat of patterns) {
                            const m = pageHtml.match(pat);
                            if (m) { rawUploadDate = m[1]; console.log(`[date-fallback] found: ${rawUploadDate}`); break; }
                        }
                    } catch(e) { console.warn('[date-fallback] failed:', e.message); }
                }

                let cleanDate = new Date().toISOString().split('T')[0];
                if (rawUploadDate) {
                    const d = new Date(rawUploadDate);
                    if (!isNaN(d.getTime())) cleanDate = d.toISOString().split('T')[0];
                }
                console.log('[get-video-data] uploadDate raw:', rawUploadDate, '→', cleanDate);

                return {
                    channel:    v.channelName || v.author        || "Unknown Channel",
                    date:       cleanDate,
                    title:      v.title       || v.videoTitle    || "Unknown Title",
                    transcript,
                    thumbnail:  thumb,
                    viewCount:  v.viewCount   || v.views         || null,
                    videoId,
                };
            }

            if (status === "FAILED" || status === "ABORTED") {
                // Pull the error message from Apify if available
                const apifyErr = statusData.data?.statusMessage || `Actor run ${status.toLowerCase()}`;
                throw new Error(apifyErr);
            }
            // Any other status (RUNNING, READY, etc.) → keep polling
        }
        throw new Error("Transcript fetch timed out after 2 minutes.");
    }

    // ── Retry loop ────────────────────────────────────────────────────────────
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const result = await runApify(attempt);
            return res.json(result);  // ✅ success — return immediately
        } catch (err) {
            lastError = err;
            console.warn(`[get-video-data] Attempt ${attempt} failed: ${err.message}`);

            // Age-restricted / private → no point retrying, fail fast
            const msg = err.message.toLowerCase();
            if (msg.includes("login") || msg.includes("age") || msg.includes("private")) {
                console.warn(`[get-video-data] Age-restricted / login-required — stopping retries.`);
                break;
            }

            if (attempt < MAX_RETRIES) {
                const wait = RETRY_DELAY_MS * attempt; // 4s, 8s, 12s
                console.log(`[get-video-data] Waiting ${wait}ms before retry ${attempt + 1}…`);
                await new Promise(r => setTimeout(r, wait));
            }
        }
    }

    // All attempts exhausted
    console.error(`[get-video-data] All ${MAX_RETRIES} attempts failed: ${lastError.message}`);
    return res.status(500).json({ error: `Failed after ${MAX_RETRIES} attempts: ${lastError.message}` });
});
// ── /find-social-media ────────────────────────────────────────────────────────
app.post("/find-social-media", async (req, res) => {
    const { profileName } = req.body;
    if (!profileName) return res.status(400).json({ error: "profileName is required" });
    if (!APIFY_TOKEN)  return res.status(500).json({ error: "APIFY_API_TOKEN not set in .env" });
    try {
        console.log(`[social-media-finder] Searching for: ${profileName}`);
        const run = await client.actor('tri_angle/social-media-finder').call({
            profileNames: [profileName],
            socials: ["askfm","discord","facebook","github","instagram","linkedin","medium","pinterest","steam","threads","tiktok","twitch","youtube"]
        });
        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        console.log(`[social-media-finder] ${items.length} results for: ${profileName}`);
        res.json({ profiles: Array.isArray(items) ? items : [] });
    } catch (err) {
        console.error("[social-media-finder] Error:", err.message);
        res.status(500).json({ error: "Social media search failed: " + err.message });
    }
});

// ── helpers ───────────────────────────────────────────────────────────────────
function extractVideoId(url) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=)([^&]+)/,
        /(?:youtu\.be\/)([^?]+)/,
        /(?:youtube\.com\/embed\/)([^/?]+)/
    ];
    for (const p of patterns) {
        const m = url.match(p);
        if (m) return m[1];
    }
    return null;
}

// ── /api/analyze — app.html (Apify + Cohere SSE) ─────────────────────────────
// ── /api/analyze — app.html (Apify polling + Cohere SSE) ─────────────────────
app.post("/api/analyze", async (req, res) => {
    const { videoUrl } = req.body;
    if (!videoUrl)       return res.status(400).json({ error: "YouTube URL required" });
    if (!APIFY_TOKEN)    return res.status(500).json({ error: "APIFY_API_TOKEN missing in .env" });
    if (!COHERE_API_KEY) return res.status(500).json({ error: "COHERE_API_KEY missing in .env" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const videoId = extractVideoId(videoUrl);
        if (!videoId) throw new Error("Invalid YouTube URL");

        send("progress", { step: 1, message: "Starting transcript fetch from YouTube…" });

        const runRes = await fetch(
            `https://api.apify.com/v2/acts/automation-lab~youtube-transcript/runs?token=${APIFY_TOKEN}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ urls: [videoUrl], language: "en", includeAutoGenerated: true, mergeSegments: true }),
            }
        );
        if (!runRes.ok) {
            const err = await runRes.text();
            throw new Error(`Apify failed to start: ${runRes.status} — ${err}`);
        }
        const runData = await runRes.json();
        const runId   = runData.data?.id;
        if (!runId) throw new Error("Apify did not return a run ID.");

        console.log(`[Apify] Run ID: ${runId} — polling every 5s...`);

        let transcript  = null;
        let videoTitle  = "Unknown Video";
        let channelName = "Unknown Channel";

        for (let i = 0; i < 24; i++) {
            await new Promise(r => setTimeout(r, 5000));

            const statusRes  = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
            if (!statusRes.ok) { console.warn(`[Apify] Poll ${i+1} failed`); continue; }
            const statusData = await statusRes.json();
            const status     = statusData.data?.status;

            console.log(`[Apify] Poll ${i+1}: ${status}`);
            send("progress", { step: 1, message: `Fetching transcript… (poll ${i+1}: ${status})` });

            if (status === "SUCCEEDED") {
                const datasetId = statusData.data?.defaultDatasetId;
                const itemsRes  = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&format=json`);
                const items     = await itemsRes.json();
                if (!items?.length) throw new Error("Apify returned no data items.");

                const item  = items[0];
                transcript  = item.fullText || (item.segments || []).map(s => s.text).join(" ") || "";
                videoTitle  = item.title || item.videoTitle || "Unknown Video";
                channelName = item.channelName || item.author || "Unknown Channel";

                if (!transcript) throw new Error("This video has no captions or transcript available.");
                console.log(`[Apify] ✓ Transcript ready: "${videoTitle}" (${transcript.length} chars)`);
                break;

            } else if (status === "FAILED" || status === "ABORTED") {
                throw new Error(`Apify actor run ${status.toLowerCase()}.`);
            }
        }

        if (!transcript) throw new Error("Transcript fetch timed out after 2 minutes.");

        send("progress", { step: 2, message: `Got transcript (${Math.round(transcript.length / 1000)}K chars). Analyzing with Cohere AI…` });

        const cohereRes = await fetch("https://api.cohere.com/v2/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${COHERE_API_KEY}` },
            body: JSON.stringify({
                model: "command-a-03-2025",
                messages: [{
                    role: "user",
                    content: `Video Title: "${videoTitle}"\nChannel: ${channelName}\n\nTranscript:\n${transcript.slice(0, 12000)}\n\nAnalyze this video for someone who has never invested before.\n\nStructure your answer using EXACTLY these markdown headings (include the emoji):\n## 📺 What The YouTuber Is Saying\n## 💰 Realistic Returns\n## ⚠️ Risks They Didn't Mention\n## 🚩 Red Flags\n## 🎓 What Beginners Should Know\n## ✅ Questions To Ask\n\nBe thorough but beginner-friendly. Use bullet points under each heading.`
                }]
            })
        });

        if (!cohereRes.ok) throw new Error(`Cohere error: ${await cohereRes.text()}`);
        const cohereData = await cohereRes.json();
        const analysis   = cohereData.message?.content?.[0]?.text || cohereData.text || null;
        if (!analysis) throw new Error("No analysis returned from Cohere");

        console.log(`[app-analyze] Cohere analysis length: ${analysis.length}`);
        send("result", { success: true, videoTitle, channelName, videoId, transcriptLength: transcript.length, analysis });
        res.end();

    } catch (err) {
        console.error("[app-analyze]", err.message);
        res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
    }
});
// ── /api/chat — app.html (Cohere chatbot) ────────────────────────────────────
app.post("/api/chat", async (req, res) => {
    const { message, chat_history = [] } = req.body;
    if (!message)        return res.status(400).json({ error: "message is required" });
    if (!COHERE_API_KEY) return res.status(500).json({ error: "COHERE_API_KEY missing in .env" });

    try {
        console.log(`[cohere-chat] query: ${message.substring(0, 80)}…`);
        const messages = [
            ...chat_history.map(h => ({ role: h.role, content: h.content })),
            { role: "user", content: message }
        ];
        const cohereRes = await fetch("https://api.cohere.com/v2/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${COHERE_API_KEY}` },
            body: JSON.stringify({
                model: "command-a-03-2025",
                system: "You are FinSafe's AI assistant. Help users understand financial concepts, investment risks, and YouTube financial advice in simple beginner-friendly terms. Focus on Indian markets and investors when relevant. Always remind users you are not a financial advisor and they should consult a SEBI-registered advisor before investing.",
                messages
            })
        });
        if (!cohereRes.ok) throw new Error(`Cohere error: ${await cohereRes.text()}`);
        const data  = await cohereRes.json();
        const reply = data.message?.content?.[0]?.text || data.text || "Sorry, I could not generate a response.";
        console.log(`[cohere-chat] reply length: ${reply.length}`);
        res.json({ reply, citations: [] });
    } catch (err) {
        console.error("[cohere-chat]", err.message);
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================
// ── BLIND SIMULATION ROUTES (/api/blindsim/*) ────────────────────────────────
// =============================================================================

function chunkText(text, chunkSize = 800, overlap = 150) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start += chunkSize - overlap;
  }
  return chunks;
}

async function fetchTranscript(videoUrl) {
  const videoId = extractVideoId(videoUrl);
  if (!videoId) throw new Error("Invalid YouTube URL — could not find a video ID.");
  console.log(`[Apify] Fetching transcript for: ${videoId}`);
  const runRes = await fetch(
    `https://api.apify.com/v2/acts/automation-lab~youtube-transcript/runs?token=${APIFY_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: [videoUrl], language: "en", includeAutoGenerated: true, mergeSegments: true }),
    }
  );
  if (!runRes.ok) {
    const err = await runRes.text();
    throw new Error(`Apify failed to start: ${runRes.status} — ${err}`);
  }
  const runData = await runRes.json();
  const runId = runData.data?.id;
  if (!runId) throw new Error("Apify did not return a run ID.");
  console.log(`[Apify] Run ID: ${runId} — polling every 5s...`);
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
    if (!statusRes.ok) { console.warn(`[Apify] Poll ${i+1} failed`); continue; }
    const statusData = await statusRes.json();
    const status = statusData.data?.status;
    console.log(`[Apify] Poll ${i+1}: ${status}`);
    if (status === "SUCCEEDED") {
      const datasetId = statusData.data?.defaultDatasetId;
      const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&format=json`);
      const items = await itemsRes.json();
      if (!items?.length) throw new Error("Apify returned no data items.");
      const item = items[0];
      const transcript = item.fullText || (item.segments || []).map((s) => s.text).join(" ") || "";
      if (!transcript) throw new Error("This video has no captions or transcript available.");
      const videoTitle  = item.videoTitle  || "Unknown Video";
      const channelName = item.channelName || "Unknown Channel";
      console.log(`[Apify] ✓ Transcript ready: "${videoTitle}" (${transcript.length} chars)`);
      return { transcript, videoTitle, channelName, videoId };
    } else if (status === "FAILED" || status === "ABORTED") {
      throw new Error(`Apify actor run ${status.toLowerCase()}.`);
    }
  }
  throw new Error("Transcript fetch timed out after 2 minutes.");
}

async function summariseWithCohere(transcript, videoTitle, channelName) {
  console.log(`[Cohere] Sending full transcript (${transcript.length} chars) to command-a-03-2025...`);
  const coherePrompt = `You are reading the full transcript of a YouTube investment video.
Video title: "${videoTitle}"
Channel: ${channelName}

Your job is to extract and summarise EVERYTHING that is said in this video so that another AI can later explain it to a beginner. Be extremely thorough. Do not skip anything.

Extract and list the following clearly:

1. MAIN TOPIC: What is the overall topic of this video? What is the YouTuber's main message?

2. EVERY INVESTMENT MENTIONED: List every company name, stock name, mutual fund, ETF, crypto, scheme, or any other investment product mentioned. For each one write exactly what the YouTuber said about it.

3. ALL NUMBERS AND CLAIMS: Every return percentage, profit claim, price target, timeframe, or money amount mentioned. Write the exact claim and who said it.

4. RISKS AND WARNINGS: Every risk, warning, disclaimer, condition, or downside mentioned — even if said briefly.

5. HIDDEN DETAILS: Any mention of fees, charges, commissions, lock-in periods, taxes, sponsored content, affiliate links, referral codes, or conflicts of interest.

6. ADVICE GIVEN: Every specific action the YouTuber tells the viewer to take.

7. FINANCIAL TERMS USED: Every financial word or term used in the video. List each one.

8. OVERALL TONE: Is the YouTuber being realistic or is everything sounding like guaranteed profits?

Full transcript:
---
${transcript}
---

Be exhaustive. Include everything. This summary will be used to educate a beginner investor, so nothing should be left out.`;

  const response = await fetch("https://api.cohere.com/v2/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${COHERE_API_KEY}` },
    body: JSON.stringify({ model: "command-a-03-2025", messages: [{ role: "user", content: coherePrompt }] }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Cohere API error ${response.status}: ${errText}`);
  }
  const data = await response.json();
  const summary = data.message?.content?.[0]?.text || data.text || data.generations?.[0]?.text || null;
  if (!summary) throw new Error("Cohere returned no usable summary.");
  console.log(`[Cohere] ✓ Summary ready (${summary.length} chars)`);
  return summary;
}

async function analyseWithScira(cohereSummary, videoTitle, channelName) {
  console.log(`[Scira] Running final beginner analysis...`);
  const prompt = `You are helping a normal Indian person understand a YouTube investment video.
This person has basic spoken English knowledge only. They have NEVER invested money before. 
Do not use complicated financial words to explain.

YOUR MOST IMPORTANT JOB: Write ONLY in simple English. Every sentence must be so simple that a Class 6 student can read it.

STRICT RULES — break any of these and you have failed:

RULE 1 — NO DIFFICULT WORDS without explanation.
Never use: portfolio, equity, volatility, liquidity, diversification, compounding, derivatives, CAGR, NAV, market cap, bull run, bear market, asset allocation — without explaining each word in the very next sentence using a simple Indian example.
Good: "The video talks about mutual funds. A mutual fund is like a big pot where thousands of people put money together. A trained person uses that pot to buy shares. Whatever profit comes, everyone gets their share back."
Bad: "The YouTuber recommends diversifying your portfolio across equity and debt instruments."

RULE 2 — RUPEES AND INDIAN EXAMPLES ONLY.
Use ₹ always. Never use dollars.
Use Indian examples: SBI Fixed Deposit, Post Office savings, gold at home, kirana shop, chai stall, government job salary, auto-rickshaw loan.

RULE 3 — SHORT SENTENCES ONLY.
Max 2 sentences per point. No long paragraphs.
Write like a WhatsApp message to a friend — short, clear, warm.

RULE 4 — TALK LIKE A HELPFUL OLDER SIBLING.
Warm, honest, caring. Not like a bank manager, news anchor, or finance professor.

RULE 5 — EXPLAIN FROM ZERO.
Never assume the reader knows anything about investing or the stock market.

RULE 6 — ENGLISH ONLY.
No Hindi, Tamil, Telugu, or any other language. 100% simple English only.

Video: "${videoTitle}" by ${channelName}

Below is a detailed summary of the ENTIRE video, prepared by an AI that read the full transcript:
---
${cohereSummary}
---

Now write your analysis in these 6 sections. Follow all rules in every section:

## 📺 What Is This Video About?
In 4-5 very simple sentences, tell what the YouTuber is saying and what they want viewers to do.
Use one Indian real-life comparison to explain the main idea.
Then list EVERY company, stock, mutual fund, or investment mentioned in the video. For each one, write 1-2 simple sentences: what is it, and what did the YouTuber say about it? Explain as if the reader has never heard of it.

## 💰 How Much Money Will You Actually Make? (Honest Numbers)
Take every return or profit claim the YouTuber made and write the honest truth next to it.
Example format: "YouTuber claimed: 40% yearly returns. Honest reality: Most people get around 10-14% per year in good years. In bad years they can lose money."
Then give a simple example in rupees: if someone puts ₹5,000 every month, what might they get after 5 years and 10 years — best case and normal case?
Compare this with what SBI Fixed Deposit gives, so the reader can judge.

## ⚠️ Ways You Could Lose Your Money (Real Risks)
List every risk found in the video. For each risk, write a 2-sentence story about how a normal Indian person could lose money in this situation.
Be honest but not scary.

## 🚩 What The YouTuber Did Not Tell You
Does this person earn money, commission, or referral fees if viewers follow their advice? Say it clearly and simply.
Where are they making investing sound too easy or too guaranteed? Point out each place simply.
List every hidden fee, tax, lock-in period, condition, or catch that was not clearly explained.

## 🎓 Every Difficult Word Explained Simply
List every financial word or term that appeared in this video.
For each word, write exactly 2 sentences: what it means in simple words, and an Indian daily life example.
Format: "[Word]: simple explanation. Indian example."

## ✅ 5 Questions To Ask Yourself Before Investing
Exactly 5 questions. One per line. Short and practical. each question in new line.
These are the questions every beginner must honestly answer before putting money anywhere.

FINAL CHECK: Read every sentence. If it sounds like a finance textbook, news channel, or bank brochure — rewrite it in simpler words. Your reader is a normal Indian person who trusts you. Be their helpful friend.`;

  const response = await fetch("https://api.scira.ai/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": SCIRA_API_KEY },
    body: JSON.stringify({ messages: [{ role: "user", content: prompt }], model: "scira-default" }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Scira API error ${response.status}: ${errText}`);
  }
  const data = await response.json();
  const analysis = data.message || data.response || data.answer || data.text || data.content
    || data.choices?.[0]?.message?.content || (typeof data === "string" ? data : null);
  if (!analysis) throw new Error("Scira returned a response but no usable text was found.");
  console.log(`[Scira] ✓ Analysis ready (${analysis.length} chars)`);
  return analysis;
}

async function embedTexts(texts, inputType = "search_document") {
  const response = await fetch("https://api.cohere.com/v2/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${COHERE_API_KEY}` },
    body: JSON.stringify({ texts, model: "embed-english-v3.0", input_type: inputType, embedding_types: ["float"] }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Cohere embed error ${response.status}: ${err}`);
  }
  const data = await response.json();
  return data.embeddings?.float || data.embeddings;
}

async function saveToSupabase({ videoId, videoTitle, channelName, cohereSummary, analysis, transcript }) {
  console.log(`[Supabase] Saving video metadata...`);
  const { error: videoErr } = await supabase
    .from("videos")
    .upsert({ video_id: videoId, video_title: videoTitle, channel: channelName, summary: cohereSummary, analysis }, { onConflict: "video_id" });
  if (videoErr) throw new Error(`Supabase videos upsert failed: ${videoErr.message}`);
  await supabase.from("video_chunks").delete().eq("video_id", videoId);
  const ragText = `${cohereSummary}\n\n---TRANSCRIPT---\n\n${transcript}`;
  const chunks  = chunkText(ragText, 800, 150);
  console.log(`[Supabase] Embedding ${chunks.length} chunks with Cohere...`);
  const BATCH = 96;
  const rows  = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch      = chunks.slice(i, i + BATCH);
    const embeddings = await embedTexts(batch, "search_document");
    batch.forEach((text, j) => {
      rows.push({ video_id: videoId, video_title: videoTitle, channel: channelName, chunk_index: i + j, content: text, embedding: embeddings[j] });
    });
  }
  const { error: chunkErr } = await supabase.from("video_chunks").insert(rows);
  if (chunkErr) throw new Error(`Supabase chunks insert failed: ${chunkErr.message}`);
  console.log(`[Supabase] ✓ Saved ${rows.length} chunks for video ${videoId}`);
}

async function retrieveChunks(videoId, question, topK = 5) {
  const [queryEmbedding] = await embedTexts([question], "search_query");
  const { data, error } = await supabase.rpc("match_video_chunks", {
    query_embedding: queryEmbedding, match_video_id: videoId, match_count: topK,
  });
  if (error) throw new Error(`Supabase vector search failed: ${error.message}`);
  return data || [];
}

async function generateChatAnswer({ question, ragChunks, history, videoTitle, channelName }) {
  const ragContext  = ragChunks.map((c, i) => `[Chunk ${i+1}]\n${c.content}`).join("\n\n");
  const hasRag      = ragChunks.length > 0;
  const historyText = history.slice(-6).map(h =>
    `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`
  ).join("\n");
  const fullPrompt = `You are FinSafe Assistant — a friendly, honest financial literacy helper for regular Indian people who are new to investing.
The user watched a YouTube video: "${videoTitle}" by "${channelName}" and has a question about it.

RULES:
- Answer using ONLY simple English (Class 6 level)
- Always use rupees (Rs.) and Indian examples
- Be honest about risks — never hype any investment
- Keep answers to 3-5 sentences max unless truly needed
- Never give specific buy/sell advice. Always end with: "Talk to a certified advisor before investing."

${hasRag ? `TRANSCRIPT CONTEXT:\n${ragContext}\n` : ""}
${historyText ? `CONVERSATION SO FAR:\n${historyText}\n` : ""}
USER QUESTION: ${question}`;

  const response = await fetch("https://api.scira.ai/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": SCIRA_API_KEY },
    body: JSON.stringify({ messages: [{ role: "user", content: fullPrompt }], model: "scira-default" }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Scira chat error ${response.status}: ${err}`);
  }
  const data = await response.json();
  const answer = data.message || data.response || data.answer || data.text || data.content
    || data.choices?.[0]?.message?.content || (typeof data === "string" ? data : null);
  if (!answer) throw new Error("Scira returned no answer for chat.");
  return { answer, sourceType: hasRag ? "both" : "web" };
}

// ── /api/blindsim/analyze ─────────────────────────────────────────────────────
app.get("/api/blindsim/analyze", (req, res) => {
  res.status(405).json({ error: "Use POST method for /api/blindsim/analyze" });
});

app.post("/api/blindsim/analyze", async (req, res) => {
  const { videoUrl } = req.body;
  if (!videoUrl)       return res.status(400).json({ error: "YouTube URL is required." });
  if (!APIFY_TOKEN)    return res.status(500).json({ error: "APIFY_API_TOKEN is missing from .env" });
  if (!COHERE_API_KEY) return res.status(500).json({ error: "COHERE_API_KEY is missing from .env" });
  if (!SCIRA_API_KEY)  return res.status(500).json({ error: "SCIRA_API_KEY is missing from .env" });
  if (!SUPABASE_URL)   return res.status(500).json({ error: "SUPABASE_URL is missing from .env" });
  if (!SUPABASE_KEY)   return res.status(500).json({ error: "SUPABASE_SECRET_KEY is missing from .env" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    send("progress", { step: 1, message: "Fetching full video transcript from YouTube..." });
    const { transcript, videoTitle, channelName, videoId } = await fetchTranscript(videoUrl);
    send("progress", { step: 2, message: `Got full transcript (${Math.round(transcript.length / 1000)}K chars). Cohere is reading the entire video now...` });
    const cohereSummary = await summariseWithCohere(transcript, videoTitle, channelName);
    send("progress", { step: 3, message: "Cohere done! Now creating your beginner-friendly explanation with Scira AI..." });
    const analysis = await analyseWithScira(cohereSummary, videoTitle, channelName);
    send("progress", { step: 4, message: "Analysis ready! Saving to database so you can ask questions..." });
    await saveToSupabase({ videoId, videoTitle, channelName, cohereSummary, analysis, transcript });
    send("result", { success: true, videoTitle, channelName, videoId, transcriptLength: transcript.length, analysis });
  } catch (error) {
    console.error("[BlindSim Error]", error.message);
    send("error", { error: error.message });
  }
  res.end();
});

// ── /api/blindsim/chat ────────────────────────────────────────────────────────
app.post("/api/blindsim/chat", async (req, res) => {
  const { videoId, videoTitle, channelName, question, history = [] } = req.body;
  if (!videoId)  return res.status(400).json({ error: "videoId is required." });
  if (!question) return res.status(400).json({ error: "question is required." });
  try {
    console.log(`[Chat] Question: "${question}"`);
    const ragChunks = await retrieveChunks(videoId, question, 5);
    console.log(`[Chat] Retrieved ${ragChunks.length} RAG chunks`);
    const { answer, sourceType } = await generateChatAnswer({
      question, ragChunks, history,
      videoTitle:  videoTitle  || "this video",
      channelName: channelName || "the creator",
    });
    res.json({ answer, sourceType });
  } catch (error) {
    console.error("[Chat Error]", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── /api/blindsim/chat/history ────────────────────────────────────────────────
app.get("/api/blindsim/chat/history", (req, res) => {
  res.json({ messages: [] });
});

// ── /api/health ───────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
    res.json({
        status:             "ok",
        apifyConfigured:    !!APIFY_TOKEN,
        cohereConfigured:   !!COHERE_API_KEY,
        sciraConfigured:    !!SCIRA_API_KEY,
        supabaseConfigured: !!SUPABASE_URL && !!SUPABASE_SECRET,
        serpConfigured:     !!SERP_API_KEY,
        vtConfigured:       !!VT_API_KEY,
        finnhubConfigured:  !!FINNHUB_KEY,
    });
});

// ── start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 FinSafe server → http://localhost:${PORT}`);
    console.log(`   Pages      : /  |  /newsfeed  |  /blindsimulation  |  /about`);
    console.log(`   Apify      : ${!!APIFY_TOKEN}`);
    console.log(`   Cohere     : ${!!COHERE_API_KEY}`);
    console.log(`   Scira      : ${!!SCIRA_API_KEY}`);
    console.log(`   SerpAPI    : ${!!SERP_API_KEY}`);
    console.log(`   VirusTotal : ${!!VT_API_KEY}`);
    console.log(`   Finnhub    : ${!!FINNHUB_KEY}`);
    console.log(`   Supabase   : ${!!SUPABASE_URL} / secret: ${!!SUPABASE_SECRET}\n`);
});