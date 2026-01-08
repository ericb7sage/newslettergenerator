// server.js (Railway-ready, ESM)
// - Express API
// - /scrape-discussion: scrapes topic, username, avatar, when (LEAVES title BLANK per your request)
// - /presets: shared presets storage in Supabase (so no localStorage sharing issues)
// - CORS enabled for CodePen

import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "200kb" }));

const DEBUG = process.env.DEBUG === "1";

/** -------------------- Supabase -------------------- **/
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const PRESET_KEY = process.env.PRESET_KEY || "default"; // you can make this per-team/project if you want

const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const supabase = hasSupabase
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
  : null;

/** -------------------- CORS (for CodePen) -------------------- **/
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // tighten later if desired
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS,GET,PUT");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/** -------------------- Health -------------------- **/
app.get("/", (req, res) => res.status(200).send("ok"));

/** -------------------- Helpers -------------------- **/
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
  // Find a topic/category link under /discussion/ but not:
  // - profile links
  // - numeric post links (/discussion/54829/...)
  // - /discussion root
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
    topicUrl: absUrl($topicLink.attr("href") || ""),
  };
}

function findUsername($) {
  // Primary: discussion profile links
  let username =
    firstText($, [
      'a[href^="/discussion/profile/"]',
      'a[href*="/discussion/profile/"]',
      '[class*="UserLink"] a',
      '[class*="user"] a[href*="profile"]',
    ]) || firstMatchFromLinks($, (href) => href.startsWith("/discussion/profile/"));

  return (username || "").trim();
}

function findAvatar($, html) {
  // 1) Explicit avatar img
  let src = firstAttr(
    $,
    [
      'img[class*="Avatar"][src]',
      'img[class*="avatar"][src]',
      'img[alt*="Avatar"][src]',
      'img[alt*="avatar"][src]',
    ],
    "src"
  );
  if (src) return absUrl(src);

  // 2) ImageKit hosted avatars (uploaded pics)
  src = firstAttr($, ['img[src*="imagekit.io"]'], "src");
  if (src) return absUrl(src);

  // 3) srcset fallback
  const srcset = firstAttr(
    $,
    [
      'img[class*="Avatar"][srcset]',
      'img[class*="avatar"][srcset]',
      'img[alt*="Avatar"][srcset]',
      'img[alt*="avatar"][srcset]',
      'img[srcset*="imagekit.io"]',
    ],
    "srcset"
  );

  const u = parseFirstUrlFromSrcset(srcset);
  if (u) return absUrl(u);

  // 4) Last resort: any imagekit URL in the HTML
  const m = html.match(/https?:\/\/ik\.imagekit\.io\/[^"' )]+/i);
  if (m) return m[0];

  return "";
}

function findWhen($, html) {
  // Best: <time datetime>
  let when = firstAttr($, ["time[datetime]"], "datetime") || firstText($, ["time"]);
  if (when) return when.replace(/\s+/g, " ").trim();

  // Fallback: common relative text such as "Edited 21 mins ago"
  const m =
    html.match(/\bEdited\s+\d+\s+\w+\s+ago\b/i) || html.match(/\b\d+\s+\w+\s+ago\b/i);
  if (m) return m[0].replace(/\s+/g, " ").trim();

  return "";
}

// Boost gravatar size if it’s a gravatar URL with ?size=64 etc.
function upscaleAvatar(avatarUrl) {
  if (!avatarUrl) return "";
  try {
    const u = new URL(avatarUrl);
    // Gravatar often uses "size" parameter.
    if (u.hostname.includes("gravatar.com")) {
      u.searchParams.set("size", "192");
      return u.toString();
    }
    return avatarUrl;
  } catch {
    return avatarUrl;
  }
}

/** -------------------- Scrape Endpoint -------------------- **/
app.post("/scrape-discussion", async (req, res) => {
  try {
    const url = String(req.body?.url || "").trim();

    if (DEBUG) console.log("RECEIVED url:", JSON.stringify(url));

    if (!url.startsWith("https://7sage.com/discussion/")) {
      return res.status(400).json({
        ok: false,
        error: "URL must start with https://7sage.com/discussion/",
      });
    }

    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NewsletterGenerator/1.0)",
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `Fetch failed: ${r.status}` });
    }

    const html = await r.text();
    const $ = cheerio.load(html);

    // IMPORTANT: per your request, DO NOT scrape title. Leave blank.
    const title = "";

    const { topic, topicUrl } = findTopic($);
    const username = findUsername($);
    const avatarRaw = findAvatar($, html);
    const avatar = upscaleAvatar(avatarRaw);
    const when = findWhen($, html);

    if (DEBUG) {
      console.log("DEBUG signals:", {
        hasProfileLinks: html.includes("/discussion/profile/"),
        hasGravatar: html.toLowerCase().includes("gravatar"),
        hasTimeTag: html.includes("<time"),
        hasEditedAgo: /Edited\s+\d+/i.test(html),
      });
      console.log("DEBUG scraped:", {
        title: title || "(blank-by-design)",
        topic: topic || "(blank)",
        username: username || "(blank)",
        avatar: avatar ? "(found)" : "(blank)",
        when: when || "(blank)",
      });
    }

    return res.json({
      ok: true,
      data: {
        url,
        title, // always ""
        topic,
        topicUrl,
        username,
        avatar,
        when,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/** -------------------- Presets Storage (Supabase) --------------------
  You need a table like:

  create table if not exists public.newsletter_presets (
    key text primary key,
    data jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
  );

  Using SERVICE ROLE KEY means RLS can be ON (service role bypasses RLS).
---------------------------------------------------------------------**/

app.get("/presets", async (req, res) => {
  try {
    if (!hasSupabase) {
      return res.status(500).json({
        ok: false,
        error: "Supabase env vars missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      });
    }

    const key = String(req.query.key || PRESET_KEY).trim() || "default";

    const { data, error } = await supabase
      .from("newsletter_presets")
      .select("key,data,updated_at")
      .eq("key", key)
      .maybeSingle();

    if (error) return res.status(500).json({ ok: false, error: error.message });

    // If row doesn't exist yet, return null data (client can use defaults)
    return res.json({
      ok: true,
      key,
      data: data?.data ?? null,
      updated_at: data?.updated_at ?? null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.put("/presets", async (req, res) => {
  try {
    if (!hasSupabase) {
      return res.status(500).json({
        ok: false,
        error: "Supabase env vars missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      });
    }

    const key = String(req.body?.key || PRESET_KEY).trim() || "default";
    const data = req.body?.data;

    if (data == null || typeof data !== "object") {
      return res.status(400).json({ ok: false, error: "Body must include { data: object }" });
    }

    const payload = {
      key,
      data,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("newsletter_presets")
      .upsert(payload, { onConflict: "key" });

    if (error) return res.status(500).json({ ok: false, error: error.message });

    return res.json({ ok: true, key });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/** -------------------- Start (Railway-safe) -------------------- **/
const port = process.env.PORT || 3000;

// Start listening immediately (don’t block startup)
app.listen(port, () => console.log("Proxy running on port", port));

// Optional: log whether Supabase is configured
if (!hasSupabase) {
  console.warn(
    "WARN: Supabase not configured. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to enable /presets."
  );
}
