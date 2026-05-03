import express from "express";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffprobeStatic from "ffprobe-static";

ffmpeg.setFfprobePath(ffprobeStatic.path);

const PORT = 3000;
const DB_PATH = path.join(process.cwd(), "media_library.json");

// Internal log buffer
const LOGS: string[] = [];
const MAX_LOGS = 200;

function logToBuffer(level: string, message: string) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${level}] ${message}`;
  LOGS.push(entry);
  if (LOGS.length > MAX_LOGS) LOGS.shift();
}

// Override console methods to capture logs
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args: any[]) => {
  originalLog(...args);
  logToBuffer('INFO', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};
console.warn = (...args: any[]) => {
  originalWarn(...args);
  logToBuffer('WARN', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};
console.error = (...args: any[]) => {
  originalError(...args);
  logToBuffer('ERROR', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};
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

// Helper to delete companion subtitle files
function deleteCompanionSubtitles(videoPath: string) {
  try {
    const dir = path.dirname(videoPath);
    const fileName = path.basename(videoPath);
    const baseName = path.basename(fileName, path.extname(fileName));
    const files = fs.readdirSync(dir);
    const subExts = ['.srt', '.sub', '.ass', '.vtt', '.idx'];
    
    for (const f of files) {
      if (f.startsWith(baseName)) {
        const lowerF = f.toLowerCase();
        if (subExts.some(ext => lowerF.endsWith(ext))) {
          const subPath = path.join(dir, f);
          if (fs.existsSync(subPath)) {
            fs.unlinkSync(subPath);
            console.log(`[File] Deleted companion subtitle: ${subPath}`);
          }
        }
      }
    }
  } catch (e) {
    console.error("Error deleting companion subtitles:", e);
  }
}

// Helper to download a file with progress reporting
const activeDownloads = new Map<number, AbortController>();
let isQueueActive = false;

async function runUpgrade(movieId: number) {
  const movie = db.find(m => m.id === Number(movieId));
  if (!movie || movie.status === 'upgrading') return;

  movie.status = 'upgrading';
  movie.progress = 0;
  saveDb();
  
  const isMock = movie.filePath.startsWith(MOCK_DIR);

  if (isMock) {
    // --- SIMULATION MODE ---
    console.log(`[Upgrade] SIMULATING upgrade for MOCK movie "${movie.movieName}"`);
    let currentProgress = 0;
    const interval = setInterval(() => {
      const m = db.find(x => x.id === Number(movieId));
      if (!m || m.status !== 'upgrading') {
        clearInterval(interval);
        return;
      }

      currentProgress += Math.floor(Math.random() * 15) + 10;
      if (currentProgress >= 100) {
        currentProgress = 100;
        m.status = 'upgraded';
        m.progress = 100;
        
        const oldPath = m.filePath;
        const parentDir = path.dirname(oldPath);
        const extension = movie.upgradeMeta?.extension || m.ext || '.mkv';
        const nameSegments = [m.movieName];
        if (m.year) nameSegments.push(`(${m.year})`);
        const finalFileName = sanitizeFileName(nameSegments.join(' ')) + extension;
        const finalPath = path.join(parentDir, finalFileName);

        try {
          if (fs.existsSync(oldPath)) fs.renameSync(oldPath, oldPath + '.bak');
          fs.writeFileSync(finalPath, "upgraded mock data");
          m.filePath = finalPath;
          m.fileName = finalFileName;
          m.ext = extension;
          m.status = 'verifying_upgrade';
          
          m.resolution = '3840x2160';
          m.bitrate = 65000000;
          m.hdr = true;
          m.fileSize = 45000000000;
        } catch (e) {}

        m.magnetLink = null;
        m.upgradeMeta = undefined;
        saveDb();
        clearInterval(interval);
      } else {
        m.progress = currentProgress;
        saveDb();
      }
    }, 300);
    return;
  }

  // --- REAL MODE ---
  if (!movie.magnetLink) {
     movie.status = 'indexed';
     saveDb();
     return;
  }

  const controller = new AbortController();
  activeDownloads.set(movie.id, controller);

  try {
    const oldPath = movie.filePath;
    const parentDir = path.dirname(oldPath);
    const extension = movie.upgradeMeta?.extension || movie.ext || path.extname(oldPath) || '.mkv';
    
    const baseFileName = movie.upgradeMeta?.filename || movie.upgradeMeta?.streamName;
    const stagingFileName = baseFileName 
      ? `${sanitizeFileName(baseFileName)}.tmp` 
      : `download_staging_${movie.id}.tmp`;
    const stagingPath = path.join(parentDir, stagingFileName);

    console.log(`[Upgrade] REAL Download starting for "${movie.movieName}"`);
    await downloadFile(movie.magnetLink!, stagingPath, (p) => {
      movie.progress = p;
      if (p % 5 === 0) saveDb();
    }, controller.signal);

    activeDownloads.delete(movie.id);

    const nameSegments = [movie.movieName];
    if (movie.year) nameSegments.push(`(${movie.year})`);
    const finalFileName = sanitizeFileName(nameSegments.join(' ')) + extension;
    const finalPath = path.join(parentDir, finalFileName);

    deleteCompanionSubtitles(oldPath);

    if (fs.existsSync(oldPath)) {
      let backupPath = oldPath + '.bak';
      if (fs.existsSync(backupPath)) backupPath = oldPath + '.' + Date.now() + '.bak';
      fs.renameSync(oldPath, backupPath);
      movie.oldFilePath = backupPath;
      movie.oldMeta = { resolution: movie.resolution, bitrate: movie.bitrate, fileSize: movie.fileSize, hdr: movie.hdr };
    }
    
    if (fs.existsSync(finalPath) && finalPath !== oldPath) fs.unlinkSync(finalPath);
    fs.renameSync(stagingPath, finalPath);

    movie.filePath = finalPath;
    movie.fileName = finalFileName;
    movie.ext = extension;
    movie.status = 'verifying_upgrade';
    movie.progress = 100;

    try {
      const meta = await getMediaMetadata(movie.filePath);
      const stat = fs.statSync(movie.filePath);
      movie.resolution = meta.resolution;
      movie.bitrate = meta.bitrate;
      movie.hdr = meta.hdr;
      movie.fileSize = stat.size;
    } catch (e) {}
    
    movie.magnetLink = null;
    movie.upgradeMeta = undefined;
    saveDb();

  } catch (err: any) {
    activeDownloads.delete(movie.id);
    if (err.name === 'AbortError') {
      console.log(`[Upgrade] CANCELED upgrade for "${movie.movieName}"`);
    } else {
      console.error(`[Upgrade] ERROR for "${movie.movieName}":`, err);
    }
    movie.status = 'indexed';
    movie.progress = 0;
    saveDb();
  }
}
async function downloadFile(url: string, destPath: string, onProgress: (progress: number) => void, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.statusText}`);
  }

  const totalSize = Number(response.headers.get('content-length')) || 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Could not get reader from response body");

  const writer = fs.createWriteStream(destPath);
  let downloadedSize = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      writer.write(value);
      downloadedSize += value.length;
      
      if (totalSize > 0) {
        const progress = Math.round((downloadedSize / totalSize) * 100);
        onProgress(progress);
      }
    }
  } catch (err) {
    writer.destroy();
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    throw err;
  } finally {
    writer.end();
    await new Promise<void>((resolve, reject) => {
      writer.on('finish', () => resolve());
      writer.on('error', (err) => reject(err));
    });
  }
}

