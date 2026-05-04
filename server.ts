import express from "express";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffprobeStatic from "ffprobe-static";
import readline from "readline";

ffmpeg.setFfprobePath(ffprobeStatic.path);

const PORT = 3000;
const DB_PATH = path.join(process.cwd(), "media_library.json");

const LOG_FILE_PATH = path.join(process.cwd(), "server.log");

// Internal log buffer
const LOGS: string[] = [];
const MAX_LOGS = 200;

try {
  if (fs.existsSync(LOG_FILE_PATH)) {
    const fileLogs = fs.readFileSync(LOG_FILE_PATH, 'utf-8').trim().split('\n');
    LOGS.push(...fileLogs.slice(-MAX_LOGS));
  }
} catch (e) {}

function logToBuffer(level: string, message: string) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${level}] ${message}`;
  LOGS.push(entry);
  if (LOGS.length > MAX_LOGS) LOGS.shift();
  try {
    fs.appendFileSync(LOG_FILE_PATH, entry + '\n');
  } catch (e) {}
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

// Removed redundant global signal handlers to consolidate at the end of the file
console.log("[Server] Server application starting.");
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
  streamCacheExpiryMinutes: number;
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
  streamCacheExpiryMinutes: 1440,
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
  const oldUrl = settingsCache.aiostreamsUrl;
  settingsCache = { ...settingsCache, ...newSettings };
  
  if (oldUrl !== settingsCache.aiostreamsUrl) {
    console.log(`[Settings] AIOStreams URL changed from "${oldUrl}" to "${settingsCache.aiostreamsUrl}". Clearing search cache.`);
    aiostreamsCache = {};
    saveAiostreamsCache();
  }
  
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settingsCache, null, 2));
}

function getMediaDir() {
  return settingsCache.targetFolder;
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[\u{1F300}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E0}-\u{1F1FF}]/gu, '') // Remove emojis and symbols
    .replace(/[<>:"/\\|?*]/g, '_') // Replace illegal chars with underscore
    .replace(/\s+/g, ' ') // Preserve spaces (collapse multiple to one)
    .replace(/\.{2,}/g, '.') // Collapse multiple dots into one
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
      let dbChanged = false;
      for (const movie of db) {
        if (!movie.fileName) {
          movie.fileName = path.basename(movie.filePath);
          dbChanged = true;
        }
        if (movie.status === 'upgrading' || movie.status === 'paused') {
          console.log(`[Boot] Found stuck upgrade/pause for "${movie.movieName}" (ID: ${movie.id}). Resetting to matched/indexed.`);
          movie.status = movie.imdbId ? 'matched' : 'indexed';
          movie.progress = 0;
          dbChanged = true;
        }
      }
      if (dbChanged) saveDb();
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

// Helper to generate a clean staging file name
function getStagingFileName(movie: Movie): string {
  let tempFileName = "";
  
  if (movie.upgradeMeta?.filename) {
    tempFileName = `${sanitizeFileName(movie.upgradeMeta.filename)}.tmp`;
  }

  if (!tempFileName && movie.magnetLink) {
    try {
      const u = new URL(movie.magnetLink);
      let pathname = decodeURIComponent(u.pathname);
      // Remove trailing slash if any
      if (pathname.endsWith('/')) {
        pathname = pathname.substring(0, pathname.length - 1);
      }
      const basename = path.basename(pathname);
      if (basename) {
         tempFileName = sanitizeFileName(basename) + ".tmp";
      }
    } catch (e) {}
  }
  
  if (!tempFileName) {
    tempFileName = `download_staging_${movie.id}.tmp`;
  }
  return tempFileName;
}

// Helper to download a file with progress reporting
const activeDownloads = new Map<number, AbortController>();
let isQueueActive = false;

async function runUpgrade(movieId: number) {
  const movie = db.find(m => m.id === Number(movieId));
  if (!movie || movie.status === 'upgrading') return;

  const isResuming = movie.status === 'paused';
  movie.status = 'upgrading';
  if (!isResuming) {
    movie.progress = 0;
  }
  saveDb();
  
  const isMock = movie.filePath.startsWith(MOCK_DIR) || (movie.upgradeMeta?.filename && movie.upgradeMeta.filename.includes('mock'));

  if (!movie.magnetLink && !isMock) {
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
    
    const stagingFileName = getStagingFileName(movie);
    const stagingPath = path.join(parentDir, stagingFileName);

    console.log(`[Upgrade] ${isMock ? 'SIMULATED' : 'REAL'} Download starting for "${movie.movieName}"`);
    
    // Call downloadFile which now handles both real and mock
    await downloadFile(movie.magnetLink || "mock-link", stagingPath, (p) => {
      movie.progress = p;
      if (p % 5 === 0) saveDb();
    }, controller.signal, isMock);

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

    if (isMock) {
      // For mocks, we simulate high-quality metadata so the test looks realistic
      movie.resolution = '3840x2160';
      movie.bitrate = 65000000;
      movie.hdr = true;
      movie.fileSize = 45000000000;
    } else {
      try {
        const meta = await getMediaMetadata(movie.filePath);
        const stat = fs.statSync(movie.filePath);
        movie.resolution = meta.resolution;
        movie.bitrate = meta.bitrate;
        movie.hdr = meta.hdr;
        movie.fileSize = stat.size;
      } catch (e) {}
    }
    
    movie.magnetLink = null;
    movie.upgradeMeta = undefined;
    saveDb();

  } catch (err: any) {
    const abortReason = err.target?.reason || err.reason || 'canceled';
    if (err.name === 'AbortError' && abortReason === 'paused') {
      console.log(`[Upgrade] PAUSED upgrade for "${movie.movieName}"`);
      movie.status = 'paused';
      // keep staging file
      saveDb();
    } else if (err.name === 'AbortError') {
      console.log(`[Upgrade] CANCELED upgrade for "${movie.movieName}"`);
      movie.status = 'magnet_found'; // Revert back so they can restart
      movie.progress = 0;
      
      const oldPath = movie.filePath;
      const parentDir = path.dirname(oldPath);
      const stagingFileName = getStagingFileName(movie);
      const stagingPath = path.join(parentDir, stagingFileName);
      try { if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath); } catch(e) {}
      
      saveDb();
    } else {
      console.error(`[Upgrade] ERROR for "${movie.movieName}":`, err?.message || err, err?.stack);
      // If we haven't made any progress, don't leave it in 'paused', revert to 'magnet_found'
      if ((movie.progress || 0) < 1) {
        movie.status = 'magnet_found';
        movie.progress = 0;
      } else {
        movie.status = 'paused'; 
      }
      saveDb();
    }
  } finally {
    activeDownloads.delete(Number(movieId));
  }
}
async function downloadFile(url: string, destPath: string, onProgress: (progress: number) => void, signal: AbortSignal, isMock = false): Promise<void> {

  if (isMock) {
    // --- SIMULATION PATH ---
    // Start from current progress if resuming
    let startProgress = 0;
    if (fs.existsSync(destPath)) {
      // We don't have total size here normally but we can guess or just start from 50
      startProgress = 50; 
    }
    
    for (let p = startProgress; p <= 100; p += 10) {
      if (signal.aborted) {
        throw new Error('AbortError');
      }
      onProgress(p);
      await new Promise(r => setTimeout(r, 400));
    }
    
    // Write the mock file at the very end
    fs.writeFileSync(destPath, "MOCK UPGRADED VIDEO CONTENT");
    return;
  }

  // --- REAL DOWNLOAD PATH ---
  let existingSize = 0;
  if (fs.existsSync(destPath)) {
    existingSize = fs.statSync(destPath).size;
  }

  const headers: HeadersInit = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*'
  };
  if (existingSize > 0) {
    headers['Range'] = `bytes=${existingSize}-`;
  }

  // Set a timeout for the initial connection phase
  const fetchController = new AbortController();
  const internalSignal = fetchController.signal;
  
  // Link the external signal to our internal one
  const onAbort = () => fetchController.abort();
  signal.addEventListener('abort', onAbort);
  
  const timeoutId = setTimeout(() => {
    fetchController.abort("timeout");
  }, 30000); // 30 second timeout for initial headers

  try {
    const response = await fetch(url, { headers, signal: internalSignal });
    clearTimeout(timeoutId);
    
    // Detect if we were redirected to a placeholder video
    const finalUrl = response.url.toLowerCase();
    if (finalUrl.includes('downloading.mp4') || finalUrl.includes('placeholder.mp4')) {
      throw new Error(`Redirected to a placeholder video: ${response.url}. The stream may still be caching.`);
    }

    if (!response.ok && response.status !== 206) {
      let errText = response.statusText;
      try { errText = await response.text(); } catch (e) {}
      throw new Error(`Failed to download: ${response.status} ${response.statusText} from ${response.url} - ${errText}`);
    }

    let totalSize = Number(response.headers.get('content-length')) || 0;
    let isResuming = response.status === 206;
    
    if (isResuming) {
      const contentRange = response.headers.get('content-range');
      if (contentRange) {
          const match = contentRange.match(/\/(\d+)$/);
          if (match) totalSize = Number(match[1]);
      } else {
          totalSize += existingSize;
      }
    } else if (existingSize > 0) {
        existingSize = 0; 
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Could not get reader from response body stream");

    const writer = fs.createWriteStream(destPath, { flags: isResuming ? 'a' : 'w' });
    let downloadedSize = existingSize;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        writer.write(value);
        downloadedSize += value.length;
        
        if (totalSize > 0) {
          const progress = Math.round((downloadedSize / totalSize) * 100);
          onProgress(Math.min(progress, 99));
        }
      }
      
      if (totalSize > 0 && downloadedSize < totalSize) {
         throw new Error("Incomplete download");
      }
    } catch (err) {
      writer.destroy();
      throw err;
    } finally {
      writer.end();
      await new Promise<void>((resolve) => {
        writer.on('finish', () => resolve());
        writer.on('error', () => resolve());
      });
    }
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener('abort', onAbort);
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
        
        let br = videoStream.bit_rate ? Number(videoStream.bit_rate) : (metadata.format.bit_rate ? Number(metadata.format.bit_rate) : 0);
        
        // If bitrate is missing from both stream and format, calculate it from duration and fileSize
        if (!br && metadata.format.duration && metadata.format.size) {
            const duration = Number(metadata.format.duration);
            const size = Number(metadata.format.size);
            if (duration > 0) {
                br = (size * 8) / duration;
            }
        }
        
        bitrate = br;
        
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
let nextTmdbCallTime = 0;

async function tmdbFetch(url: string) {
  const now = Date.now();
  const waitTime = Math.max(0, nextTmdbCallTime - now);
  nextTmdbCallTime = now + waitTime + TMDB_DELAY_MS;
  
  if (waitTime > 0) {
    await new Promise(r => setTimeout(r, waitTime));
  }
  
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

async function unrollAiostreamsLink(link: string): Promise<string | null> {
    try {
        console.log(`[Unroll] Probing: ${link}`);
        const probeRes = await fetch(link, { 
            method: 'GET', 
            redirect: 'manual',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*'
            }
        });
        
        // Handle direct redirects (Debrid/Torbox usually)
        if (probeRes.status >= 300 && probeRes.status < 400 && probeRes.headers.get('location')) {
            let loc = probeRes.headers.get('location');
            if (loc) {
                // Resolve relative redirects against the probe URL
                if (!loc.startsWith('http')) {
                    try {
                        loc = new URL(loc, link).toString();
                    } catch (e) {
                        console.warn(`[Unroll] Failed to resolve relative redirect: ${loc} using base ${link}`);
                    }
                }

                // If it's a known placeholder (like downloading.mp4), treat as failure
                if (loc.toLowerCase().includes('downloading.mp4') || loc.toLowerCase().includes('placeholder.mp4')) {
                   console.log(`[Unroll] Detected placeholder redirect: ${loc}. Ignoring.`);
                   return null;
                }

                return loc;
            }
        }

        // If it's already a direct debrid link (200 OK), return as is
        if (probeRes.ok) {
            const url = new URL(link);
            if (url.hostname.includes('torbox') || url.hostname.includes('real-debrid') || url.hostname.includes('alldebrid')) {
                return link;
            }
        }
        
        return null;
    } catch(err) {
        console.error("Error in unrollAiostreamsLink", err);
        return null;
    }
}

function getReleaseNameFromUrl(link: string): string {
    try {
        const url = new URL(link);
        const segments = url.pathname.split('/').filter(Boolean);
        let filename = segments.pop() || "";
        if (!filename && segments.length > 0) filename = segments.pop() || "";
        // Decode and strip query/hash
        filename = decodeURIComponent(filename).split('?')[0].split('#')[0];
        
        // If it looks like a hash or UUID (long hex/alphanumeric), it might not be a filename
        // But AIOStreams usually puts the filename at the very end of the path
        return filename;
    } catch (e) {
        return "";
    }
}

async function fetchImdbId(movieName: string, year: string): Promise<{ imdbId: string; tmdbTitle: string; year?: string } | null> {
  if (!settingsCache.tmdbApiKey) {
    console.error("[TMDB] TMDB_API_KEY is missing from settings");
    throw new Error("TMDB_API_KEY is not configured in settings. Please add your API Key in Settings.");
  }

  try {
    let searchUrl = `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(movieName)}`;
    if (year && year !== "Unknown") {
      searchUrl += `&year=${year}`;
    }
    
    console.log(`[TMDB] Searching for "${movieName}" ${year ? `(${year})` : ''}...`);
    let searchData = await tmdbFetch(searchUrl);
    
    if (searchData.results && searchData.results.length > 0) {
      const topResult = searchData.results[0];
      const tmdbId = topResult.id;
      const tmdbTitle = topResult.title;
      const releaseDate = topResult.release_date;
      const tmdbYear = releaseDate ? releaseDate.split("-")[0] : undefined;
      
      console.log(`[TMDB] Found result: "${tmdbTitle}" (${tmdbYear}) - ID: ${tmdbId}. Fetching external IDs...`);
      
      let extUrl = `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids`;
      let extData = await tmdbFetch(extUrl);
      
      if (extData.imdb_id) {
        return { imdbId: extData.imdb_id, tmdbTitle, year: tmdbYear };
      } else {
        console.warn(`[TMDB] No IMDB ID associated with TMDB ID ${tmdbId} ("${tmdbTitle}")`);
      }
    } else {
       console.warn(`[TMDB] No search results for "${movieName}"`);
    }
  } catch (error: any) {
    console.error(`[TMDB] Error fetching IMDB ID for ${movieName}:`, error.message || error);
    throw error; // Re-throw to be caught by the API handler
  }
  return null;
}

// --- AIOStreams Rate Limiting, Fetching & Caching ---
const AIOSTREAMS_DELAY_MS = 1000; // Let's be polite: 1 req/sec
let nextAiostreamsCallTime = 0;

const AIOSTREAMS_CACHE_PATH = path.join(process.cwd(), "aiostreams_cache.json");

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
      const ttlMs = (settingsCache.streamCacheExpiryMinutes || 1440) * 1000 * 60;
      for (const [id, entry] of Object.entries(aiostreamsCache)) {
        if (now - entry.timestamp < ttlMs * 7) { 
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

function containsAiostreamsError(data: any): string | null {
  if (data && data.streams && Array.isArray(data.streams)) {
    const errorStream = data.streams.find((s: any) => 
      s.streamData?.type === 'error' || 
      s.type === 'error' || 
      (s.name && (s.name.includes('[❌]') || s.name.includes('reconfigure'))) || 
      (s.title && (s.title.includes('[❌]') || s.title.includes('reconfigure'))) ||
      (s.description && (s.description.includes('[❌]') || s.description.includes('reconfigure')))
    );

    if (errorStream) {
      return errorStream.title || errorStream.name || errorStream.description || "AIOStreams configuration error";
    }
  }
  return null;
}

async function aiostreamsSearch(imdbId: string, forceRefresh = false) {
  const baseUrl = settingsCache.aiostreamsUrl;
  
  if (!baseUrl) {
    throw new Error("AIOStreams URL is not configured. Please add your AIOStreams Manifest URL in Settings.");
  }

  console.log(`[Search] Function entry. Using AIOStreams Base URL: ${baseUrl}`);

  const cached = aiostreamsCache[imdbId];
  const ttlMs = (settingsCache.streamCacheExpiryMinutes || 1440) * 1000 * 60;

  if (!forceRefresh && cached) {
    const age = Date.now() - cached.timestamp;
    if (age < ttlMs) {
      // Check if cached data contains an error stream or is empty before returning as HIT
      const errorMsg = containsAiostreamsError(cached.data);
      const streamsCount = (cached.data.streams && Array.isArray(cached.data.streams)) ? cached.data.streams.length : 0;
      if (!errorMsg && streamsCount > 0) {
        console.log(`[Cache] HIT for ${imdbId} (Age: ${Math.round(age/1000/60)}m, Streams: ${streamsCount}). Skipping network call.`);
        return cached.data;
      } else {
        console.log(`[Cache] Found cached ${errorMsg ? "error" : "empty results"} for ${imdbId}. Ignoring cache and re-fetching.`);
      }
    } else {
      console.log(`[Cache] EXPIRED for ${imdbId} (Age: ${Math.round(age/1000/60)}m). Will re-fetch.`);
    }
  } else if (forceRefresh) {
    console.log(`[Cache] FORCE refresh for ${imdbId}.`);
  } else {
    console.log(`[Cache] MISS for ${imdbId}.`);
  }
  
  // Basic validation - should have some path if it's a configured instance
  try {
    const parsed = new URL(baseUrl);
    // If it ends in manifest.json, we want to strip it for the API calls
    // But we use the base for the /stream/... endpoint construction anyway.
    
    // Check if it looks like a manifest URL but might be missing the "TOKEN" part
    // Many AIOStreams instances use /TOKEN/manifest.json
    if (parsed.pathname === "/" || parsed.pathname === "" || parsed.pathname === "/manifest.json") {
        throw new Error("AIOStreams URL is incomplete. It seems to be missing the configuration token. Please ensure you copied the FULL manifest URL from the AIOStreams configuration page.");
    }
  } catch (e: any) {
     if (e.message.includes("is incomplete")) throw e;
     throw new Error(`Invalid AIOStreams URL format: ${e.message}`);
  }

  const reqNow = Date.now();
  const waitTime = Math.max(0, nextAiostreamsCallTime - reqNow);
  nextAiostreamsCallTime = reqNow + waitTime + AIOSTREAMS_DELAY_MS;
  
  if (waitTime > 0) {
    await new Promise(r => setTimeout(r, waitTime));
    
    // Check cache again after wait
    const cachedAfterWait = aiostreamsCache[imdbId];
    if (!forceRefresh && cachedAfterWait && (Date.now() - cachedAfterWait.timestamp < ttlMs)) {
      const errorMsg = containsAiostreamsError(cachedAfterWait.data);
      const streamsCount = (cachedAfterWait.data.streams && Array.isArray(cachedAfterWait.data.streams)) ? cachedAfterWait.data.streams.length : 0;
      if (!errorMsg && streamsCount > 0) {
        console.log(`[Cache] HIT after wait for ${imdbId} (Streams: ${streamsCount}). Skipping network call.`);
        return cachedAfterWait.data;
      }
    }
  }
  
  // Clean trailing slash and manifest.json if present
  let normalizedBase = baseUrl.replace(/\/$/, '');
  if (normalizedBase.endsWith('/manifest.json')) {
    normalizedBase = normalizedBase.substring(0, normalizedBase.length - '/manifest.json'.length);
  }
  
  const url = `${normalizedBase}/stream/movie/${imdbId}.json`;
  
  console.log(`[Network] Calling AIOStreams: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
      if (res.status === 404) {
          throw new Error(`AIOStreams returned 404. Your configuration token might be wrong or the instance is down.`);
      }
      throw new Error(`AIOStreams HTTP Error: ${res.status}`);
  }
  const data = await res.json();
  
  // Detect AIOStreams configuration errors
  const errorMsg = containsAiostreamsError(data);
  if (errorMsg) {
    console.log(`[Network] AIOStreams error detected: ${errorMsg}`);
    throw new Error(`AIOStreams Error: ${errorMsg}. Your provider URL in Settings is likely missing required configuration or is outdated.`);
  }

  const streamsCount = (data.streams && Array.isArray(data.streams)) ? data.streams.length : 0;
  if (streamsCount === 0) {
    console.log(`[Network] AIOStreams returned 0 streams for ${imdbId}. Not caching to allow immediate retry.`);
    return data;
  }

  aiostreamsCache[imdbId] = { timestamp: Date.now(), data };
  saveAiostreamsCache();
  return data;
}

