import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import fs from "node:fs/promises";

const app = express();
app.use(express.json({ limit: "500kb" }));

const DEBUG = process.env.DEBUG === "1";
const PRESETS_PATH = process.env.PRESETS_PATH || "./presets.json";

/** ------------------------ CORS (so CodePen can call this proxy) ------------------------ **/
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // tighten later if desired
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS,GET");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/** ------------------------ Health route ------------------------ **/
app.get("/", (req, res) => {
  res.status(200).send("ok");
});

/** ------------------------ Default presets (shared) ------------------------ **/
const DEFAULT_PRESETS = {
  moods: [
    { id: "motivated", label: "💪 Motivated", bg: "#ebf7fb", text: "#344054" },
    { id: "frustrated", label: "😖 Frustrated", bg: "#f8d4e4", text: "#344054" },
    { id: "happy", label: "😊 Happy", bg: "#f0fdf9", text: "#344054" },
    { id: "none", label: "(None)", bg: "#ffffff", text: "#344054" }
  ],
  topics: [
    { id: "general", label: "General" },
    { id: "lsat", label: "LSAT" },
    { id: "admissions", label: "Admissions" }
  ],
  instructors: [
    { id: "instructor_1", name: "Instructor 1", avatar: "" }
  ],
  difficulties: [
    { id: "basic", label: "Basic", filledCount: 1, filled: "#2a6c7f", empty: "#e5eef2" },
    { id: "intermediate", label: "Intermediate", filledCount: 2, filled: "#15b79e", empty: "#e5eef2" },
    { id: "advanced", label: "Advanced", filledCount: 3, filled: "#227f9c", empty: "#e5eef2" }
  ]
};

function isObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function normalizePresets(p) {
  // Very light validation/sanitization. Keeps you from saving totally broken shapes.
  if (!isObject(p)) return structuredClone(DEFAULT_PRESETS);

  const out = structuredClone(DEFAULT_PRESETS);

  if (Array.isArray(p.moods)) out.moods = p.moods.filter(isObject).map(m => ({
    id: String(m.id ?? "").trim() || "mood_" + Math.random().toString(16).slice(2),
    label: String(m.label ?? ""),
    bg: String(m.bg ?? "#ffffff"),
    text: String(m.text ?? "#344054")
  }));

  if (Array.isArray(p.topics)) out.topics = p.topics.filter(isObject).map(t => ({
    id: String(t.id ?? "").trim() || "topic_" + Math.random().toString(16).slice(2),
    label: String(t.label ?? "")
  }));

  if (Array.isArray(p.instructors)) out.instructors = p.instructors.filter(isObject).map(i => ({
    id: String(i.id ?? "").trim() || "instructor_" + Math.random().toString(16).slice(2),
    name: String(i.name ?? ""),
    avatar: String(i.avatar ?? "")
  }));

  if (Array.isArray(p.difficulties)) out.difficulties = p.difficulties.filter(isObject).map(d => ({
    id: String(d.id ?? "").trim() || "difficulty_" + Math.random().toString(16).slice(2),
    label: String(d.label ?? ""),
    filledCount: Math.max(1, Math.min(3, Number(d.filledCount ?? 1))),
    filled: String(d.filled ?? "#2a6c7f"),
    empty: String(d.empty ?? "#e5eef2")
  }));

  // Ensure required items exist
  if (!out.moods.some(m => m.id === "none")) out.moods.push({ id: "none", label: "(None)", bg: "#ffffff", text: "#344054" });
  if (out.topics.length === 0) out.topics = structuredClone(DEFAULT_PRESETS.topics);
  if (out.instructors.length === 0) out.instructors = structuredClone(DEFAULT_PRESETS.instructors);
  if (out.difficulties.length === 0) out.difficulties = structuredClone(DEFAULT_PRESETS.difficulties);

  return out;
}

let presetsCache = structuredClone(DEFAULT_PRESETS);