// Help extract metadata via ffprobe
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

const MOCK_DIR = path.join(process.cwd(), "mock_media");

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
  
  // SAFETY: Mock files can ONLY be created in the designated MOCK_DIR
  if (!fs.existsSync(MOCK_DIR)) {
    fs.mkdirSync(MOCK_DIR, { recursive: true });
  }

  dummyFiles.forEach(file => {
    const fullPath = path.join(MOCK_DIR, file);
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

  app.get("/api/logs", (req, res) => {
    res.json({ logs: LOGS });
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

        // SKIP SUBTITLES
        const lowerFile = file.toLowerCase();
        const subExts = ['.srt', '.sub', '.ass', '.vtt', '.idx'];
        if (subExts.some(ext => lowerFile.endsWith(ext))) {
          continue;
        }

        // Parse Name & Year
        let baseName = path.basename(file, path.extname(file));
        let movieName = baseName.replace(/[\._]/g, " "); // Replace dots and underscores with spaces
        let year = '';
        
        // Try to find year in parentheses first (most reliable)
        const yearInParen = movieName.match(/\((19|20)\d{2}\)/);
        if (yearInParen) {
          year = yearInParen[0].replace(/[\(\)]/g, '');
          // Remove the specific year string that was inside parentheses
          movieName = movieName.replace(yearInParen[0], "");
        } else {
          // Look for year at the end of the string
          const yearAtEnd = movieName.match(/\b(19|20)\d{2}$/);
          if (yearAtEnd) {
            year = yearAtEnd[0];
            movieName = movieName.replace(yearAtEnd[0], "");
          } else {
             // Fallback: look for the last occurrence of a year-like number
             const matches = movieName.match(/\b(19|20)\d{2}\b/g);
             if (matches) {
               year = matches[matches.length - 1];
               // Only replace the last occurrence to avoid mangling titles like "2001"
               const lastIdx = movieName.lastIndexOf(year);
               movieName = movieName.slice(0, lastIdx) + movieName.slice(lastIdx + year.length);
             }
          }
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

    if (movie.status === 'upgrading' || movie.status === 'verifying_upgrade') {
      return res.status(400).json({ error: "Cannot unmatch while movie is being upgraded" });
    }

    console.log(`[TMDB] Removing match for "${movie.movieName}" (Old IMDB: ${movie.imdbId})`);
    movie.imdbId = null;
    movie.tmdbTitle = undefined;
    
    // Always reset status to indexed when unmatching
    movie.status = 'indexed';
    movie.magnetLink = null;
    movie.upgradeMeta = undefined;
    
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
        // ULTIMATE SAFETY: We ONLY allow bulk deletion if the folder is the designated MOCK_DIR
        // This prevents accidental wipes of real libraries if someone clicks "Delete Files" by mistake.
        if (mediaDir === MOCK_DIR || mediaDir.toLowerCase().includes('mock')) {
          if (fs.existsSync(mediaDir)) {
            const files = fs.readdirSync(mediaDir);
            for (const file of files) {
              const filePath = path.join(mediaDir, file);
              if (fs.statSync(filePath).isFile()) {
                fs.unlinkSync(filePath);
              }
            }
          }
           console.log(`[Safety] Bulk delete executed on safe mock directory: ${mediaDir}`);
        } else {
          console.warn(`[Safety] BLOCKED bulk delete request on real directory: ${mediaDir}`);
          return res.json({ 
            success: true, 
            message: "Database reset. File deletion was SKIPPED because you are using a real media folder (Safety Lock)." 
          });
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
      // Automatically switch the user's focus to the mock folder so they can see the results
      saveSettings({ targetFolder: MOCK_DIR });
      res.json({ success: true, message: "Mock files generated in ./mock_media and settings updated." });
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

  app.get("/api/queue/status", (req, res) => {
    const readyCount = db.filter(m => m.status === 'magnet_found').length;
    res.json({ isActive: isQueueActive, readyCount });
  });

  app.post("/api/queue/start", (req, res) => {
    isQueueActive = true;
    console.log("[Queue] Server-side upgrade queue STARTED.");
    res.json({ success: true });
  });

  app.post("/api/queue/stop", (req, res) => {
    isQueueActive = false;
    console.log("[Queue] Server-side upgrade queue STOPPED.");
    res.json({ success: true });
  });

  app.post("/api/upgrade", async (req, res) => {
    const { movieId } = req.body;
    try {
      const movie = db.find(m => m.id === Number(movieId));
      if (!movie) return res.status(404).json({ error: "Movie not found" });
      if (movie.status === 'upgrading') return res.status(400).json({ error: "Already upgrading" });
      
      // runUpgrade is async but we don't necessarily want to wait for the whole download here
      // if it's a real download. Simulation is also async.
      runUpgrade(Number(movieId)).catch(err => console.error("Async upgrade error:", err));
      
      res.json({ success: true, message: "Upgrade started" });
    } catch (error) {
       res.status(500).json({ error: String(error) });
    }
  });

  app.post("/api/cancel-upgrade", (req, res) => {
    const { movieId } = req.body;
    const controller = activeDownloads.get(Number(movieId));
    if (controller) {
      controller.abort();
      res.json({ success: true, message: "Download cancellation sent" });
    } else {
      const movie = db.find(m => m.id === Number(movieId));
      if (movie && movie.status === 'upgrading') {
        movie.status = 'indexed';
        movie.progress = 0;
        saveDb();
        res.json({ success: true, message: "Simulation canceled" });
      } else {
        res.status(404).json({ error: "No active download found" });
      }
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
           // Delete companion subtitles
           deleteCompanionSubtitles(movie.filePath);
           
           fs.unlinkSync(movie.filePath);
           console.log(`[File] Deleted primary file: ${movie.filePath}`);
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

  // Background Queue Worker
  setInterval(async () => {
    if (!isQueueActive) return;

    const isAnyUpgrading = db.some(m => m.status === 'upgrading');
    if (isAnyUpgrading) return;

    const nextMovie = db.find(m => m.status === 'magnet_found');
    if (nextMovie) {
      console.log(`[Queue] Background worker starting upgrade for: ${nextMovie.movieName}`);
      try {
        await runUpgrade(nextMovie.id);
      } catch (e) {
        console.error(`[Queue] Error processing queue for ${nextMovie.movieName}:`, e);
      }
    }
  }, 5000);
}

startServer();
