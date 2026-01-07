import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(express.json({ limit: "200kb" }));

// Allow CodePen (browser) to call this server (CORS)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.post("/scrape-discussion", async (req, res) => {
  try {
    const url = String(req.body?.url || "").trim();

    // Basic validation
    if (!url.startsWith("https://7sage.com/discussion/")) {
      return res.status(400).json({
        ok: false,
        error: "URL must start with https://7sage.com/discussion/"
      });
    }

    // Fetch HTML from 7Sage
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NewsletterGenerator/1.0)",
        "Accept": "text/html"
      }
    });

    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `Fetch failed: ${r.status}` });
    }

    const html = await r.text();
    const $ = cheerio.load(html);

    // Extract fields (simple + good enough to start)
    const title = $("h1").first().text().trim();

    // Topic: find a discussion link that isn't profile and isn't the numeric post link
    const topic =
      $('a[href^="/discussion/"]')
        .filter((_, a) => {
          const href = $(a).attr("href") || "";
          if (href.startsWith("/discussion/profile/")) return false;
          if (/^\/discussion\/\d+\/?/.test(href)) return false;
          if (href === "/discussion" || href === "/discussion/") return false;
          return true;
        })
        .first()
        .text()
        .trim();

    const username =
      $('a[href^="/discussion/profile/"]').first().text().trim();

    const avatar =
      $('img[src*="gravatar"]').first().attr("src") || "";

    // "When" is sometimes in <time>, sometimes plain text; start with <time>
    const when =
      $("time").first().attr("datetime")?.trim() ||
      $("time").first().text().trim() ||
      "";

    res.json({
      ok: true,
      data: { url, title, topic, username, avatar, when }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Local dev port is 3000; hosts like Render set PORT automatically
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Proxy running on port", port));
