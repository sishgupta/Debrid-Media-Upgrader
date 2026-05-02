import express from "express";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffprobeStatic from "ffprobe-static";

ffmpeg.setFfprobePath(ffprobeStatic.path);

const PORT = 3000;
const DB_PATH = path.join(process.cwd(), "media_library.json");
const SETTINGS_PATH = path.join(process.cwd(), "settings.json");

interface AppSettings {
  tmdbApiKey: string;
  aiostreamsUrl: string;
  targetFolder: string;
  streamResFilter: string;
  streamVideoFilter: string;
  streamAudioFilter: string;
  streamMinBitrate: number;
  streamMaxBitrate: number;
  theme: 'system' | 'light' | 'dark';
}

let settingsCache: AppSettings = {
  tmdbApiKey: process.env.TMDB_API_KEY || "",
  aiostreamsUrl: process.env.AIOSTREAMS_URL || "",
  targetFolder: process.env.TARGET_FOLDER || path.join(process.cwd(), "mock_media"),
  streamResFilter: "All",
  streamVideoFilter: "All",
  streamAudioFilter: "All",
  streamMinBitrate: 0,
  streamMaxBitrate: 100,
  theme: 'dark'
};

function loadSettings() {
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
      settingsCache = { ...settingsCache, ...data };
    } catch (e) {
      console.error("Error reading settings", e);
    }
  }
}

function saveSettings(newSettings: Partial<AppSettings>) {
  settingsCache = { ...settingsCache, ...newSettings };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settingsCache, null, 2));
}

function getMediaDir() {
  return settingsCache.targetFolder;
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[\u{1F300}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E0}-\u{1F1FF}]/gu, '') // Remove emojis and symbols
    .replace(/[<>:"/\\|?*]/g, '_') // Replace illegal chars with underscore
    .replace(/\s+/g, '.') // Replace spaces (and multiple spaces) with dots
    .replace(/\.+/g, '.') // Collapse multiple dots
    .replace(/^\.+|\.+$/g, '') // Trim dots from ends
    .trim();
}

// Load settings initially
loadSettings();

// Ensure media dir exists
if (!fs.existsSync(getMediaDir())) {
  try {
    fs.mkdirSync(getMediaDir(), { recursive: true });
  } catch (e) {
    console.error("Failed to create target folder", e);
  }
}

interface Movie {
  id: number;
  filePath: string;
  fileName: string;
  movieName: string;
  year: string;
  fileSize: number;
  resolution: string;
  bitrate: number;
  hdr: boolean;
  ext: string;
  magnetLink: string | null;
  status: string;
  imdbId: string | null;
  tmdbTitle?: string;
  progress?: number;
  oldFilePath?: string;
  oldMeta?: {
    resolution: string;
    bitrate: number;
    fileSize: number;
    hdr: boolean;
  };
  upgradeMeta?: {
    res: string;
    sizeGiB: number;
    bitrateMbps: number;
    video: string;
    streamName?: string;
    filename?: string;
    extension?: string;
  };
}

let db: Movie[] = [];
let nextId = 1;

// Database initialization
function loadDb() {
  if (fs.existsSync(DB_PATH)) {
    try {
      const data = fs.readFileSync(DB_PATH, "utf-8");
      db = JSON.parse(data);
      if (db.length > 0) {
        nextId = Math.max(...db.map(m => m.id)) + 1;
      }
    } catch (e) {
      console.error("Error reading db:", e);
      db = [];
    }
  } else {
    db = [];
  }
}

function saveDb() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// Helper to extract metadata via ffprobe
function getMediaMetadata(filePath: string): Promise<any> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.error("FFprobe timed out for", filePath);
      resolve({ resolution: 'Unknown', bitrate: 0, hdr: false });
    }, 10000); // 10s timeout

    ffmpeg.ffprobe(filePath, (err, metadata) => {
      clearTimeout(timeout);
      if (err) {
        console.error("FFprobe error:", err);
        return resolve({ resolution: 'Unknown', bitrate: 0, hdr: false });
      }
      
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      let resolution = 'Unknown';
      let bitrate = 0;
      let hdr = false;

      if (videoStream) {
        resolution = `${videoStream.width}x${videoStream.height}`;
        bitrate = videoStream.bit_rate ? Number(videoStream.bit_rate) : (metadata.format.bit_rate ? Number(metadata.format.bit_rate) : 0);
        
        // Simple HDR detection based on color space / transfer characteristics
        if (videoStream.color_transfer && ['smpte2084', 'arib-std-b67'].includes(videoStream.color_transfer.toString())) {
          hdr = true;
        }
      }
      resolve({ resolution, bitrate, hdr });
    });
  });
}

