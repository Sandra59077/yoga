// Liest die Notion-Datenbank "YogaVideos" und schreibt videos.json fuer die Web-App.
// Laeuft in GitHub Actions. Benoetigt das Secret NOTION_TOKEN.
import { writeFileSync } from "node:fs";

const TOKEN = process.env.NOTION_TOKEN;
// Datenbank-ID (kann per Repo-Variable NOTION_DB_ID ueberschrieben werden):
const DB_ID = process.env.NOTION_DB_ID || "1d8c61f6701e8202a90801ec6403fc9d";

if (!TOKEN) {
  console.error("Fehler: NOTION_TOKEN fehlt. Bitte als GitHub-Secret anlegen.");
  process.exit(1);
}

const API = `https://api.notion.com/v1/databases/${DB_ID}/query`;
const HEADERS = {
  "Authorization": `Bearer ${TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json"
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// YouTube-Video-ID aus verschiedenen URL-Formen ziehen
function ytId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|v=|embed\/|shorts\/|live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function plain(rich) {
  return (rich || []).map(r => r.plain_text).join("").trim();
}
function propByType(props, type) {
  for (const k in props) { if (props[k].type === type) return props[k]; }
  return null;
}

// Eine Notion-Anfrage mit automatischen Wiederholungen bei Server-/Timeout-Fehlern (5xx, 429, Netzwerk)
async function notionQuery(body, tries = 5) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(API, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
      if (res.ok) return await res.json();
      const text = await res.text();
      if (res.status >= 500 || res.status === 429) {
        // voruebergehend -> erneut versuchen
        lastErr = new Error(`Notion API ${res.status} (Versuch ${i}/${tries})`);
        console.warn(lastErr.message + " - neuer Versuch...");
      } else {
        // echter Fehler (z. B. 401/404) -> sofort abbrechen
        throw new Error(`Notion API ${res.status}: ${text}`);
      }
    } catch (e) {
      // Netzwerkfehler -> auch erneut versuchen
      lastErr = e;
      console.warn(`Netzwerk-/Serverproblem (Versuch ${i}/${tries}): ${e.message}`);
    }
    if (i < tries) await sleep(3000 * i); // 3s, 6s, 9s, 12s
  }
  throw lastErr;
}

async function queryAll() {
  let results = [], cursor;
  do {
    const body = cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 };
    const j = await notionQuery(body);
    results = results.concat(j.results);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return results;
}

const pages = await queryAll();
const videos = [];
for (const p of pages) {
  const props = p.properties;
  const titleProp = propByType(props, "title");
  const t = titleProp ? plain(titleProp.title) : "";
  const urlProp = props.URL || propByType(props, "url");
  const url = urlProp ? urlProp.url : null;
  const id = ytId(url);
  const art = props.Art?.select?.name || null;
  const c = props.Kanal ? plain(props.Kanal.rich_text) : "";
  const d = (props.Dauer && props.Dauer.number != null) ? props.Dauer.number : null;
  if (!id || !art || !t) continue; // leere/unvollstaendige Zeilen ueberspringen
  videos.push({ art, c, d, id, t });
}

const order = { Yoga: 0, Fitness: 1, Meditation: 2 };
videos.sort((a, b) => (order[a.art] ?? 9) - (order[b.art] ?? 9) || (a.d ?? 999) - (b.d ?? 999));

writeFileSync("videos.json", JSON.stringify(videos, null, 2));
console.log(`videos.json geschrieben: ${videos.length} Videos.`);