async function loadPresetsFromDisk() {
  try {
    const raw = await fs.readFile(PRESETS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    presetsCache = normalizePresets(parsed);
    if (DEBUG) console.log("Loaded presets from disk:", PRESETS_PATH);
  } catch (e) {
    // If file doesn't exist or is invalid, keep defaults and try to write it.
    presetsCache = structuredClone(DEFAULT_PRESETS);
    try {
      await fs.writeFile(PRESETS_PATH, JSON.stringify(presetsCache, null, 2), "utf8");
      if (DEBUG) console.log("Wrote default presets to disk:", PRESETS_PATH);
    } catch (writeErr) {
      if (DEBUG) console.warn("Could not write presets file:", writeErr.message);
    }
  }
}

async function savePresetsToDisk(newPresets) {
  presetsCache = normalizePresets(newPresets);
  await fs.writeFile(PRESETS_PATH, JSON.stringify(presetsCache, null, 2), "utf8");
}

/** ------------------------ Presets endpoints (shared across users) ------------------------ **/
app.get("/presets", async (req, res) => {
  try {
    return res.json({ ok: true, presets: presetsCache });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/presets", async (req, res) => {
  try {
    const incoming = req.body?.presets;
    if (!incoming) {
      return res.status(400).json({ ok: false, error: "Missing body.presets" });
    }
    await savePresetsToDisk(incoming);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/** ------------------------ Scrape helpers ------------------------ **/
function absUrl(maybeRelative) {
  if (!maybeRelative) return "";
  const s = String(maybeRelative).trim();
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("//")) return `https:${s}`;
  if (s.startsWith("/")) return `https://7sage.com${s}`;
  return s;
}

function firstText($, selectors) {
  for (const sel of selectors) {
    const t = $(sel).first().text().trim();
    if (t) return t;
  }
  return "";
}

function firstAttr($, selectors, attr) {
  for (const sel of selectors) {
    const v = $(sel).first().attr(attr);
    if (v && String(v).trim()) return String(v).trim();
  }
  return "";
}

function firstMatchFromLinks($, predicate) {
  const links = $("a").toArray();
  for (const el of links) {
    const href = ($(el).attr("href") || "").trim();
    if (predicate(href, el)) {
      const txt = ($(el).text() || "").trim();
      if (txt) return txt;
    }
  }
  return "";
}

function parseFirstUrlFromSrcset(srcset) {
  if (!srcset) return "";
  const first = String(srcset).split(",")[0]?.trim() || "";
  return first.split(/\s+/)[0] || "";
}

function findTopic($) {
  const $topicLink = $('a[href^="/discussion/"]')
    .filter((_, a) => {
      const href = ($(a).attr("href") || "").trim();
      if (!href) return false;
      if (href.startsWith("/discussion/profile/")) return false;
      if (href === "/discussion" || href === "/discussion/") return false;
      if (/^\/discussion\/\d+\/?/.test(href)) return false;
      return true;
    })
    .first();

  return {
    topic: ($topicLink.text() || "").trim(),
    topicUrl: absUrl($topicLink.attr("href") || "")
  };
}

function findUsername($) {
  let username =
    firstText($, [
      'a[href^="/discussion/profile/"]',
      'a[href*="/discussion/profile/"]',
      '[class*="UserLink"] a',
      '[class*="user"] a[href*="profile"]'
    ]) || firstMatchFromLinks($, (href) => href.startsWith("/discussion/profile/"));

  return (username || "").trim();
}

function findAvatar($, html) {
  let src = firstAttr($, [
    'img[class*="Avatar"][src]',
    'img[class*="avatar"][src]',
    'img[alt*="Avatar"][src]',
    'img[alt*="avatar"][src]'
  ], "src");
  if (src) return absUrl(src);

  src = firstAttr($, ['img[src*="imagekit.io"]'], "src");
  if (src) return absUrl(src);

  const srcset = firstAttr($, [
    'img[class*="Avatar"][srcset]',
    'img[class*="avatar"][srcset]',
    'img[alt*="Avatar"][srcset]',
    'img[alt*="avatar"][srcset]',
    'img[srcset*="imagekit.io"]'
  ], "srcset");

  const u = parseFirstUrlFromSrcset(srcset);
  if (u) return absUrl(u);

  const m = html.match(/https?:\/\/ik\.imagekit\.io\/[^"' )]+/i);
  if (m) return m[0];

  return "";
}

function findWhen($, html) {
  let when =
    firstAttr($, ["time[datetime]"], "datetime") ||
    firstText($, ["time"]);

  if (when) return when.replace(/\s+/g, " ").trim();

  const m =
    html.match(/\bEdited\s+\d+\s+\w+\s+ago\b/i) ||
    html.match(/\b\d+\s+\w+\s+ago\b/i);
  if (m) return m[0].replace(/\s+/g, " ").trim();

  return "";
}

/** ------------------------ Scrape endpoint ------------------------ **/
app.post("/scrape-discussion", async (req, res) => {
  try {
    const url = String(req.body?.url || "").trim();
    if (DEBUG) console.log("RECEIVED url:", JSON.stringify(url));

    if (!url.startsWith("https://7sage.com/discussion/")) {
      return res.status(400).json({
        ok: false,
        error: "URL must start with https://7sage.com/discussion/"
      });
    }

    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NewsletterGenerator/1.0)",
        "Accept": "text/html",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `Fetch failed: ${r.status}` });
    }

    const html = await r.text();
    const $ = cheerio.load(html);

    // Per your request: DO NOT scrape title. Leave blank so titles are custom.
    const title = "";

    const { topic, topicUrl } = findTopic($);
    const username = findUsername($);
    const avatar = findAvatar($, html);
    const when = findWhen($, html);

    if (DEBUG) {
      console.log("DEBUG signals:", {
        hasProfileLinks: html.includes("/discussion/profile/"),
        hasGravatar: html.toLowerCase().includes("gravatar"),
        hasTimeTag: html.includes("<time"),
        hasEditedAgo: /Edited\s+\d+/i.test(html)
      });
      console.log("DEBUG scraped:", {
        title: "(forced blank)",
        topic,
        username: username || "(blank)",
        avatar: avatar ? "(found)" : "(blank)",
        when: when || "(blank)"
      });
    }

    return res.json({
      ok: true,
      data: {
        url,
        title,     // always ""
        topic,
        topicUrl,
        username,
        avatar,
        when
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/** ------------------------ Boot + listen ------------------------ **/
const port = process.env.PORT || 3000;

await loadPresetsFromDisk();

app.listen(port, () => console.log("Proxy running on port", port));