// --- TMDB Rate Limiting & Fetching ---
const TMDB_DELAY_MS = 250; // Max 4 req/sec
let lastTmdbCall = 0;

async function tmdbFetch(url: string) {
  const now = Date.now();
  const timeSinceLast = now - lastTmdbCall;
  if (timeSinceLast < TMDB_DELAY_MS) {
    await new Promise(r => setTimeout(r, TMDB_DELAY_MS - timeSinceLast));
  }
  lastTmdbCall = Date.now();
  
  const options: RequestInit = {
    method: 'GET',
    headers: {
      accept: 'application/json',
    }
  };
  
  let finalUrl = url;
  const key = settingsCache.tmdbApiKey;
  if (key) {
    if (key.length > 50) {
       (options.headers as any).Authorization = `Bearer ${key}`;
    } else {
       finalUrl += (finalUrl.includes('?') ? '&' : '?') + `api_key=${key}`;
    }
  }
  
  const res = await fetch(finalUrl, options);
  if (!res.ok) {
     throw new Error(`TMDB HTTP Error: ${res.status}`);
  }
  return await res.json();
}

async function fetchImdbId(movieName: string, year: string): Promise<{ imdbId: string; tmdbTitle: string; year?: string } | null> {
  if (!settingsCache.tmdbApiKey) {
    throw new Error("TMDB_API_KEY is not configured in settings. Please add it first.");
  }

  try {
    let searchUrl = `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(movieName)}`;
    if (year) {
      searchUrl += `&year=${year}`;
    }
    
    let searchData = await tmdbFetch(searchUrl);
    if (searchData.results && searchData.results.length > 0) {
      const topResult = searchData.results[0];
      const tmdbId = topResult.id;
      const tmdbTitle = topResult.title;
      const releaseDate = topResult.release_date;
      const tmdbYear = releaseDate ? releaseDate.split("-")[0] : undefined;
      
      let extUrl = `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids`;
      let extData = await tmdbFetch(extUrl);
      
      if (extData.imdb_id) {
        return { imdbId: extData.imdb_id, tmdbTitle, year: tmdbYear };
      }
    }
  } catch (error) {
    console.error(`Error fetching IMDB ID for ${movieName}:`, error);
  }
  return null;
}

// --- AIOStreams Rate Limiting, Fetching & Caching ---
const AIOSTREAMS_DELAY_MS = 1000; // Let's be polite: 1 req/sec
let lastAiostreamsCall = 0;

const AIOSTREAMS_CACHE_PATH = path.join(process.cwd(), "aiostreams_cache.json");
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

// In-memory + persistent cache
let aiostreamsCache: Record<string, { timestamp: number; data: any }> = {};

function loadAiostreamsCache() {
  if (fs.existsSync(AIOSTREAMS_CACHE_PATH)) {
    try {
      aiostreamsCache = JSON.parse(fs.readFileSync(AIOSTREAMS_CACHE_PATH, "utf-8"));
      // Basic cleanup of very old entries on load
      const now = Date.now();
      const cleaned: Record<string, { timestamp: number; data: any }> = {};
      let removedCount = 0;
      for (const [id, entry] of Object.entries(aiostreamsCache)) {
        if (now - entry.timestamp < CACHE_TTL_MS * 7) { // Keep even expired stuff for a bit longer in file, but we'll re-fetch if > TTL
          cleaned[id] = entry;
        } else {
          removedCount++;
        }
      }
      aiostreamsCache = cleaned;
      if (removedCount > 0) console.log(`[Cache] Cleaned up ${removedCount} expired entries from AIOStreams cache file.`);
    } catch (e) {
      console.error("Error reading aiostreams cache file", e);
    }
  }
}