const MOCK_DIR = path.join(process.cwd(), "mock_media");

// Ensure dummy files exist to test scanning
function createMockMediaFiles() {
  // Clear mock directory to avoid mixing old/new formats
  if (fs.existsSync(MOCK_DIR)) {
    const files = fs.readdirSync(MOCK_DIR);
    for (const file of files) {
      const p = path.join(MOCK_DIR, file);
      if (fs.statSync(p).isFile()) fs.unlinkSync(p);
    }
  } else {
    fs.mkdirSync(MOCK_DIR, { recursive: true });
  }

  const dummyMovies = [
    "Inception (2010)",
    "The Matrix (1999)",
    "Dune Part Two (2024)",
    "Bad Movie",
    "Interstellar (2014)",
    "Avatar The Way of Water",
    "The Dark Knight (2008)",
    "Pulp Fiction",
    "Avengers Endgame (2019)",
    "Spider-Man No Way Home",
    "Jurassic Park (1993)",
    "Gladiator (2000)",
    "Titanic",
    "The Lord of the Rings The Fellowship of the Ring (2001)",
    "Mad Max Fury Road (2015)",
    "The Godfather (1972)"
  ];

  const exts = [".mkv", ".mp4", ".webm", ".avi"];
  
  // SAFETY: Mock files can ONLY be created in the designated MOCK_DIR
  if (!fs.existsSync(MOCK_DIR)) {
    fs.mkdirSync(MOCK_DIR, { recursive: true });
  }

  dummyMovies.forEach((movie, i) => {
    const ext = exts[i % exts.length];
    const filename = `${movie}${ext}`;
    const fullPath = path.join(MOCK_DIR, filename);
    if (!fs.existsSync(fullPath)) {
      try {
        fs.writeFileSync(fullPath, "mock video data");
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
      const { tmdbApiKey, aiostreamsUrl, targetFolder, streamResFilter, streamVideoFilter, streamAudioFilter, streamMinBitrate, streamMaxBitrate, streamCacheExpiryMinutes, theme } = req.body;
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
        streamCacheExpiryMinutes: streamCacheExpiryMinutes ?? settingsCache.streamCacheExpiryMinutes,
        theme: theme ?? settingsCache.theme,
      });
      console.log(`[API] Settings updated successfully.`);
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

  app.delete("/api/logs", (req, res) => {
    try {
      LOGS.length = 0;
      if (fs.existsSync(LOG_FILE_PATH)) {
        fs.writeFileSync(LOG_FILE_PATH, "");
      }
      res.json({ success: true });
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
      console.log("[API] Scan of local media folder requested");
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
        movieName = movieName.replace(/\b(4k|2160p|1080p|720p|480p|remux|bluray|x264|x265|h264|h265|hevc|avc|internal|dts|dd5|dual|audio|hdr|fhd|hd|sd|bdrip|brrip|webrip|web-dl|dvdrip|xvid|ac3|aac|repack|proper)\b/gi, " ");
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
           const hash = file.split('').reduce((a,b) => {a=((a<<5)-a)+b.charCodeAt(0);return a&a},0);
           const q = Math.abs(hash) % 4;

           if (q === 0) { // 4K Tier
             resolution = '3840x2160';
             bitrate = 65000000;
             fileSize = 55000000000;
             hdr = true;
           } else if (q === 1) { // 1080p Tier
             resolution = '1920x1080';
             bitrate = 12000000;
             fileSize = 9500000000;
             hdr = false;
           } else if (q === 2) { // 720p Tier
             resolution = '1280x720';
             bitrate = 4500000;
             fileSize = 2400000000;
             hdr = false;
           } else { // 480p Tier
             resolution = '720x480';
             bitrate = 1500000;
             fileSize = 850000000;
             hdr = false;
           }
           
           // Add slight variation for realism
           bitrate += (Math.abs(hash) % 500000);
           fileSize += (Math.abs(hash) % 100000000);
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

    console.log(`[API] Manual TMDB match requested for "${movie.movieName}" (ID: ${movieId})`);

    try {
      if (!movie.movieName) {
        return res.status(400).json({ error: "Movie name is empty, cannot search TMDB" });
      }

      const result = await fetchImdbId(movie.movieName, movie.year);
      if (result) {
        movie.imdbId = result.imdbId;
        movie.tmdbTitle = result.tmdbTitle;
        console.log(`[TMDB] Successfully matched "${movie.movieName}" to IMDB: ${result.imdbId} (${result.tmdbTitle})`);
        
        if (result.year && (!movie.year || movie.year === "")) {
          movie.year = result.year;
        }
        saveDb();
        res.json({ success: true, imdbId: result.imdbId, tmdbTitle: result.tmdbTitle, year: movie.year });
      } else {
        console.warn(`[TMDB] No match found for "${movie.movieName}" (${movie.year || 'No Year'})`);
        res.status(404).json({ error: `No match found on TMDB for "${movie.movieName}"` });
      }
    } catch (err: any) {
      console.error(`[API] TMDB Match Error for "${movie.movieName}":`, err.message || err, err.stack);
      res.status(500).json({ error: err.message || String(err) });
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
      
      // Let the standard scan endpoint handle the scanning to avoid logic duplication
      res.json({ success: true, message: `Mock files generated in the mock directory. Please click Scan to refresh the library.` });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Search using AIOStreams
  app.post("/api/search", async (req, res) => {
    const { movieId, minRes, minBitrate, force } = req.body;
    try {
      const movie = db.find(m => m.id === Number(movieId));
      if (!movie) return res.status(404).json({ error: "Movie not found" });

      if (!movie.imdbId) {
        return res.status(400).json({ error: "Cannot search without an IMDB ID. Please ensure TMDB API key is set and file has a valid name." });
      }

      const streamData = await aiostreamsSearch(movie.imdbId, force === true);
      const streams = streamData.streams || [];
      console.log(`[Search] Found ${streams.length} valid streams for IMDB ID: ${movie.imdbId}`);

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
    } catch (error: any) {
      console.error(`[Search] Error:`, error);
      res.status(500).json({ error: error.message || String(error) });
    }
  });

  app.post("/api/movie/:id/set-stream", async (req, res) => {
    const movieId = Number(req.params.id);
    let { link, meta } = req.body;
    const movie = db.find(m => m.id === movieId);
    if (!movie) return res.status(404).json({ error: "Movie not found" });
    
    if (!link) return res.status(400).json({ error: "Link is required" });

    // Unroll ephemeral proxy URLs immediately before they expire
    try {
        const originalLink = link;
        const isProxyLink = link.includes('/api/v1/debrid/playback') || link.includes('/stream/') || link.includes('aiostreams');
        
        // Ensure meta has a filename if possible from the original URL before unrolling
        if (!meta) meta = {};
        if (!meta.filename) {
            const guessedName = getReleaseNameFromUrl(originalLink);
            // AIOStreams URLs usually have the filename as the last segment
            // We ignore generic segments like 'playback' or 'stream'
            const ignored = ['playback', 'stream', 'api', 'v1', 'debrid', 'stremio', 'manifest', 'json'];
            if (guessedName && !ignored.includes(guessedName.toLowerCase())) {
                console.log(`[Proxy Link] Guessed filename from original URL: ${guessedName}`);
                meta.filename = guessedName;
            }
        }

        if (isProxyLink) {
            console.log(`[Proxy Link] Processing ephemeral URL: ${link}`);
            let dest = await unrollAiostreamsLink(link);
            
            // If it failed to unroll (likely expired), try refreshing if we have an IMDB ID
            if (!dest && movie.imdbId) {
                console.log(`[Proxy Link] Link check failed (possibly expired). Attempting background refresh for ${movie.imdbId}...`);
                const releaseName = getReleaseNameFromUrl(link);
                if (releaseName && releaseName.length > 5) {
                    const freshStreams = await aiostreamsSearch(movie.imdbId, true); // force refresh
                    const freshStream = freshStreams.streams.find((s: any) => {
                        const sUrl = s.url || s.link || s.externalUrl || "";
                        return sUrl && sUrl.toLowerCase().includes(releaseName.toLowerCase());
                    });
                    
                    if (freshStream) {
                        const freshLink = freshStream.url || freshStream.link || freshStream.externalUrl;
                        console.log(`[Proxy Link] Found matching fresh stream. Attempting re-unroll...`);
                        dest = await unrollAiostreamsLink(freshLink);
                    } else {
                        console.log(`[Proxy Link] Could not find a stream matching release name: ${releaseName}`);
                    }
                }
            }

            if (dest) {
                console.log(`[Proxy Link] Successfully finalized link: ${dest}`);
                link = dest;
            } else {
                console.warn(`[Proxy Link] Warning: Could not resolve to a stable download link. Proceeding with original but it may 400.`);
            }
        }
    } catch(err) {
        console.error(`[Proxy Link] Error during link finalization:`, err);
    }

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
    } catch (error: any) {
       res.status(500).json({ error: error.message || String(error) });
    }
  });

  app.post("/api/pause-upgrade", (req, res) => {
    const { movieId } = req.body;
    console.log(`[API] Pause requested for Movie ID: ${movieId}`);
    const controller = activeDownloads.get(Number(movieId));
    if (controller) {
      // Aborting the fetch signal will throw AbortError
      // Our catch block will see AbortError and mark as 'paused'
      controller.abort("paused");
      res.json({ success: true, message: "Download paused" });
    } else {
      const movie = db.find(m => m.id === Number(movieId));
      if (movie && movie.status === 'upgrading') {
        movie.status = 'paused';
        saveDb();
        res.json({ success: true, message: "Simulation paused" });
      } else {
        res.status(404).json({ error: "No active download found" });
      }
    }
  });

  app.post("/api/resume-upgrade", async (req, res) => {
    const { movieId } = req.body;
    console.log(`[API] Resume requested for Movie ID: ${movieId}`);
    try {
      const movie = db.find(m => m.id === Number(movieId));
      if (!movie) return res.status(404).json({ error: "Movie not found" });
      if (movie.status !== 'paused') return res.status(400).json({ error: "Not paused" });
      
      runUpgrade(Number(movieId)).catch(err => console.error("Async resume error:", err));
      res.json({ success: true, message: "Upgrade resumed" });
    } catch (error: any) {
       res.status(500).json({ error: error.message || String(error) });
    }
  });

  app.post("/api/cancel-upgrade", (req, res) => {
    const { movieId } = req.body;
    console.log(`[API] Cancel requested for Movie ID: ${movieId}`);
    const controller = activeDownloads.get(Number(movieId));
    if (controller) {
      controller.abort("canceled");
      activeDownloads.delete(Number(movieId));
      res.json({ success: true, message: "Download cancellation sent" });
    } else {
      const movie = db.find(m => m.id === Number(movieId));
      if (movie && (movie.status === 'upgrading' || movie.status === 'paused')) {
        movie.status = 'magnet_found'; // Revert state so they can try again if they want
        movie.progress = 0;
        
        // Remove temp file
        const oldPath = movie.filePath;
        const parentDir = path.dirname(oldPath);
        const stagingFileName = getStagingFileName(movie);
        const stagingPath = path.join(parentDir, stagingFileName);
        try { if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath); } catch(e) {}
        
        saveDb();
        res.json({ success: true, message: "Download canceled" });
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
        const finalOldPath = movie.oldFilePath.replace(/(\.\d+)?\.bak$/, "");
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

  let viteServer: any;
  // Vite integration
  if (process.env.NODE_ENV !== "production") {
    viteServer = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(viteServer.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  const gracefulShutdown = () => {
    console.log("\n[Server] Shutdown signal received. Closing server handles...");
    
    // Stop reading input to allow process to exit
    process.stdin.pause();
    
    if (viteServer) {
      viteServer.close().catch(() => {});
    }
    
    server.close(() => {
      console.log("[Server] HTTP server stopped.");
    });
    
    // Force exit after a tiny delay to ensure logs are flushed but port is freed
    setTimeout(() => {
      console.log("[Server] Process exiting. (PID: " + process.pid + ")");
      process.exit(0);
    }, 200).unref();
  };

  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
  process.on('uncaughtException', (err: Error) => {
    console.error(`[Server] UNCAUGHT EXCEPTION: ${err.message}`, err.stack);
    process.exit(1);
  });

  // Dual-mode input handling for best compatibility
  const setupInput = () => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    rl.on('line', (line) => {
      const input = line.trim().toLowerCase();
      if (input === 'q' || input === 'exit' || input === 'stop') {
        gracefulShutdown();
      }
    });

    // Special handling for Ctrl+C manually if needed, 
    // though SIGINT process listener usually handles it when not in raw mode.
    rl.on('SIGINT', () => {
      gracefulShutdown();
    });

    if (process.stdin.isTTY) {
      console.log("[Server] Interactive terminal detected. Type 'q' or Press Ctrl+C to stop.");
    } else {
      console.log("[Server] Pipe mode detected. Type 'q' + Enter to stop.");
    }
  };

  setupInput();

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
