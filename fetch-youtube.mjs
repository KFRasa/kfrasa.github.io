import { readFile, writeFile } from "node:fs/promises";
import https from "node:https";

const HANDLE = "@KFRasa";
const GD_USERNAME = "KFRasa";
const API_KEY = process.env.YOUTUBE_API_KEY;

if (!API_KEY) {
  console.error("Missing YOUTUBE_API_KEY environment variable.");
  process.exit(1);
}

async function ytApi(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, key: API_KEY })) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason || res.statusText;
    const err = new Error(`YouTube API error (${res.status}): ${reason}`);
    err.status = res.status;
    err.reason = reason;
    throw err;
  }
  return data;
}

async function getChannelInfo(handle) {
  const data = await ytApi("channels", {
    part: "id,statistics",
    forHandle: handle
  });
  const ch = data.items?.[0];
  if (!ch?.id) throw new Error(`Channel not found for handle: ${handle}`);

  const hidden = ch.statistics?.hiddenSubscriberCount === true;
  const subscribers = hidden ? null : Number(ch.statistics?.subscriberCount ?? 0);
  return { channelId: ch.id, subscribers };
}

async function getAllPlaylistVideoIds(playlistId) {
  const ids = [];
  let pageToken;

  do {
    try {
      const data = await ytApi("playlistItems", {
        part: "contentDetails",
        playlistId,
        maxResults: "50",
        pageToken
      });

      for (const item of data.items || []) {
        if (item.contentDetails?.videoId) {
          ids.push(item.contentDetails.videoId);
        }
      }
      pageToken = data.nextPageToken;
    } catch (err) {
      if (err.status === 404) return [];
      throw err;
    }
  } while (pageToken);

  return ids;
}

async function getVideoDetails(ids) {
  const results = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const data = await ytApi("videos", {
      part: "snippet,statistics",
      id: chunk.join(",")
    });

    for (const v of data.items || []) {
      results.push({
        id: v.id,
        title: v.snippet?.title || "",
        publishedAt: v.snippet?.publishedAt || "",
        views: Number(v.statistics?.viewCount || 0)
      });
    }
  }
  return results;
}

function pickThree(items, firstLabel) {
  if (!items.length) return [];

  const byDateDesc = [...items].sort(
    (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)
  );
  const byViewsDesc = [...items].sort((a, b) => b.views - a.views);

  const recent = byDateDesc[0];
  const popular = byViewsDesc[0];
  const first = byDateDesc[byDateDesc.length - 1];

  return [
    { label: "most recent", id: recent.id, title: recent.title, views: recent.views },
    { label: "most popular", id: popular.id, title: popular.title, views: popular.views },
    { label: firstLabel, id: first.id, title: first.title, views: first.views }
  ];
}

// Boomlings requires an empty User-Agent header or Cloudflare blocks the request
function postBoomlings(path, formParams) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(formParams).toString();
    const req = https.request(
      {
        hostname: "www.boomlings.com",
        path: `/database/${path}`,
        method: "POST",
        headers: {
          "User-Agent": "",
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body)
        },
        timeout: 10000
      },
      (res) => {
        let chunks = "";
        res.on("data", (d) => (chunks += d));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Boomlings HTTP ${res.statusCode}`));
          }
          resolve(chunks);
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Boomlings timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function parseGdObj(str) {
  const parts = str.split(":");
  const obj = {};
  for (let i = 0; i < parts.length - 1; i += 2) {
    obj[parts[i]] = parts[i + 1];
  }
  return obj;
}

async function getGdStatsFromBoomlings(username) {
  const searchRaw = await postBoomlings("getGJUsers20.php", {
    secret: "Wmfd2893gb7",
    str: username
  });
  if (!searchRaw || searchRaw === "-1" || searchRaw.startsWith("<")) {
    throw new Error(`Boomlings search failed: ${searchRaw?.slice(0, 60)}`);
  }

  const users = searchRaw.split("#")[0].split("|").map(parseGdObj);
  const match =
    users.find((u) => (u["1"] || "").toLowerCase() === username.toLowerCase()) || users[0];

  const accountId = match?.["16"];
  if (!accountId) throw new Error("GD accountID not found");

  const infoRaw = await postBoomlings("getGJUserInfo20.php", {
    secret: "Wmfd2893gb7",
    targetAccountID: accountId
  });
  if (!infoRaw || infoRaw === "-1" || infoRaw.startsWith("<")) {
    throw new Error(`Boomlings userInfo failed: ${infoRaw?.slice(0, 60)}`);
  }

  const info = parseGdObj(infoRaw.split("#")[0]);
  return {
    username: info["1"] || username,
    stars: Number(info["3"] ?? 0),
    moons: Number(info["52"] ?? 0),
    diamonds: Number(info["46"] ?? 0),
    coins: Number(info["13"] ?? 0),
    userCoins: Number(info["17"] ?? 0),
    demons: Number(info["4"] ?? 0),
    cp: Number(info["8"] ?? 0)
  };
}

async function getGdStats(username, fallbackStats) {
  try {
    return await getGdStatsFromBoomlings(username);
  } catch (boomErr) {
    console.warn(`Boomlings direct sync failed (${boomErr.message}); trying GDBrowser...`);
    try {
      const res = await fetch(
        `https://gdbrowser.com/api/profile/${encodeURIComponent(username)}`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) throw new Error(`GDBrowser HTTP ${res.status}`);
      const p = await res.json();
      if (!p || p.stars === undefined) throw new Error("Invalid GDBrowser response");
      return {
        username: p.username || username,
        stars: Number(p.stars ?? 0),
        moons: Number(p.moons ?? 0),
        diamonds: Number(p.diamonds ?? 0),
        coins: Number(p.coins ?? 0),
        userCoins: Number(p.userCoins ?? 0),
        demons: Number(p.demons ?? 0),
        cp: Number(p.cp ?? 0)
      };
    } catch (gdbErr) {
      console.warn(`GDBrowser fallback failed (${gdbErr.message}); keeping previous GD stats.`);
      return fallbackStats ?? null;
    }
  }
}

async function main() {
  let prevData = {};
  try {
    prevData = JSON.parse(await readFile("data.json", "utf8"));
  } catch {}

  const { channelId, subscribers } = await getChannelInfo(HANDLE);
  const suffix = channelId.slice(2);

  const [videoIds, shortIds, gd] = await Promise.all([
    getAllPlaylistVideoIds(`UULF${suffix}`),
    getAllPlaylistVideoIds(`UUSH${suffix}`),
    getGdStats(GD_USERNAME, prevData.gd)
  ]);

  const [videos, shorts] = await Promise.all([
    getVideoDetails(videoIds),
    getVideoDetails(shortIds)
  ]);

  const output = {
    updatedAt: new Date().toISOString(),
    subscribers,
    gd,
    videos: pickThree(videos, "first video"),
    shorts: pickThree(shorts, "first short")
  };

  await writeFile("data.json", JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(
    `Updated data.json (${subscribers ?? "?"} subs, ${videos.length} videos, ${shorts.length} shorts, GD stars: ${gd?.stars ?? "?"})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
