// Ergaenzt Videos eines YouTube-Kanals in der Notion-Datenbank "YogaVideos".
// Holt echte Laengen ueber die YouTube Data API, erkennt Dehn-Videos,
// bevorzugt 20-/25-Minuten-Videos und ueberspringt Duplikate.
//
// Secrets in GitHub Actions:  YOUTUBE_API_KEY , NOTION_TOKEN
// Steuerung per Env (im Workflow gesetzt):
//   CHANNEL_ID  - YouTube-Kanal-ID (Default: Mady Morrison)
//   KANAL       - Name fuers Feld "Kanal" (Default: Mady Morrison)
//   MAX_ADD     - wie viele neue Videos hoechstens anlegen (Default: 20)

const YT_KEY  = process.env.YOUTUBE_API_KEY;
const NOTION  = process.env.NOTION_TOKEN;
const CHANNEL = process.env.CHANNEL_ID || "UCHJBoCDxaCTRrwCHXEBA-BA"; // Mady Morrison
const KANAL   = process.env.KANAL      || "Mady Morrison";
const MAX_ADD = Number(process.env.MAX_ADD || 20);
const DB_ID   = process.env.NOTION_DB_ID || "1d8c61f6701e8202a90801ec6403fc9d";

if (!YT_KEY) { console.error("Fehler: YOUTUBE_API_KEY fehlt."); process.exit(1); }
if (!NOTION) { console.error("Fehler: NOTION_TOKEN fehlt."); process.exit(1); }

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
async function uploadsPlaylist(channelId) {
  const j = await ytGet("channels", { part: "contentDetails", id: channelId });
  const up = j.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!up) throw new Error("Uploads-Playlist nicht gefunden fuer " + channelId);
  return up;
}
async function playlistVideoIds(playlistId) {
  let ids = [], pageToken;
  do {
    const j = await ytGet("playlistItems", {
      part: "contentDetails", maxResults: "50", playlistId,
      ...(pageToken ? { pageToken } : {})
    });
    for (const it of j.items) if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
    pageToken = j.nextPageToken;
  } while (pageToken);
  return ids;
}
function isoToSeconds(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
  if (!m) return null;
  return (+(m[1]||0))*3600 + (+(m[2]||0))*60 + (+(m[3]||0));
}
async function videoDetails(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const j = await ytGet("videos", { part: "snippet,contentDetails", id: ids.slice(i, i+50).join(",") });
    for (const v of j.items) {
      out.push({ id: v.id, title: v.snippet?.title || "", seconds: isoToSeconds(v.contentDetails?.duration) });
    }
  }
  return out;
}

// ---------- Notion ----------
async function notion(path, method, body) {
  const res = await fetch("https://api.notion.com/v1/" + path, {
    method,
    headers: { "Authorization": `Bearer ${NOTION}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${await res.text()}`);
  return res.json();
}
async function existingIds() {
  const set = new Set(); let cursor;
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
function istDehnen(title) {
  return /stretch|dehn|faszien|beweglich|yin|mobilit|mobilis|verspannung/i.test(title);
}
function kategorie(min) {
  if (min <= 17) return "15 Minuten";
  if (min <= 22) return "20 Minuten";
  if (min <= 27) return "25 Minuten";
  if (min <= 37) return "30 Minuten";
  if (min <= 52) return "45 Minuten";
  if (min <= 67) return "60 Minuten";
  return "Länger";
}
async function createPage(v, min, art) {
  await notion("pages", "POST", {
    parent: { type: "database_id", database_id: DB_ID },
    properties: {
      "Name":      { title: [{ text: { content: v.title.slice(0, 1900) } }] },
      "Kanal":     { rich_text: [{ text: { content: KANAL } }] },
      "Dauer":     { number: min },
      "Art":       { select: { name: art } },
      "Kategorie": { select: { name: kategorie(min) } },
      "URL":       { url: "https://youtu.be/" + v.id }
    }
  });
}

// ---------- Ablauf ----------
console.log(`Lese Kanal ${CHANNEL} ...`);
const up = await uploadsPlaylist(CHANNEL);
const ids = await playlistVideoIds(up);
console.log(`Kanal enthaelt ${ids.length} Videos. Hole Laengen ...`);
const details = await videoDetails(ids);

const have = await existingIds();
// nur sinnvolle Laengen (10-40 Min), noch nicht vorhanden
let cand = details.filter(v => v.seconds && v.seconds >= 10*60 && v.seconds <= 40*60 && !have.has(v.id));

// Schwerpunkt 20/25 Min: erst 18-27 Min, dann der Rest
const prio = v => { const m = v.seconds/60; return (m >= 18 && m <= 27) ? 0 : 1; };
cand.sort((a, b) => prio(a) - prio(b));

const toAdd = cand.slice(0, MAX_ADD);
console.log(`Neu einzutragen: ${toAdd.length} (von ${cand.length} moeglichen).`);

let done = 0, dehn = 0;
for (const v of toAdd) {
  const min = Math.round(v.seconds / 60);
  const art = istDehnen(v.title) ? "Dehnen" : (KANAL === "Gabi Fastner" ? "Fitness" : "Yoga");
  if (art === "Dehnen") dehn++;
  try {
    await createPage(v, min, art);
    done++;
    console.log(`+ [${art}] (${min} Min) ${v.title}`);
  } catch (e) {
    console.warn(`! Fehler bei "${v.title}": ${e.message}`);
  }
  await sleep(350);
}
console.log(`Fertig. ${done} Videos angelegt (davon ${dehn} als Dehnen).`);