function saveAiostreamsCache() {
  try {
    fs.writeFileSync(AIOSTREAMS_CACHE_PATH, JSON.stringify(aiostreamsCache, null, 2));
  } catch (e) {
    console.error("Error saving aiostreams cache file", e);
  }
}

// Initial load
loadAiostreamsCache();

async function aiostreamsSearch(imdbId: string, forceRefresh = false) {
  const cached = aiostreamsCache[imdbId];
  if (!forceRefresh && cached) {
    const age = Date.now() - cached.timestamp;
    if (age < CACHE_TTL_MS) {
      console.log(`[Cache] HIT for ${imdbId} (Age: ${Math.round(age/1000/60)}m). Skipping network call.`);
      return cached.data;
    } else {
      console.log(`[Cache] EXPIRED for ${imdbId} (Age: ${Math.round(age/1000/60)}m). Will re-fetch.`);
    }
  } else if (forceRefresh) {
    console.log(`[Cache] FORCE refresh for ${imdbId}.`);
  } else {
    console.log(`[Cache] MISS for ${imdbId}.`);
  }

  const baseUrl = settingsCache.aiostreamsUrl;
  if (!baseUrl) {
    throw new Error("AIOSTREAMS_URL is not set in environment");
  }

  const now = Date.now();
  const timeSinceLast = now - lastAiostreamsCall;
  if (timeSinceLast < AIOSTREAMS_DELAY_MS) {
    await new Promise(r => setTimeout(r, AIOSTREAMS_DELAY_MS - timeSinceLast));
  }
  lastAiostreamsCall = Date.now();
  
  // Clean trailing slash
  const url = `${baseUrl.replace(/\/$/, '')}/stream/movie/${imdbId}.json`;
  
  console.log(`[Network] Calling AIOStreams: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
     throw new Error(`AIOStreams HTTP Error: ${res.status}`);
  }
  const data = await res.json();
  
  aiostreamsCache[imdbId] = { timestamp: Date.now(), data };
  saveAiostreamsCache();
  return data;
}

// Ensure dummy files exist to test scanning
function createMockMediaFiles() {
  const dummyFiles = [
    "Inception (2010).mp4",
    "The Matrix (1999).mkv",
    "Dune Part Two (2024).webm",
    "Bad Movie.avi",
    "Interstellar (2014).mp4",
    "Avatar The Way of Water.mkv",
    "The Dark Knight (2008).mkv",
    "Pulp Fiction.mp4",
    "Avengers Endgame (2019).avi",
    "Spider-Man No Way Home.webm",
    "Jurassic Park (1993).mp4",
    "Gladiator (2000).mkv",
    "Titanic.avi",
    "The Lord of the Rings The Fellowship of the Ring (2001).mkv",
    "Mad Max Fury Road (2015).webm"
  ];
  
  const mediaDir = getMediaDir();
  dummyFiles.forEach(file => {
    const fullPath = path.join(mediaDir, file);
    if (!fs.existsSync(fullPath)) {
      try {
        fs.writeFileSync(fullPath, "dummy video data");
      } catch (e) {
        console.error("Failed to write mock file via init", e)
      }
    }
  });
}

async function startServer() {
  console.log("Starting server initialization...");
  loadDb();
  console.log("Database initialized.");
  const app = express();
  
  app.use(express.json());

  // --- API Routes ---

  app.get("/api/settings", (req, res) => {
    res.json(settingsCache);
  });

  app.post("/api/settings", (req, res) => {
    try {
      const { tmdbApiKey, aiostreamsUrl, targetFolder, streamResFilter, streamVideoFilter, streamAudioFilter, streamMinBitrate, streamMaxBitrate, theme } = req.body;
      const oldTarget = settingsCache.targetFolder;
      saveSettings({ 
        tmdbApiKey: tmdbApiKey ?? settingsCache.tmdbApiKey,
        aiostreamsUrl: aiostreamsUrl ?? settingsCache.aiostreamsUrl,
        targetFolder: targetFolder ?? settingsCache.targetFolder,
        streamResFilter: streamResFilter ?? settingsCache.streamResFilter,
        streamVideoFilter: streamVideoFilter ?? settingsCache.streamVideoFilter,
        streamAudioFilter: streamAudioFilter ?? settingsCache.streamAudioFilter,
        streamMinBitrate: streamMinBitrate ?? settingsCache.streamMinBitrate,
        streamMaxBitrate: streamMaxBitrate ?? settingsCache.streamMaxBitrate,
        theme: theme ?? settingsCache.theme,
      });
      // Ensure new target dir exists
      if (settingsCache.targetFolder !== oldTarget && !fs.existsSync(settingsCache.targetFolder)) {
        fs.mkdirSync(settingsCache.targetFolder, { recursive: true });
      }
      res.json({ success: true, settings: settingsCache });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get("/api/movies", async (req, res) => {
    try {
      res.json(db);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post("/api/scan", async (req, res) => {
    try {
      const mediaDir = getMediaDir();
      if (!fs.existsSync(mediaDir)) {
         return res.status(400).json({ error: "Target folder does not exist" });
      }
      const files = fs.readdirSync(mediaDir);

      // Cleanup files that no longer exist
      const existingFullPaths = files.map(f => path.join(mediaDir, f));
      db = db.filter(m => existingFullPaths.includes(m.filePath));

      let newCount = 0;
      
      const newFilesForBackground: { id: number, movieName: string, year: string, fileSize: number, filePath: string }[] = [];
      
      for (const file of files) {
        const filePath = path.join(mediaDir, file);
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;

        // Parse Name & Year
        let baseName = path.basename(file, path.extname(file));
        let movieName = baseName.replace(/[\._]/g, " "); // Replace dots and underscores with spaces
        let year = '';
        
        const yearMatch = movieName.match(/\b(19|20)\d{2}\b/);
        if (yearMatch) {
          year = yearMatch[0];
          movieName = movieName.replace(year, "");
        }
        
        movieName = movieName.replace(/[\(\)\[\]\.\-_]/g, " "); // Extra cleaning
        movieName = movieName.replace(/\b(4k|2160p|1080p|720p|480p|remux|bluray|x264|x265|h264|h265|hevc|avc|internal|dts|dd5|dual|audio)\b/gi, " ");
        movieName = movieName.replace(/\s{2,}/g, " ").trim();
        if (movieName.endsWith("-")) movieName = movieName.slice(0, -1).trim();

        // Check if exists
        const existing = db.find(m => m.filePath === filePath);
        if (existing) {
          existing.movieName = movieName; 
          if (year && !existing.year) existing.year = year;

          if (existing.status === 'fetching_metadata') {
             newFilesForBackground.push({ 
               id: existing.id, 
               movieName: existing.movieName, 
               year: existing.year, 
               fileSize: existing.fileSize, 
               filePath: existing.filePath 
             });
          }
          continue;
        }

        let ext = path.extname(file);
        
        let fileSize = stat.size;
        let resolution = '1920x1080';
        let bitrate = 5000000;
        let hdr = false;
        
        if (fileSize <= 1000) {
           const resolutions = ['1280x720', '1920x1080', '3840x2160', '720x480'];
           const hash = file.split('').reduce((a,b) => {a=((a<<5)-a)+b.charCodeAt(0);return a&a},0);
           resolution = resolutions[Math.abs(hash) % resolutions.length];
           bitrate = 1000000 + (Math.abs(hash) % 25000000);
           fileSize = 700000000 + (Math.abs(hash) % 15000000000);
           hdr = (hash % 2) === 0;
        }

        const newId = nextId++;
        
        db.push({
          id: newId,
          filePath,
          fileName: file,
          movieName,
          year,
          fileSize,
          resolution,
          bitrate,
          hdr,
          ext,
          magnetLink: null,
          status: 'fetching_metadata',
          imdbId: null // Handled in background
        });
        saveDb();
        newCount++;
        
        // Queue for background enrichment
        newFilesForBackground.push({ id: newId, movieName, year, fileSize, filePath });
      }
      
      // Fire and forget background worker
      (async () => {
        try {
          const CHUNK_SIZE = 5;
          for (let i = 0; i < newFilesForBackground.length; i += CHUNK_SIZE) {
            const chunk = newFilesForBackground.slice(i, i + CHUNK_SIZE);
            await Promise.all(chunk.map(async (vf) => {
              const movie = db.find(m => m.id === vf.id);
              if (!movie) return;
              
              try {
                const diskStat = fs.statSync(vf.filePath);
                if (diskStat.size > 1000) {
                   const meta = await getMediaMetadata(vf.filePath);
                   movie.resolution = meta.resolution;
                   movie.bitrate = meta.bitrate;
                   movie.hdr = meta.hdr;
                }
              } catch (e) {
                 console.error("Failed getting metadata for", vf.filePath, e);
              }

              movie.status = 'indexed';
            }));
          }
          saveDb(); // Batch save after all chunks are processed
        } catch (globalError) {
          console.error("Critical error in background scanning worker:", globalError);
        }
      })();
      
      res.json({ success: true, newFilesAdded: newCount });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Manual TMDB Match
  app.post("/api/movie/:id/tmdb", async (req, res) => {
    const movieId = Number(req.params.id);
    const movie = db.find(m => m.id === movieId);
    if (!movie) return res.status(404).json({ error: "Movie not found" });

    try {
      const result = await fetchImdbId(movie.movieName, movie.year);
      if (result) {
        movie.imdbId = result.imdbId;
        movie.tmdbTitle = result.tmdbTitle;
        console.log(`[TMDB] Successfully matched "${movie.movieName}" to IMDB: ${result.imdbId} (${result.tmdbTitle})`);
        // Update year if not already set or if it's "Unknown" (if that's a thing in the app)
        if (result.year && (!movie.year || movie.year === "")) {
          movie.year = result.year;
        }
        saveDb();
        res.json({ success: true, imdbId: result.imdbId, tmdbTitle: result.tmdbTitle, year: movie.year });
      } else {
        console.warn(`[TMDB] No match found for "${movie.movieName}" (${movie.year || 'No Year'})`);
        res.status(404).json({ error: "No IMDB ID found on TMDB" });
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/api/movie/:id/unmatch", (req, res) => {
    const movieId = Number(req.params.id);
    const movie = db.find(m => m.id === movieId);
    if (!movie) return res.status(404).json({ error: "Movie not found" });

    console.log(`[TMDB] Removing match for "${movie.movieName}" (Old IMDB: ${movie.imdbId})`);
    movie.imdbId = null;
    movie.tmdbTitle = undefined;
    saveDb();
    res.json({ success: true });
  });

  // Reset Database
  app.post("/api/reset", (req, res) => {
    const { deleteFiles } = req.body || {};
    db.length = 0;
    nextId = 1;
    saveDb();
    
    if (deleteFiles) {
      try {
        const mediaDir = getMediaDir();
        if (fs.existsSync(mediaDir)) {
          const files = fs.readdirSync(mediaDir);
          for (const file of files) {
            const filePath = path.join(mediaDir, file);
            if (fs.statSync(filePath).isFile()) {
              fs.unlinkSync(filePath);
            }
          }
        }
      } catch (e) {
        console.error("Failed to delete files during DB reset:", e);
      }
    }
    
    res.json({ success: true, message: "Database reset successfully" });
  });

  app.post("/api/generate-mocks", (req, res) => {
    try {
      createMockMediaFiles();
      res.json({ success: true, message: "Mock files generated successfully" });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Search using AIOStreams
  app.post("/api/search", async (req, res) => {
    const { movieId, minRes, minBitrate } = req.body;
    try {
      const movie = db.find(m => m.id === Number(movieId));
      if (!movie) return res.status(404).json({ error: "Movie not found" });

      if (!movie.imdbId) {
        return res.status(400).json({ error: "Cannot search without an IMDB ID. Please ensure TMDB API key is set and file has a valid name." });
      }

      const streamData = await aiostreamsSearch(movie.imdbId);
      const streams = streamData.streams || [];
      console.log(`[Search] Found ${streams.length} streams for IMDB ID: ${movie.imdbId}`);

      const formattedStreams = streams.map((s: any) => {
        let link = null;
        if (s.url && s.url.startsWith('magnet:')) link = s.url;
        else if (s.infoHash) link = `magnet:?xt=urn:btih:${s.infoHash}`;
        else if (s.url && s.url.startsWith('http')) link = s.url;

        // Try to find a filename
        let filename = s.filename || null;
        if (!filename && link) {
          if (link.startsWith('magnet:')) {
            const dnMatch = link.match(/[&?]dn=([^&]+)/);
            if (dnMatch) filename = decodeURIComponent(dnMatch[1]);
          } else if (link.startsWith('http')) {
            try {
              const url = new URL(link);
              const pathParts = url.pathname.split('/');
              const lastPart = pathParts[pathParts.length - 1];
              if (lastPart && lastPart.includes('.')) {
                filename = lastPart;
              }
            } catch (e) {}
          }
        }
        
        return {
          name: s.name || 'Unknown',
          title: s.title || s.description || 'Unknown Stream',
          filename,
          link
        };
      }).filter((s: any) => s.link !== null);

      if (formattedStreams.length > 0) {
        res.json({ success: true, streams: formattedStreams });
      } else {
        console.log(`[Search] Stream data sample:`, streams.slice(0, 2));
        res.status(404).json({ error: `No suitable streams found for this content (found ${streams.length} total, but none had valid links)` });
      }
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post("/api/movie/:id/set-stream", (req, res) => {
    const movieId = Number(req.params.id);
    const { link, meta } = req.body;
    const movie = db.find(m => m.id === movieId);
    if (!movie) return res.status(404).json({ error: "Movie not found" });
    
    if (!link) return res.status(400).json({ error: "Link is required" });

    movie.magnetLink = link;
    movie.upgradeMeta = meta;
    movie.status = 'magnet_found';
    saveDb();
    res.json({ success: true });
  });

  app.post("/api/upgrade", async (req, res) => {
    const { movieId } = req.body;
    try {
      const movie = db.find(m => m.id === Number(movieId));
      if (movie) {
        movie.status = 'upgrading';
        movie.progress = 0;
        saveDb();
        
        console.log(`[Upgrade] Starting upgrade process for "${movie.movieName}"`);
        console.log(`[Upgrade] SOURCE LINK (Debrid/Magnet): ${movie.magnetLink || 'N/A'}`);
        
        // Detailed simulation worker
        let currentProgress = 0;
        const interval = setInterval(() => {
          const m = db.find(x => x.id === Number(movieId));
          if (!m) {
            clearInterval(interval);
            return;
          }

          currentProgress += Math.floor(Math.random() * 15) + 5;
          if (currentProgress >= 100) {
            currentProgress = 100;
            m.status = 'upgraded';
            m.progress = 100;
            
            // Execute file operations simulation
            const oldPath = m.filePath;
            const parentDir = path.dirname(oldPath);
            const extension = m.upgradeMeta?.extension || m.ext || path.extname(oldPath) || '.mkv';
            
            // 1. Stage with the "AIStreams" name (mocking the download destination)
            const baseFileName = m.upgradeMeta?.filename || m.upgradeMeta?.streamName;
            const downloadFileName = baseFileName 
              ? `${sanitizeFileName(baseFileName)}.tmp` 
              : `download_staging_${m.id}.tmp`;
            const downloadPath = path.join(parentDir, downloadFileName);
            
            try {
              // Create the "downloaded" file (mock)
              fs.writeFileSync(downloadPath, 'MOCK DOWNLOADED CONTENT');
              console.log(`Downloaded mock file to staging: ${downloadPath}`);

              // 2. Standard naming for final destination: "Movie Title (Year).ext"
              const nameSegments = [m.movieName];
              if (m.year) nameSegments.push(`(${m.year})`);
              const finalFileName = sanitizeFileName(nameSegments.join(' ')) + extension;
              const finalPath = path.join(parentDir, finalFileName);

              // 3. Backup the old file
              if (fs.existsSync(oldPath)) {
                const backupPath = oldPath + '.bak';
                fs.renameSync(oldPath, backupPath);
                m.oldFilePath = backupPath;
                m.oldMeta = {
                  resolution: m.resolution,
                  bitrate: m.bitrate,
                  fileSize: m.fileSize,
                  hdr: m.hdr
                };
                console.log(`Backed up old version to: ${backupPath}`);
              }
              
              // 4. Rename/Move from staging to final location
              fs.renameSync(downloadPath, finalPath);
              console.log(`Finalized upgrade: ${downloadPath} -> ${finalPath}`);

              m.filePath = finalPath;
              m.fileName = finalFileName;
              m.ext = extension;
              m.status = 'verifying_upgrade';
            } catch (fsErr) {
              console.error("FS Simulation error during upgrade:", fsErr);
              m.status = 'indexed';
            }

            // Re-scan metadata for validation
            (async () => {
              try {
                const meta = await getMediaMetadata(m.filePath);
                const stat = fs.statSync(m.filePath);

                // Update with real info from disk
                m.resolution = meta.resolution;
                m.bitrate = meta.bitrate;
                m.hdr = meta.hdr;
                m.fileSize = stat.size;

                // Fallback for mock environment: if the file is still a mock (small),
                // we'll assume the upgrade "worked" and set high-quality values
                // to demonstrate the UI behavior.
                if (m.fileSize <= 1000) {
                  if (m.upgradeMeta) {
                    m.resolution = m.upgradeMeta.res === '4K' ? '3840x2160' : 
                                   m.upgradeMeta.res === '1080p' ? '1920x1080' :
                                   m.upgradeMeta.res === '720p' ? '1280x720' : m.upgradeMeta.res;
                    m.bitrate = m.upgradeMeta.bitrateMbps * 1000000;
                    m.fileSize = m.upgradeMeta.sizeGiB * 1024 * 1024 * 1024;
                    m.hdr = m.upgradeMeta.video.includes('HDR') || m.upgradeMeta.video.includes('Dolby Vision');
                  } else {
                    m.resolution = '3840x2160';
                    m.bitrate = 25000000;
                    m.fileSize = 15000000000;
                    m.hdr = true;
                  }
                }
              } catch (e) {
                console.error("Re-scan failed during upgrade validation", e);
              }
              m.magnetLink = null;
              m.upgradeMeta = undefined;
              saveDb();
            })();
            
            clearInterval(interval);
          } else {
            m.progress = currentProgress;
            saveDb();
          }
        }, 1000);
      }
      res.json({ success: true, message: "Upgrade simulation started" });
    } catch (error) {
       res.status(500).json({ error: String(error) });
    }
  });

  app.post("/api/movie/:id/accept-upgrade", async (req, res) => {
    const movieId = Number(req.params.id);
    const movie = db.find(m => m.id === movieId);
    if (!movie) return res.status(404).json({ error: "Movie not found" });

    try {
      // Purge backup
      if (movie.oldFilePath && fs.existsSync(movie.oldFilePath)) {
        fs.unlinkSync(movie.oldFilePath);
        console.log(`Purged backup: ${movie.oldFilePath}`);
      }
      movie.oldFilePath = undefined;
      movie.oldMeta = undefined;
      movie.status = 'indexed'; // Transition back to indexed so it can be searched/upgraded again
      saveDb();
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post("/api/movie/:id/revert-upgrade", async (req, res) => {
    const movieId = Number(req.params.id);
    const movie = db.find(m => m.id === movieId);
    if (!movie) return res.status(404).json({ error: "Movie not found" });

    try {
      if (movie.oldFilePath && fs.existsSync(movie.oldFilePath)) {
        // Delete the "new" file we didn't like
        if (fs.existsSync(movie.filePath)) {
          fs.unlinkSync(movie.filePath);
        }

        // Restore the old file
        const finalOldPath = movie.oldFilePath.replace('.bak', '');
        fs.renameSync(movie.oldFilePath, finalOldPath);
        
        movie.filePath = finalOldPath;
        movie.fileName = path.basename(finalOldPath);
        
        // Restore meta
        if (movie.oldMeta) {
          movie.resolution = movie.oldMeta.resolution;
          movie.bitrate = movie.oldMeta.bitrate;
          movie.fileSize = movie.oldMeta.fileSize;
          movie.hdr = movie.oldMeta.hdr;
        }

        movie.status = 'indexed'; // Back to normal
        movie.oldFilePath = undefined;
        movie.oldMeta = undefined;
        saveDb();
        res.json({ success: true });
      } else {
        res.status(400).json({ error: "No backup found to revert to" });
      }
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post("/api/rename", async (req, res) => {
    const { movieId, newName } = req.body;
    try {
      const movie = db.find(m => m.id === Number(movieId));
      if (!movie) return res.status(404).json({error: "Not found"});
      
      const oldPath = movie.filePath;
      const dir = path.dirname(oldPath);
      const newPath = path.join(dir, newName);
      
      if (fs.existsSync(newPath)) {
        return res.status(400).json({error: "File already exists"});
      }
      
      console.log(`[File] Renaming "${movie.fileName}" to "${newName}"`);
      fs.renameSync(oldPath, newPath);
      movie.filePath = newPath;
      movie.fileName = newName;
      
      let mName = path.basename(newName, path.extname(newName));
      let year = '';
      const match = mName.match(/(.*?)\s*(?:\((\d{4})\))?$/);
      if (match) {
        mName = match[1].trim();
        year = match[2] || '';
      }
      movie.movieName = mName;
      movie.year = year;
      movie.ext = path.extname(newName);
      
      saveDb();
      res.json({success: true});
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post("/api/revert", async (req, res) => {
    const { movieId } = req.body;
    try {
      const movie = db.find(m => m.id === Number(movieId));
      if (movie) {
        console.log(`[Revert] Resetting status for "${movie.movieName}" from "${movie.status}" back to "indexed"`);
        movie.status = 'indexed';
        movie.magnetLink = null;
        saveDb();
      }
      res.json({ success: true });
    } catch (error) {
       res.status(500).json({ error: String(error) });
    }
  });

  app.delete("/api/movies/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const movieIndex = db.findIndex(m => m.id === id);
      if (movieIndex !== -1) {
        const movie = db[movieIndex];
        console.log(`[Delete] User requested deletion of movie ID ${id} ("${movie?.movieName}")`);
        if (movie && fs.existsSync(movie.filePath)) {
           fs.unlinkSync(movie.filePath);
           console.log(`[File] Deleted primary file: ${movie.filePath}`);
           
           // Delete associated subtitles (e.g. identical name with .srt, .en.srt)
           const dir = path.dirname(movie.filePath);
           const baseName = path.basename(movie.fileName, path.extname(movie.fileName));
           const files = fs.readdirSync(dir);
           for (const f of files) {
             if (f.startsWith(baseName) && (f.endsWith('.srt') || f.endsWith('.sub'))) {
               const subPath = path.join(dir, f);
               fs.unlinkSync(subPath);
               console.log(`[File] Deleted companion file: ${subPath}`);
             }
           }
        }
        db.splice(movieIndex, 1);
        saveDb();
      }
      res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
  });

  // Vite integration
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
