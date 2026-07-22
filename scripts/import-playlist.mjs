// Einmaliger Import: liest eine YouTube-Playlist, filtert Videos UNTER 30 Minuten
// und legt sie in der Notion-Datenbank "YogaVideos" als Meditationen an (ohne Duplikate).
//
// Benoetigte Secrets in GitHub Actions:
//   YOUTUBE_API_KEY  - dein YouTube Data API v3 Schluessel
//   NOTION_TOKEN     - dein Notion-Integrations-Token (hast du schon)
//
// Optional per Env ueberschreibbar: PLAYLIST_ID, NOTION_DB_ID, MAX_MINUTES

const YT_KEY   = process.env.YOUTUBE_API_KEY;
const NOTION   = process.env.NOTION_TOKEN;
const PLAYLIST = process.env.PLAYLIST_ID  || "PLf9HOK_Rf1M71rcc9URwZqA2sEY0QV7BP";
const DB_ID    = process.env.NOTION_DB_ID || "1d8c61f6701e8202a90801ec6403fc9d";
const MAX_MIN  = Number(process.env.MAX_MINUTES || 30); // "unter 30 Minuten"

if (!YT_KEY)  { console.error("Fehler: YOUTUBE_API_KEY fehlt (als GitHub-Secret anlegen)."); process.exit(1); }
if (!NOTION)  { console.error("Fehler: NOTION_TOKEN fehlt."); process.exit(1); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- YouTube ----------
async function ytGet(path, params) {
  const url = new URL("https://www.googleapis.com/youtube/v3/" + path);
  for (const k in params) url.searchParams.set(k, params[k]);
  url.searchParams.set("key", YT_KEY);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube API ${res.status}: ${await res.text()}`);
  return res.json();
}

// alle Video-IDs der Playlist einsammeln
async function playlistVideoIds() {
  let ids = [], pageToken;
  do {
    const j = await ytGet("playlistItems", {
      part: "contentDetails", maxResults: "50", playlistId: PLAYLIST,
      ...(pageToken ? { pageToken } : {})
    });
    for (const it of j.items) {
      const vid = it.contentDetails?.videoId;
      if (vid) ids.push(vid);
    }
    pageToken = j.nextPageToken;
  } while (pageToken);
  return ids;
}

// ISO-8601-Dauer (z. B. PT34M12S) in Sekunden
function isoToSeconds(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
  if (!m) return null;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}

// Details (Titel, Dauer, Kanal) fuer viele IDs (Bloecke a 50)
async function videoDetails(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const j = await ytGet("videos", { part: "snippet,contentDetails", id: chunk.join(",") });
    for (const v of j.items) {
      const secs = isoToSeconds(v.contentDetails?.duration);
      out.push({
        id: v.id,
        title: v.snippet?.title || "",
        channel: v.snippet?.channelTitle || "Buddhist Society of Western Australia",
        seconds: secs
      });
    }
  }
  return out;
}

// ---------- Notion ----------
async function notion(path, method, body) {
  const res = await fetch("https://api.notion.com/v1/" + path, {
    method,
    headers: {
      "Authorization": `Bearer ${NOTION}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${await res.text()}`);
  return res.json();
}

// bereits vorhandene YouTube-IDs in der Datenbank (fuer Duplikat-Schutz)
async function existingIds() {
  const set = new Set();
  let cursor;
  do {
    const j = await notion(`databases/${DB_ID}/query`, "POST", cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 });
    for (const p of j.results) {
      const url = p.properties?.URL?.url || "";
      const m = /([A-Za-z0-9_-]{11})/.exec(url.split("/").pop() || "");
      if (m) set.add(m[1]);
    }
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return set;
}

function kategorie(min) {
  const opts = [15, 20, 25, 30];
  let best = opts[0];
  for (const o of opts) if (Math.abs(o - min) < Math.abs(best - min)) best = o;
  return best + " Minuten";
}

async function createPage(v, min) {
  await notion("pages", "POST", {
    parent: { type: "database_id", database_id: DB_ID },
    properties: {
      "Name":      { title: [{ text: { content: v.title.slice(0, 1900) } }] },
      "Kanal":     { rich_text: [{ text: { content: v.channel } }] },
      "Dauer":     { number: min },
      "Art":       { select: { name: "Meditation" } },
      "Kategorie": { select: { name: kategorie(min) } },
      "URL":       { url: "https://youtu.be/" + v.id }
    }
  });
}

// ---------- Ablauf ----------
console.log("Lese Playlist...");
const ids = await playlistVideoIds();
console.log(`Playlist enthaelt ${ids.length} Videos.`);

const details = await videoDetails(ids);
const underMax = details.filter(v => v.seconds != null && v.seconds > 0 && v.seconds < MAX_MIN * 60);
console.log(`Davon unter ${MAX_MIN} Min: ${underMax.length}.`);

const have = await existingIds();
const toAdd = underMax.filter(v => !have.has(v.id));
console.log(`Neu einzutragen (ohne Duplikate): ${toAdd.length}.`);

let done = 0;
for (const v of toAdd) {
  const min = Math.round(v.seconds / 60);
  try {
    await createPage(v, min);
    done++;
    console.log(`+ (${min} Min) ${v.title}`);
  } catch (e) {
    console.warn(`! Fehler bei "${v.title}": ${e.message}`);
  }
  await sleep(350); // Notion-Ratenlimit schonen
}
console.log(`Fertig. ${done} Videos in Notion angelegt.`);
