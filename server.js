import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(express.json({ limit: "200kb" }));

const DEBUG = process.env.DEBUG === "1";

// CORS so CodePen can call this proxy
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // tighten later if desired
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS,GET");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Health route so Railway can verify the service responds
app.get("/", (req, res) => {
  res.status(200).send("ok");
});

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

function findTopic($) {
  // Try to find a topic/category link.
  // Exclude:
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
    topicUrl: absUrl($topicLink.attr("href") || "")
  };
}

function findUsername($, html) {
  // 1) Most likely: profile links
  let username =
    firstText($, [
      'a[href^="/discussion/profile/"]',
      'a[href*="/discussion/profile/"]',
      '[class*="UserLink"] a',
      '[class*="user"] a[href*="profile"]'
    ]) ||
    firstMatchFromLinks($, (href) => href.startsWith("/discussion/profile/"));

  if (username) return username.trim();

  // 2) Fallback: sometimes username appears in meta text without profile link
  // Try common patterns (best-effort)
  username =
    firstText($, [
      '[class*="Author"]',
      '[class*="author"]',
      '[class*="Byline"]',
      '[class*="byline"]'
    ]);

  if (username) return username.trim();

  // 3) Last resort: try JSON-LD (if present)
  try {
    let ld = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (ld) return;
      const raw = $(el).text().trim();
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const hit = arr.find(o => o && (o["@type"] === "DiscussionForumPosting" || o["@type"] === "Article" || o["@type"] === "WebPage"));
      if (hit) ld = hit;
    });
    const ldAuthor = ld?.author?.name || ld?.author?.[0]?.name || "";
    if (ldAuthor) return String(ldAuthor).trim();
  } catch {}

  return "";
}

function findAvatar($, html) {
  // Prefer gravatar
  let src = firstAttr($, [
    'img[src*="gravatar"]',
    'img[class*="Avatar"][src]',
    'img[class*="avatar"][src]',
    'img[alt*="Avatar"][src]',
    'img[alt*="avatar"][src]'
  ], "src");

  if (src) return absUrl(src);

  // Fallback: scan for gravatar in raw HTML (sometimes in srcset)
  const m = html.match(/https?:\/\/www\.gravatar\.com\/avatar\/[^"'\s)]+/i);
  if (m) return m[0];

  return "";
}

function findWhen($, html) {
  // Best: <time datetime>
  let when =
    firstAttr($, ["time[datetime]"], "datetime") ||
    firstText($, ["time"]);

  if (when) return when.replace(/\s+/g, " ").trim();

  // Fallback: common relative text such as "Edited 21 mins ago"
  const m = html.match(/\bEdited\s+\d+\s+\w+\s+ago\b/i) || html.match(/\b\d+\s+\w+\s+ago\b/i);
  if (m) return m[0].replace(/\s+/g, " ").trim();

  // Last resort: JSON-LD dates if present
  try {
    let ld = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      if (ld) return;
      const raw = $(el).text().trim();
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const hit = arr.find(o => o && (o["@type"] === "DiscussionForumPosting" || o["@type"] === "Article" || o["@type"] === "WebPage"));
      if (hit) ld = hit;
    });
    const date = ld?.dateModified || ld?.datePublished || "";
    if (date) return String(date).trim();
  } catch {}

  return "";
}

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

    const title = ($("h1").first().text() || "").trim() || ($("title").text() || "").trim();

    const { topic, topicUrl } = findTopic($);
    const username = findUsername($, html);
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
        title,
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
        title,
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Proxy running on port", port));
