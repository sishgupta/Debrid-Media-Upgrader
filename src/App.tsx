import React, { useState, useEffect } from 'react';
import { Search, RefreshCw, Download, Trash2, Edit2, Play, Pause, Settings2, Filter, HardDrive, Undo2, X, Fingerprint, Database, Check, RotateCcw, Ban, Terminal, AlertCircle } from 'lucide-react';
import axios from 'axios';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import * as Slider from '@radix-ui/react-slider';
import StreamSelectorModal from './components/StreamSelectorModal';

const EXPIRY_OPTIONS = [1, 3, 5, 10, 15, 30, 60, 120, 240, 480, 720, 1440];

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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

export default function App() {
  const [movies, setMovies] = useState<Movie[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [maxResFilter, setMaxResFilter] = useState('');
  const [maxBitrateFilter, setMaxBitrateFilter] = useState('');
  const [extFilter, setExtFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [fileNameFilter, setFileNameFilter] = useState('');
  const [matchingMovies, setMatchingMovies] = useState<Set<number>>(new Set());

  const [sortConfig, setSortConfig] = useState<{ key: keyof Movie | null, direction: 'asc' | 'desc' }>({ key: null, direction: 'asc' });

  const [movieToDelete, setMovieToDelete] = useState<Movie | null>(null);
  const [movieToRename, setMovieToRename] = useState<Movie | null>(null);
  const [newName, setNewName] = useState("");
  const [modalLoading, setModalLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [resetConfirmMode, setResetConfirmMode] = useState(false);
  const [settingsForm, setSettingsForm] = useState({
    tmdbApiKey: '',
    aiostreamsUrl: '',
    targetFolder: '',
    streamResFilter: 'All',
    streamVideoFilter: 'All',
    streamAudioFilter: 'All',
    streamMinBitrate: 0,
    streamMaxBitrate: 100,
    streamCacheExpiryMinutes: 1440,
    theme: 'dark' as 'light' | 'dark' | 'system'
  });
  const [streamSelectorData, setStreamSelectorData] = useState<{movieId: number, streams: any[]} | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [isQueueActive, setIsQueueActive] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const isTmdbConfigured = !!settingsForm.tmdbApiKey;
  const isAiostreamsConfigured = !!settingsForm.aiostreamsUrl;

  const handleClearLogs = async () => {
    try {
      await axios.delete('/api/logs');
      setLogs([]);
    } catch (err) {
      console.error("Error clearing logs", err);
    }
  };

  useEffect(() => {
    let interval: any;
    if (showLogs) {
      const fetchLogs = async () => {
        try {
          const res = await axios.get('/api/logs');
          setLogs(res.data.logs);
        } catch (err) {
          console.error(err);
        }
      };
      fetchLogs();
      interval = setInterval(fetchLogs, 2000);
    }
    return () => clearInterval(interval);
  }, [showLogs]);

  // Fetch movies
  const fetchMovies = async () => {
    try {
      const res = await axios.get('/api/movies');
      setMovies(res.data);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchSettings = async () => {
    try {
      const res = await axios.get('/api/settings');
      setSettingsForm(res.data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchMovies();
    fetchSettings();
  }, []);

  useEffect(() => {
    const applyTheme = (theme: 'light' | 'dark' | 'system') => {
      const root = window.document.documentElement;
      root.classList.remove('light', 'dark');

      if (theme === 'system') {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const systemTheme = mq.matches ? 'dark' : 'light';
        root.classList.add(systemTheme);

        const handler = (e: MediaQueryListEvent) => {
          root.classList.remove('light', 'dark');
          root.classList.add(e.matches ? 'dark' : 'light');
        };

        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
      } else {
        root.classList.add(theme);
      }
    };

    const cleanup = applyTheme(settingsForm.theme);
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, [settingsForm.theme]);

  // Remove frontend Queue Manager and replace with server status polling
  useEffect(() => {
    let interval: any;
    const fetchQueueStatus = async () => {
      try {
        const res = await axios.get('/api/queue/status');
        setIsQueueActive(res.data.isActive);
      } catch (err) {
        console.error("Error fetching queue status", err);
      }
    };

    fetchQueueStatus();
    interval = setInterval(fetchQueueStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  // Polling for background tasks
  useEffect(() => {
    const hasTransitionalMovies = movies.some(m => ['fetching_metadata', 'upgrading', 'verifying_upgrade'].includes(m.status));
    
    if (hasTransitionalMovies || isQueueActive) {
      const interval = setInterval(fetchMovies, 3000);
      return () => clearInterval(interval);
    }
  }, [movies, isQueueActive]);

  const handleGenerateMocks = async () => {
    setGlobalError(null);
    try {
      setModalLoading(true);
      const res = await axios.post('/api/generate-mocks');
      setGlobalError(`Success: ${res.data.message || "Mock files generated."}`);
      fetchMovies();
      fetchSettings(); // Update target folder if it changed
    } catch (e: any) {
      setGlobalError(e.response?.data?.error || "Error generating mocks");
    } finally {
      setModalLoading(false);
    }
  };

  const saveSettings = async () => {
    setModalLoading(true);
    try {
      await axios.post('/api/settings', settingsForm);
      setShowSettings(false);
    } catch (e: any) {
      setGlobalError(e.response?.data?.error || "Error saving settings");
    } finally {
      setModalLoading(false);
    }
  };

  const handleScan = async () => {
    setIsLoading(true);
    setGlobalError(null);
    try {
      await axios.post('/api/scan');
      await fetchMovies();
    } catch (e: any) {
      setGlobalError(e.response?.data?.error || e.message || "Error scanning");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearch = async (movieId: number, force = false) => {
    if (!isAiostreamsConfigured) {
      setGlobalError("AIOStreams URL missing. Please configure it in Settings.");
      setShowSettings(true);
      return;
    }
    setGlobalError(null);
    // Open modal in loading state immediately
    setStreamSelectorData({ movieId, streams: [], isLoading: true });
    
    try {
      const res = await axios.post('/api/search', { movieId, minRes: maxResFilter, minBitrate: maxBitrateFilter, force });
      setStreamSelectorData({ movieId, streams: res.data.streams || [], isLoading: false });
    } catch (e: any) {
      const msg = e.response?.data?.error || e.message || "Error searching";
      setGlobalError(msg);
      setStreamSelectorData(null);
      console.error("[Search Error]", msg);
    }
  };

  const handleSelectStream = async (movieId: number, link: string, meta: any) => {
     setGlobalError(null);
     try {
       await axios.post(`/api/movie/${movieId}/set-stream`, { link, meta });
       setStreamSelectorData(null);
       await fetchMovies();
     } catch (e: any) {
       setGlobalError(e.response?.data?.error || "Error setting stream");
     }
  };

  const handleUpgrade = async (movieId: number) => {
    setGlobalError(null);
    try {
      await axios.post('/api/upgrade', { movieId });
      await fetchMovies();
    } catch (e: any) {
      setGlobalError(e.response?.data?.error || e.message || "Error upgrading");
    }
  };

  const cancelUpgrade = async (movieId: number) => {
    setGlobalError(null);
    try {
      await axios.post('/api/cancel-upgrade', { movieId });
      await fetchMovies();
    } catch (e: any) {
      setGlobalError(e.response?.data?.error || e.message || "Error canceling upgrade");
    }
  };

  const pauseUpgrade = async (movieId: number) => {
    setGlobalError(null);
    try {
      await axios.post('/api/pause-upgrade', { movieId });
      await fetchMovies();
    } catch (e: any) {
      setGlobalError(e.response?.data?.error || e.message || "Error pausing upgrade");
    }
  };

  const resumeUpgrade = async (movieId: number) => {
    setGlobalError(null);
    try {
      await axios.post('/api/resume-upgrade', { movieId });
      await fetchMovies();
    } catch (e: any) {
      setGlobalError(e.response?.data?.error || e.message || "Error resuming upgrade");
    }
  };

  const handleAcceptUpgrade = async (movieId: number) => {
    setGlobalError(null);
    try {
      await axios.post(`/api/movie/${movieId}/accept-upgrade`);
      await fetchMovies();
    } catch (e: any) {
      setGlobalError(e.response?.data?.error || "Error accepting upgrade");
    }
  };

  const handleRevertUpgrade = async (movieId: number) => {
    setGlobalError(null);
    try {
      await axios.post(`/api/movie/${movieId}/revert-upgrade`);
      await fetchMovies();
    } catch (e: any) {
      setGlobalError(e.response?.data?.error || "Error reverting upgrade");
    }
  };

  const handleUpgradeAll = async () => {
    const readyMovies = movies.filter(m => m.status === 'magnet_found');
    if (readyMovies.length === 0 && !isQueueActive) return;
    
    try {
      if (isQueueActive) {
        await axios.post('/api/queue/stop');
        setIsQueueActive(false);
      } else {
        await axios.post('/api/queue/start');
        setIsQueueActive(true);
      }
    } catch (e: any) {
      setGlobalError(e.response?.data?.error || "Error toggling queue");
    }
  };

  const handleDelete = async (movie: Movie) => {
    setMovieToDelete(movie);
  };

  const confirmDelete = async () => {
    if (!movieToDelete) return;
    setModalLoading(true);
    try {
      await axios.delete(`/api/movies/${movieToDelete.id}`);
      await fetchMovies();
      setMovieToDelete(null);
    } catch (e) {
      console.error(e);
    } finally {
      setModalLoading(false);
    }
  };

  const handleRename = (movie: Movie) => {
    setMovieToRename(movie);
    setNewName(movie.fileName);
  };

  const confirmRename = async () => {
    if (!movieToRename || !newName || newName === movieToRename.fileName) {
      setMovieToRename(null);
      return;
    }
    setModalLoading(true);
    try {
      await axios.post('/api/rename', { movieId: movieToRename.id, newName });
      await fetchMovies();
      setMovieToRename(null);
    } catch (e: any) {
      setGlobalError(e.response?.data?.error || "Error renaming file");
    } finally {
      setModalLoading(false);
    }
  };

  const handleRevert = async (movieId: number) => {
    setGlobalError(null);
    try {
      await axios.post('/api/revert', { movieId });
      await fetchMovies();
    } catch (e: any) {
      setGlobalError(e.response?.data?.error || e.message || "Error reverting");
    }
  };

  const handleMatchTmdb = async (movieId: number) => {
    if (!isTmdbConfigured) {
      setGlobalError("TMDB API Key missing. Please configure it in Settings.");
      setShowSettings(true);
      return;
    }
    setMatchingMovies(prev => new Set(prev).add(movieId));
    setGlobalError(null);
    try {
      console.log(`[Frontend] Triggering TMDB match for movie ${movieId}`);
      await axios.post(`/api/movie/${movieId}/tmdb`);
      await fetchMovies();
    } catch (e: any) {
      console.error(`[Frontend] TMDB match failed for movie ${movieId}`, e);
      setGlobalError(e.response?.data?.error || "Error matching TMDB");
    } finally {
      setMatchingMovies(prev => {
        const next = new Set(prev);
        next.delete(movieId);
        return next;
      });
    }
  };

  const handleUnmatchTmdb = async (movieId: number) => {
    try {
      await axios.post(`/api/movie/${movieId}/unmatch`);
      await fetchMovies();
    } catch (e: any) {
      setGlobalError(e.response?.data?.error || "Error unmatching TMDB");
    }
  };

  const handleResetDb = async (deleteFiles: boolean) => {
    try {
      setModalLoading(true);
      await axios.post('/api/reset', { deleteFiles });
      await fetchMovies();
      setResetConfirmMode(false);
      setShowSettings(false);
    } catch (e: any) {
      setGlobalError(e.response?.data?.error || "Error resetting database");
    } finally {
      setModalLoading(false);
    }
  };

  const parseRes = (resStr: string) => {
    if (!resStr) return 0;
    const [w, h] = resStr.split('x').map(Number);
    return w || 0;
  };

  const requestSort = (key: keyof Movie) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const filteredMovies = React.useMemo(() => {
    let result = movies.filter(m => {
      // Text search should be primary filter
      if (fileNameFilter) {
        const search = fileNameFilter.toLowerCase();
        const matchesName = m.movieName?.toLowerCase().includes(search);
        const matchesFile = m.fileName?.toLowerCase().includes(search);
        if (!matchesName && !matchesFile) return false;
      }

      // Keep movies that are currently being upgraded or verifying always visible (within the search results)
      if (['upgrading', 'paused', 'verifying_upgrade'].includes(m.status)) return true;

      if (maxResFilter && parseRes(m.resolution) > parseRes(maxResFilter)) return false;
      if (maxBitrateFilter && m.bitrate > parseInt(maxBitrateFilter)) return false;
      if (extFilter && !m.ext.toLowerCase().includes(extFilter.toLowerCase())) return false;
      
      if (statusFilter) {
        if (statusFilter === 'matched') {
           if (m.status !== 'indexed' || !m.imdbId) return false;
        } else if (statusFilter === 'indexed') {
           if (m.status !== 'indexed' || m.imdbId) return false;
        } else {
           if (m.status !== statusFilter) return false;
        }
      }
      return true;
    });

    if (sortConfig.key) {
      result.sort((a, b) => {
        const aVal = a[sortConfig.key!];
        const bVal = b[sortConfig.key!];
        
        if (aVal === undefined) return 1;
        if (bVal === undefined) return -1;

        if (aVal < bVal) {
          return sortConfig.direction === 'asc' ? -1 : 1;
        }
        if (aVal > bVal) {
          return sortConfig.direction === 'asc' ? 1 : -1;
        }
        return 0;
      });
    }
    return result;
  }, [movies, maxResFilter, maxBitrateFilter, extFilter, statusFilter, sortConfig, fileNameFilter]);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024, dm = 2, sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 font-sans p-4 md:p-6 transition-colors duration-300">
      <header className="mb-6 md:mb-8 border-b border-slate-200 dark:border-slate-800 pb-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/20 rounded-lg text-indigo-600 dark:text-indigo-400">
              <HardDrive className="w-6 h-6" />
            </div>
            <h1 className="text-xl md:text-2xl font-semibold text-slate-900 dark:text-slate-100 tracking-tight">Debrid Media Upgrader</h1>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-3">
            <button 
              onClick={() => setShowLogs(true)}
              className="flex items-center justify-center p-2 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-700/50 border border-slate-200 dark:border-slate-700/50 rounded-md font-medium transition-colors shadow-sm min-w-[40px] h-[40px]"
              title="System Logs"
            >
              <Terminal className="w-4 h-4 sm:w-5 sm:h-5" />
              <span className="hidden xl:inline ml-2 text-sm">Logs</span>
            </button>
            <button 
              onClick={() => setShowSettings(true)}
              className={cn(
                "flex items-center justify-center p-2 bg-white dark:bg-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-700/50 border rounded-md font-medium transition-colors shadow-sm min-w-[40px] h-[40px] relative",
                (!isTmdbConfigured || !isAiostreamsConfigured) ? "text-amber-500 border-amber-500/50" : "text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700/50"
              )}
              title={(!isTmdbConfigured || !isAiostreamsConfigured) ? "Settings (Configuration Required)" : "Settings"}
            >
              <Settings2 className="w-4 h-4 sm:w-5 sm:h-5" />
              <span className="hidden xl:inline ml-2 text-sm">Settings</span>
              {(!isTmdbConfigured || !isAiostreamsConfigured) && (
                <span className="absolute -top-1 -right-1 flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500"></span>
                </span>
              )}
            </button>
            <div className="h-6 w-px bg-slate-200 dark:bg-slate-800 mx-1 hidden sm:block"></div>
            <button 
              onClick={handleScan}
              disabled={isLoading || movies.some(m => m.status === 'fetching_metadata')}
              className="flex items-center justify-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md font-medium transition-colors disabled:opacity-50 h-[40px] shadow-sm active:scale-95"
              title="Rescan Library"
            >
              <RefreshCw className={cn("w-4 h-4", (isLoading || movies.some(m => m.status === 'fetching_metadata')) && "animate-spin")} />
              <span className="hidden sm:inline text-sm">{isLoading || movies.some(m => m.status === 'fetching_metadata') ? "Scanning..." : "Rescan"}</span>
            </button>
            <button 
              onClick={handleUpgradeAll} 
              className={cn(
                "flex items-center justify-center gap-2 px-3 py-2 rounded-md font-medium transition-all shadow-sm border h-[40px]",
                isQueueActive 
                  ? "bg-amber-500 hover:bg-amber-600 text-white border-amber-600 animate-pulse" 
                  : "bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700"
              )}
              title={isQueueActive ? "Stop Queue" : "Start Queue"}
            >
              {isQueueActive ? (
                <>
                  <RotateCcw className="w-4 h-4 animate-spin" />
                  <span className="hidden sm:inline text-sm">Queue ({movies.filter(m => m.status === 'magnet_found').length})</span>
                  <span className="sm:hidden text-xs font-bold">{movies.filter(m => m.status === 'magnet_found').length}</span>
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  <span className="hidden sm:inline text-sm">Upgrade All</span>
                </>
              )}
            </button>
          </div>
        </div>
        
        {/* Filters */}
        <div className="mt-4 sm:mt-6 bg-white dark:bg-slate-900/40 border border-slate-200 dark:border-slate-800/80 rounded-xl shadow-sm overflow-hidden transition-all duration-300">
          <div className="p-1 sm:p-2 flex flex-col lg:flex-row lg:items-center gap-1 sm:gap-2">
            
            <div className="flex items-center gap-2 px-3 py-2 flex-shrink-0">
              <Filter className="w-4 h-4 text-indigo-500" />
              <span className="text-xs font-bold uppercase tracking-tight text-slate-400 dark:text-slate-500">Filter Library</span>
            </div>
            
            <div className="grid grid-cols-2 md:grid-cols-3 lg:flex lg:items-center gap-1 sm:gap-2 flex-1 p-1">
              <div className="relative col-span-2 md:col-span-1 lg:flex-1 lg:min-w-[180px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                <input 
                  type="text"
                  placeholder="Search file name..."
                  value={fileNameFilter}
                  onChange={(e) => setFileNameFilter(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800/50 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-slate-700 dark:text-slate-300 transition-all hover:border-slate-300 dark:hover:border-slate-700"
                />
              </div>

              <select 
                className="bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800/50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-slate-700 dark:text-slate-300 transition-all cursor-pointer hover:border-slate-300 dark:hover:border-slate-700"
                value={maxResFilter}
                onChange={(e) => setMaxResFilter(e.target.value)}
              >
                <option value="">Res: All</option>
                <option value="720x480">480p</option>
                <option value="1280x720">720p</option>
                <option value="1920x1080">1080p</option>
                <option value="3840x2160">4K</option>
                <option value="7680x4320">8K</option>
              </select>
              
              <select 
                className="bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800/50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-slate-700 dark:text-slate-300 transition-all cursor-pointer hover:border-slate-300 dark:hover:border-slate-700"
                value={extFilter}
                onChange={(e) => setExtFilter(e.target.value)}
              >
                <option value="">Ext: All</option>
                <option value=".mp4">.mp4</option>
                <option value=".mkv">.mkv</option>
                <option value=".avi">.avi</option>
                <option value=".webm">.webm</option>
              </select>

              <select 
                className="bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800/50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-slate-700 dark:text-slate-300 transition-all cursor-pointer hover:border-slate-300 dark:hover:border-slate-700 col-span-2 md:col-span-1"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">Status: All</option>
                <option value="fetching_metadata">Fetching Metadata</option>
                <option value="indexed">Indexed (Unmatched)</option>
                <option value="matched">Matched</option>
                <option value="magnet_found">Ready to Upgrade</option>
                <option value="upgrading">Upgrading</option>
                <option value="paused">Paused</option>
                <option value="verifying_upgrade">Verifying Upgrade</option>
              </select>
              
              <div className="flex flex-col gap-1 px-4 py-2 bg-slate-50/50 dark:bg-slate-950/30 rounded-lg border border-slate-200/50 dark:border-slate-800/50 col-span-2 md:col-span-3 lg:col-auto lg:flex-1 lg:min-w-[200px]">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[10px] uppercase font-black text-slate-400 dark:text-slate-600 tracking-wider">Bitrate Filter</span>
                  <span className="text-xs font-mono font-bold text-indigo-500 bg-indigo-500/10 px-1.5 py-0.5 rounded">
                    {maxBitrateFilter ? `${(Number(maxBitrateFilter) / 1000000).toFixed(1)} Mbps` : 'Unlimited'}
                  </span>
                </div>
                <input 
                  type="range" 
                  min="0"
                  max="50000000"
                  step="1000000"
                  className="w-full accent-indigo-500 h-1.5 bg-slate-200 dark:bg-slate-800 rounded-lg appearance-none cursor-pointer"
                  value={maxBitrateFilter || 0}
                  onChange={(e) => setMaxBitrateFilter(e.target.value === '0' ? '' : e.target.value)}
                />
              </div>
              
              {(maxResFilter || extFilter || statusFilter || maxBitrateFilter || fileNameFilter) && (
                <button 
                  onClick={() => {
                    setMaxResFilter('');
                    setExtFilter('');
                    setStatusFilter('');
                    setMaxBitrateFilter('');
                    setFileNameFilter('');
                  }}
                  className="text-xs font-semibold text-slate-400 hover:text-indigo-500 px-3 py-2 flex items-center gap-1.5 transition-colors col-span-2 md:col-span-3 lg:col-auto"
                >
                  <RefreshCw className="w-3 h-3" />
                  Clear Filters
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      <main>
        {globalError && (
          <div className="mb-6 p-4 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 rounded-lg flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
             <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
             <div className="flex-1">
                <h4 className="text-sm font-bold text-red-800 dark:text-red-300">
                  {globalError.includes("AIOStreams") ? "AIOStreams Problem" : 
                   globalError.includes("TMDB") ? "TMDB Problem" : 
                   "Operation Error"}
                </h4>
                <p className="text-sm text-red-700 dark:text-red-400/80 mt-1">{globalError}</p>
                <div className="mt-3 flex items-center gap-3">
                   {(globalError.toLowerCase().includes("tmdb") || globalError.toLowerCase().includes("aiostreams")) && (
                     <button 
                       onClick={() => { setShowSettings(true); setGlobalError(null); }}
                       className="text-xs font-bold px-3 py-1.5 bg-red-100 dark:bg-red-900/50 hover:bg-red-200 dark:hover:bg-red-800 text-red-800 dark:text-red-200 rounded transition-colors"
                     >
                       Fix in Settings
                     </button>
                   )}
                   <button 
                     onClick={() => setGlobalError(null)}
                     className="text-xs font-medium text-red-600 dark:text-red-400 hover:underline"
                   >
                     Dismiss
                   </button>
                </div>
             </div>
          </div>
        )}
        {/* Desktop Table View */}
        <div className="hidden md:block overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/50 shadow-sm transition-all duration-300">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
              <tr>
                <SortHeader label="File Name" sortKey="fileName" currentSort={sortConfig} onSort={requestSort} />
                <SortHeader label="Movie" sortKey="movieName" currentSort={sortConfig} onSort={requestSort} />
                <SortHeader label="Year" sortKey="year" currentSort={sortConfig} onSort={requestSort} />
                <SortHeader label="Size" sortKey="fileSize" currentSort={sortConfig} onSort={requestSort} />
                <SortHeader label="Resolution" sortKey="resolution" currentSort={sortConfig} onSort={requestSort} />
                <SortHeader label="Bitrate" sortKey="bitrate" currentSort={sortConfig} onSort={requestSort} />
                <th className="px-4 py-3 font-medium text-center">HDR</th>
                <SortHeader label="ID" sortKey="imdbId" currentSort={sortConfig} onSort={requestSort} />
                <SortHeader label="Status" sortKey="status" currentSort={sortConfig} onSort={requestSort} />
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
              {filteredMovies.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-6 py-20 text-center">
                    <div className="flex flex-col items-center justify-center space-y-3">
                      <div className="p-4 bg-slate-50 dark:bg-slate-900 rounded-full border-2 border-dashed border-slate-200 dark:border-slate-800">
                        <HardDrive className="w-10 h-10 text-slate-300 dark:text-slate-700" />
                      </div>
                      <div>
                        <p className="text-slate-600 dark:text-slate-300 font-bold text-lg">Your library is currently empty</p>
                        <p className="text-sm text-slate-400 dark:text-slate-500">Run a scan or generate mock files in Settings to get started.</p>
                      </div>
                      <button 
                        onClick={handleScan}
                        className="mt-4 px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-full text-sm font-black shadow-lg shadow-indigo-500/20 active:scale-95 transition-all"
                      >
                        Rescan Library
                      </button>
                    </div>
                  </td>
                </tr>
              ) : filteredMovies.map(movie => (
                <tr key={movie.id} className="group hover:bg-slate-50/80 dark:hover:bg-indigo-500/5 transition-all duration-150 border-b border-transparent hover:border-indigo-500/20">
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-300 font-mono text-xs max-w-[200px] truncate" title={movie.fileName}>{movie.fileName}</td>
                  <td className="px-4 py-3 font-medium text-slate-800 dark:text-slate-200">{movie.movieName}</td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                    {movie.year || '-'}
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{formatBytes(movie.fileSize)}</td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{movie.resolution}</td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                    {movie.bitrate > 0 ? `${(movie.bitrate / 1000).toFixed(0)} kbps` : '-'}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {movie.hdr ? (
                      <span className="px-2 py-0.5 rounded text-[10px] uppercase font-bold bg-amber-500/10 text-amber-600 dark:text-amber-500 border border-amber-500/20">HDR</span>
                    ) : (
                      <span className="text-slate-300 dark:text-slate-600">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400 font-mono text-xs">
                    {movie.imdbId ? (
                       <button 
                         className="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 text-[10px] rounded text-slate-500 cursor-pointer hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-500 dark:hover:text-red-400 transition-all border border-slate-200 dark:border-slate-700/50 hover:border-red-200 dark:hover:border-red-900/50 group relative shadow-sm"
                         title={movie.tmdbTitle ? `Matched to: ${movie.tmdbTitle}\nClick to unmatch` : "Click to unmatch"}
                         onClick={(e) => {
                           e.stopPropagation();
                           handleUnmatchTmdb(movie.id);
                         }}
                       >
                         {movie.imdbId}
                       </button>
                    ) : '-'}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge movie={movie} onCancel={() => cancelUpgrade(movie.id)} onPause={() => pauseUpgrade(movie.id)} onResume={() => resumeUpgrade(movie.id)} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {movie.imdbId ? (
                         <ActionBtn 
                           icon={<Search className={cn("w-4 h-4", !isAiostreamsConfigured && "text-slate-300 dark:text-slate-600")} />} 
                           title={!isAiostreamsConfigured ? "AIOStreams URL Required" : "Search upgrades"} 
                           onClick={() => handleSearch(movie.id)} 
                           active={isAiostreamsConfigured}
                           disabled={!isAiostreamsConfigured}
                         />
                      ) : (
                         <ActionBtn 
                          icon={matchingMovies.has(movie.id) ? <RefreshCw className="w-4 h-4 animate-spin text-indigo-500" /> : <Fingerprint className={cn("w-4 h-4", !isTmdbConfigured && "text-slate-300 dark:text-slate-600")} />} 
                          title={!isTmdbConfigured ? "TMDB Key Required" : "Match TMDB"} 
                          onClick={() => handleMatchTmdb(movie.id)} 
                          active={isTmdbConfigured}
                          disabled={!isTmdbConfigured}
                        />
                      )}
                      
                      {movie.status === 'magnet_found' && (
                        <ActionBtn icon={<Download className="w-4 h-4" />} title="Execute Upgrade" onClick={() => handleUpgrade(movie.id)} active />
                      )}
                      
                      {movie.status === 'verifying_upgrade' && (
                        <>
                          <ActionBtn icon={<Check className="w-4 h-4" />} title="Accept Upgrade" onClick={() => handleAcceptUpgrade(movie.id)} active />
                          <ActionBtn icon={<RotateCcw className="w-4 h-4" />} title="Revert to Old File" onClick={() => handleRevertUpgrade(movie.id)} danger />
                        </>
                      )}

                      {(movie.status !== 'indexed' && movie.status !== 'verifying_upgrade') && (
                        <ActionBtn icon={<Undo2 className="w-4 h-4" />} title="Revert Status" onClick={() => handleRevert(movie.id)} />
                      )}
                      <ActionBtn icon={<Edit2 className="w-4 h-4" />} title="Manual Rename" onClick={() => handleRename(movie)} />
                      <ActionBtn icon={<Trash2 className="w-4 h-4" />} title="Delete File" onClick={() => handleDelete(movie)} danger />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile Card View */}
        <div className="md:hidden grid grid-cols-1 gap-4">
          {filteredMovies.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 px-4 text-center bg-white dark:bg-slate-900/40 rounded-2xl border border-dashed border-slate-300 dark:border-slate-800 shadow-inner">
              <div className="w-16 h-16 bg-indigo-50 dark:bg-indigo-900/20 rounded-full flex items-center justify-center mb-4 text-indigo-500">
                <Search className="w-8 h-8 opacity-40" />
              </div>
              <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-1">No movies found</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 max-w-xs mx-auto">
                Try scanning your library or adjusting your filters to see more results.
              </p>
              <button 
                onClick={handleScan}
                className="mt-6 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-full text-sm font-black shadow-lg shadow-indigo-500/25 active:scale-95 transition-all"
              >
                Scan Library Now
              </button>
            </div>
          ) : filteredMovies.map(movie => (
            <div key={movie.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800/80 rounded-2xl p-5 shadow-sm active:bg-slate-50 dark:active:bg-slate-800 transition-all duration-200 hover:shadow-md border-b-4 border-b-slate-100 dark:border-b-slate-800/50">
              <div className="flex justify-between items-start mb-4 gap-3">
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-slate-900 dark:text-slate-100 leading-tight line-clamp-2 text-base">{movie.movieName}</h3>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-[10px] font-black text-white bg-slate-400 dark:bg-slate-700 px-1.5 py-0.5 rounded-md uppercase tracking-wider">{movie.year || 'N/A'}</span>
                    <p className="text-[10px] font-mono text-slate-400 dark:text-slate-500 truncate flex-1">{movie.fileName}</p>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                  {movie.hdr && <span className="px-2 py-0.5 rounded-md text-[9px] font-black bg-amber-500 text-white shadow-sm shadow-amber-500/20">HDR</span>}
                  <span className="text-[10px] font-black text-indigo-500 bg-indigo-500/10 px-2 py-1 rounded-md border border-indigo-500/20 uppercase tracking-tighter">{movie.resolution}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 mb-5 p-3 bg-slate-50 dark:bg-slate-950/40 rounded-xl border border-slate-100 dark:border-slate-800/50">
                <div className="flex flex-col items-center justify-center py-1">
                  <span className="text-[9px] uppercase font-black text-slate-400 tracking-widest mb-1">File Size</span>
                  <span className="text-sm text-slate-700 dark:text-slate-200 font-black tracking-tight">{formatBytes(movie.fileSize)}</span>
                </div>
                <div className="h-full w-px bg-slate-200 dark:bg-slate-800 mx-auto"></div>
                <div className="flex flex-col items-center justify-center py-1">
                  <span className="text-[9px] uppercase font-black text-slate-400 tracking-widest mb-1">Bitrate</span>
                  <span className="text-sm text-slate-700 dark:text-slate-200 font-black tracking-tight">
                    {movie.bitrate > 0 ? `${(movie.bitrate / 1000000).toFixed(1)} Mbps` : 'N/A'}
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                   <StatusBadge movie={movie} onCancel={() => cancelUpgrade(movie.id)} onPause={() => pauseUpgrade(movie.id)} onResume={() => resumeUpgrade(movie.id)} />
                   {movie.imdbId && (
                    <button 
                      className="px-2.5 py-1.5 bg-slate-50 dark:bg-slate-800/50 text-[10px] rounded-lg text-slate-400 border border-slate-200 dark:border-slate-700 shadow-sm whitespace-nowrap active:bg-red-50 dark:active:bg-red-900/30 font-black transition-colors uppercase tracking-wider"
                      title="Click to unmatch"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleUnmatchTmdb(movie.id);
                      }}
                    >
                      {movie.imdbId}
                    </button>
                  )}
                </div>
                
                <div className="flex items-center gap-2 pt-3 border-t border-slate-100 dark:border-slate-800/50">
                  <div className="flex-1 flex gap-2">
                    {movie.imdbId ? (
                      <button 
                        onClick={() => handleSearch(movie.id)} 
                        className={cn(
                          "flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-black shadow-lg transition-all uppercase tracking-wider",
                          isAiostreamsConfigured ? "bg-indigo-600 active:bg-indigo-700 text-white shadow-indigo-500/20" : "bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed"
                        )}
                      >
                        <Search className="w-4 h-4" />
                        {isAiostreamsConfigured ? 'Search' : 'Setup Required'}
                      </button>
                    ) : (
                      <button 
                        onClick={() => handleMatchTmdb(movie.id)} 
                        disabled={matchingMovies.has(movie.id)}
                        className={cn(
                          "flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-black shadow-lg transition-all uppercase tracking-wider",
                          isTmdbConfigured ? "bg-emerald-600 active:bg-emerald-700 text-white shadow-emerald-500/20" : "bg-slate-200 dark:bg-slate-800 text-slate-400"
                        )}
                      >
                        {matchingMovies.has(movie.id) ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Fingerprint className="w-4 h-4" />}
                        {matchingMovies.has(movie.id) ? 'Matching...' : isTmdbConfigured ? 'Match' : 'Setup Required'}
                      </button>
                    )}

                    {movie.status === 'magnet_found' && (
                      <button onClick={() => handleUpgrade(movie.id)} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 active:bg-indigo-700 text-white rounded-xl text-xs font-black shadow-lg shadow-indigo-500/20 transition-all uppercase tracking-wider animate-pulse">
                        <Download className="w-4 h-4" />
                        Upgrade
                      </button>
                    )}

                    {movie.status === 'verifying_upgrade' && (
                      <button onClick={() => handleAcceptUpgrade(movie.id)} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 active:bg-emerald-700 text-white rounded-xl text-xs font-black shadow-lg shadow-emerald-500/20 transition-all uppercase tracking-wider">
                        <Check className="w-4 h-4" />
                        Accept
                      </button>
                    )}
                  </div>
                  
                  <button 
                    onClick={() => handleDelete(movie)} 
                    className="p-2.5 bg-red-50 dark:bg-red-950/20 text-red-500 dark:text-red-400 rounded-xl border border-red-100 dark:border-red-900/30 active:bg-red-100 transition-colors shadow-sm"
                    title="Delete File"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>

      {/* Delete Modal */}
      {movieToDelete && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl w-full max-w-md p-6">
            <h3 className="text-xl font-medium text-slate-900 dark:text-slate-100 mb-2">Delete File?</h3>
            <p className="text-slate-600 dark:text-slate-400 mb-6 text-sm">
              Are you sure you want to delete <span className="text-slate-900 dark:text-slate-200 font-mono font-semibold">{movieToDelete.fileName}</span>? This action cannot be undone and will remove the file from your disk.
            </p>
            <div className="flex justify-end gap-3">
              <button 
                onClick={() => setMovieToDelete(null)}
                disabled={modalLoading}
                className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-md text-sm font-medium transition-colors border border-slate-200 dark:border-slate-700"
              >
                Cancel
              </button>
              <button 
                onClick={confirmDelete}
                disabled={modalLoading}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-md text-sm font-medium transition-colors flex items-center gap-2"
              >
                {modalLoading && <RefreshCw className="w-4 h-4 animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Modal */}
      {movieToRename && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-medium text-slate-900 dark:text-slate-100">Rename File</h3>
              <button onClick={() => setMovieToRename(null)} className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="mb-6">
              <label className="block text-sm font-medium text-slate-500 dark:text-slate-400 mb-2">New file name</label>
              <input 
                type="text" 
                value={newName}
                onChange={e => setNewName(e.target.value)}
                className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded px-3 py-2 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-indigo-500 font-mono shadow-sm"
              />
            </div>
            <div className="flex justify-end gap-3">
              <button 
                onClick={() => setMovieToRename(null)}
                disabled={modalLoading}
                className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-md text-sm font-medium transition-colors border border-slate-200 dark:border-slate-700"
              >
                Cancel
              </button>
              <button 
                onClick={confirmRename}
                disabled={modalLoading || !newName.trim() || newName === movieToRename.fileName}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-md text-sm font-medium transition-colors flex items-center gap-2"
              >
                {modalLoading && <RefreshCw className="w-4 h-4 animate-spin" />}
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stream Selector Modal */}
      {streamSelectorData && (
        <StreamSelectorModal
          data={streamSelectorData}
          defaultFilters={settingsForm}
          onClose={() => setStreamSelectorData(null)}
          onRefresh={() => handleSearch(streamSelectorData.movieId, true)}
          onSelect={(link: string, meta: any) => handleSelectStream(streamSelectorData.movieId, link, meta)}
        />
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl w-full max-w-xl p-6 overflow-y-auto max-h-[90vh]">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-medium text-slate-900 dark:text-slate-100">Settings</h3>
              <button onClick={() => setShowSettings(false)} className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-sm font-medium text-slate-500 dark:text-slate-400 mb-2 flex justify-between items-center">
                  <span>TMDB API Key</span>
                  {!isTmdbConfigured && <span className="text-[10px] text-red-500 font-bold uppercase tracking-wider flex items-center gap-1"><AlertCircle className="w-3 h-3"/> Required</span>}
                </label>
                <input 
                  type="text" 
                  value={settingsForm.tmdbApiKey}
                  onChange={e => setSettingsForm({...settingsForm, tmdbApiKey: e.target.value})}
                  placeholder="Enter TMDB API Key or Bearer Token"
                  className={cn(
                    "w-full bg-slate-50 dark:bg-slate-950 border rounded px-3 py-2 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-indigo-500 shadow-sm transition-colors",
                    !isTmdbConfigured ? "border-red-500/50 hover:border-red-500" : "border-slate-200 dark:border-slate-800"
                  )}
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-slate-500 dark:text-slate-400 mb-2 flex justify-between items-center">
                  <span>AIOStreams URL</span>
                  {!isAiostreamsConfigured && <span className="text-[10px] text-red-500 font-bold uppercase tracking-wider flex items-center gap-1"><AlertCircle className="w-3 h-3"/> Required</span>}
                </label>
                <input 
                  type="text" 
                  value={settingsForm.aiostreamsUrl}
                  onChange={e => setSettingsForm({...settingsForm, aiostreamsUrl: e.target.value})}
                  placeholder="https://aiostreams.domain/YOUR_CONFIG_STRING"
                  className={cn(
                    "w-full bg-slate-50 dark:bg-slate-950 border rounded px-3 py-2 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-indigo-500 shadow-sm transition-colors",
                    !isAiostreamsConfigured ? "border-red-500/50 hover:border-red-500" : "border-slate-200 dark:border-slate-800"
                  )}
                />
                <p className="text-xs text-slate-500 dark:text-slate-500 mt-1">
                  Generate this on your AIOStreams setup page. Paste the URL but omit <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded text-slate-500 dark:text-slate-400">/manifest.json</code> at the end.
                </p>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-slate-500 dark:text-slate-400 mb-2">Target Folder (Absolute Path)</label>
                <input 
                  type="text" 
                  value={settingsForm.targetFolder}
                  onChange={e => setSettingsForm({...settingsForm, targetFolder: e.target.value})}
                  placeholder="/path/to/media/movies"
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded px-3 py-2 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:border-indigo-500 font-mono shadow-sm"
                />
                <p className="text-xs text-slate-500 dark:text-slate-500 mt-1">Changing this will create the folder if it does not exist.</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-500 dark:text-slate-400 mb-2">Stream Cache Expiry</label>
                <div className="flex items-center gap-4">
                  <input 
                    type="range" 
                    min="0" 
                    max={EXPIRY_OPTIONS.length - 1} 
                    step="1"
                    value={EXPIRY_OPTIONS.indexOf(settingsForm.streamCacheExpiryMinutes) === -1 ? 6 : EXPIRY_OPTIONS.indexOf(settingsForm.streamCacheExpiryMinutes)}
                    onChange={e => setSettingsForm({...settingsForm, streamCacheExpiryMinutes: EXPIRY_OPTIONS[parseInt(e.target.value)]})}
                    className="flex-1 accent-indigo-500"
                  />
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-200 min-w-[4rem] text-right">
                    {settingsForm.streamCacheExpiryMinutes >= 1440 
                      ? "1 day" 
                      : settingsForm.streamCacheExpiryMinutes >= 60 
                        ? `${Math.floor(settingsForm.streamCacheExpiryMinutes / 60)}h${settingsForm.streamCacheExpiryMinutes % 60 > 0 ? ` ${settingsForm.streamCacheExpiryMinutes % 60}m` : ""}`
                        : `${settingsForm.streamCacheExpiryMinutes}m`
                    }
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-500 mt-1">
                  How long to keep stream search results in cache (1m to 1 day).
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-500 dark:text-slate-400 mb-2">Theme</label>
                <div className="flex gap-2 p-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg shadow-sm">
                  {(['system', 'light', 'dark'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setSettingsForm({ ...settingsForm, theme: t })}
                      className={cn(
                        "flex-1 px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-all",
                        settingsForm.theme === t 
                          ? "bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm border border-slate-200 dark:border-slate-700" 
                          : "text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300"
                      )}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="pt-4 border-t border-slate-100 dark:border-slate-800">
                <h4 className="text-sm font-medium text-slate-900 dark:text-slate-200 mb-4">Default Stream Filters</h4>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Resolution</label>
                    <select 
                      value={settingsForm.streamResFilter}
                      onChange={e => setSettingsForm({...settingsForm, streamResFilter: e.target.value})}
                      className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded px-2 py-1.5 text-sm text-slate-700 dark:text-slate-200 focus:outline-none focus:border-indigo-500"
                    >
                      <option value="All">All</option>
                      <option value="4K">4K</option>
                      <option value="1080p">1080p</option>
                      <option value="720p">720p</option>
                      <option value="480p">480p</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Video Format</label>
                    <select 
                      value={settingsForm.streamVideoFilter}
                      onChange={e => setSettingsForm({...settingsForm, streamVideoFilter: e.target.value})}
                      className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded px-2 py-1.5 text-sm text-slate-700 dark:text-slate-200 focus:outline-none focus:border-indigo-500"
                    >
                      <option value="All">All</option>
                      <option value="Dolby Vision">Dolby Vision</option>
                      <option value="HDR10">HDR10</option>
                      <option value="HDR">HDR</option>
                      <option value="SDR">SDR</option>
                      <option value="HEVC">HEVC</option>
                      <option value="AVC">AVC</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Audio Format</label>
                    <select 
                      value={settingsForm.streamAudioFilter}
                      onChange={e => setSettingsForm({...settingsForm, streamAudioFilter: e.target.value})}
                      className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded px-2 py-1.5 text-sm text-slate-700 dark:text-slate-200 focus:outline-none focus:border-indigo-500"
                    >
                      <option value="All">All</option>
                      <option value="TrueHD">TrueHD</option>
                      <option value="Atmos">Atmos</option>
                      <option value="DTS-HD MA">DTS-HD MA</option>
                      <option value="DTS">DTS</option>
                      <option value="EAC3">EAC3</option>
                      <option value="AC3">AC3</option>
                      <option value="AAC">AAC</option>
                    </select>
                  </div>
                </div>

                <div>
                   <label className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1 flex justify-between">
                     <span>Bitrate Default Range</span>
                     <span className="text-indigo-600 dark:text-indigo-400">
                       {settingsForm.streamMinBitrate} - {settingsForm.streamMaxBitrate >= 100 ? 'Max' : settingsForm.streamMaxBitrate} Mbps
                     </span>
                   </label>
                   <div className="pt-2 px-1">
                     <Slider.Root
                        className="relative flex items-center select-none touch-none w-full h-5"
                        value={[settingsForm.streamMinBitrate, settingsForm.streamMaxBitrate]}
                        onValueChange={([min, max]) => setSettingsForm({ ...settingsForm, streamMinBitrate: min, streamMaxBitrate: max })}
                        max={100}
                        step={1}
                        minStepsBetweenThumbs={0}
                      >
                        <Slider.Track className="bg-slate-200 dark:bg-slate-800 relative grow rounded-full h-[3px]">
                          <Slider.Range className="absolute bg-indigo-500 rounded-full h-full" />
                        </Slider.Track>
                        <Slider.Thumb
                          className="block w-4 h-4 bg-white border-2 border-indigo-500 rounded-lg hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-400/50 transition-colors shadow-lg cursor-pointer"
                          aria-label="Min bitrate"
                        />
                        <Slider.Thumb
                          className="block w-4 h-4 bg-white border-2 border-indigo-500 rounded-lg hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-400/50 transition-colors shadow-lg cursor-pointer"
                          aria-label="Max bitrate"
                        />
                      </Slider.Root>
                   </div>
                </div>
              </div>
            </div>

            <div className="flex justify-between items-center pt-2 border-t border-slate-100 dark:border-slate-800">
              {resetConfirmMode ? (
                <div className="flex flex-col gap-2 w-full">
                  <p className="text-sm text-red-500 dark:text-red-400 font-medium mb-1">Confirm Database Reset</p>
                  <div className="flex gap-2">
                    <button 
                      onClick={() => handleResetDb(true)}
                      disabled={modalLoading}
                      className="px-4 py-2 bg-red-100 dark:bg-red-900/50 hover:bg-red-200 dark:hover:bg-red-800 border border-red-200 dark:border-red-900/50 text-red-700 dark:text-red-100 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      Reset DB & Mock files
                    </button>
                    <button 
                      onClick={() => handleResetDb(false)}
                      disabled={modalLoading}
                      className="px-4 py-2 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-300 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      Reset DB only
                    </button>
                    <button 
                      onClick={() => setResetConfirmMode(false)}
                      disabled={modalLoading}
                      className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-md text-sm font-medium transition-colors sm:ml-auto disabled:opacity-50 border border-slate-200 dark:border-slate-700"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex gap-2">
                    <button 
                      onClick={() => setResetConfirmMode(true)}
                      className="px-3 py-2 bg-red-50 dark:bg-red-900/30 hover:bg-red-100 dark:hover:bg-red-800/50 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/50 rounded-md text-xs font-medium transition-colors flex items-center gap-2"
                    >
                      <Database className="w-3.5 h-3.5" />
                      Reset Database
                    </button>
                    <button 
                      onClick={handleGenerateMocks}
                      disabled={modalLoading}
                      className="px-3 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-md text-xs font-medium transition-colors flex items-center gap-2 disabled:opacity-50"
                    >
                      <HardDrive className="w-3.5 h-3.5" />
                      Generate Mocks
                    </button>
                  </div>
                  <div className="flex gap-3">
                    <button 
                      onClick={() => setShowSettings(false)}
                      disabled={modalLoading}
                      className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-md text-sm font-medium transition-colors"
                    >
                      Cancel
                    </button>
                    <button 
                      onClick={saveSettings}
                      disabled={modalLoading}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md text-sm font-medium transition-colors flex items-center gap-2 shadow-md shadow-indigo-500/20"
                    >
                      {modalLoading && <RefreshCw className="w-4 h-4 animate-spin" />}
                      Save Settings
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Log Viewer Modal */}
      {showLogs && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-4xl max-h-[80vh] flex flex-col border border-slate-200 dark:border-slate-800 animate-in fade-in zoom-in duration-200">
            <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400">
                <Terminal className="w-5 h-5" />
                <h2 className="text-lg font-semibold tracking-tight">System Logs</h2>
              </div>
              <div className="flex items-center gap-2">
                <button 
                  onClick={handleClearLogs}
                  className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                  title="Clear Server Logs"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => setShowLogs(false)}
                  className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 bg-slate-950 font-mono text-[11px] sm:text-xs leading-relaxed">
              {logs.length === 0 ? (
                <div className="h-full flex items-center justify-center text-slate-600">
                  <p>No log entries found. Waiting for output...</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {logs.map((log, i) => {
                    const isError = log.includes('[ERROR]');
                    const isWarn = log.includes('[WARN]');
                    return (
                      <div key={i} className={cn(
                        "whitespace-pre-wrap break-all",
                        isError ? "text-red-400" : isWarn ? "text-yellow-400" : "text-emerald-400/90"
                      )}>
                        <span className="text-slate-600 mr-2 opacity-50">{log.substring(0, 21)}</span>
                        {log.substring(21)}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            
            <div className="p-3 bg-slate-50 dark:bg-slate-900/50 border-t border-slate-100 dark:border-slate-800 text-[10px] text-slate-500 flex justify-between items-center">
              <span>Showing last {logs.length} entries</span>
              <span className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                Live Update
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ movie, onCancel, onPause, onResume }: { movie: Movie, onCancel?: () => void, onPause?: () => void, onResume?: () => void }) {
  switch (movie.status) {
    case 'fetching_metadata':
      return <span className="text-[10px] sm:text-xs px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-500 border border-amber-500/20 flex w-max items-center gap-1.5 font-bold uppercase tracking-tight"><RefreshCw className="w-3 h-3 animate-spin"/> Fetching</span>;
    case 'indexed':
      if (movie.imdbId) {
        return <span className="text-[10px] sm:text-xs px-2 py-1 rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20 uppercase tracking-wider font-bold">Matched</span>;
      }
      return <span className="text-[10px] sm:text-xs px-2 py-1 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-transparent uppercase tracking-wider font-bold">Indexed</span>;
    case 'magnet_found':
      return <span className="text-[10px] sm:text-xs px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 font-bold uppercase tracking-tight">Ready</span>;
    case 'upgrading':
    case 'paused':
      const isPaused = movie.status === 'paused';
      return (
        <div className="flex flex-col gap-1.5 min-w-[120px]">
          <div className="flex justify-between items-center text-[10px] font-black uppercase tracking-widest">
            <span className={cn(isPaused ? "text-slate-500" : "text-indigo-600 dark:text-indigo-400 animate-pulse")}>
              {isPaused ? 'Paused' : 'Upgrading'}
            </span>
            <span className="text-slate-400">{movie.progress || 0}%</span>
          </div>
          <div className="flex items-center gap-2 group/status">
            <div className="flex-1 bg-slate-200 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden shadow-inner">
              <div 
                className={cn("h-full transition-all duration-500 ease-out shadow-sm", isPaused ? "bg-slate-400 dark:bg-slate-500" : "bg-indigo-500 animate-pulse")}
                style={{ width: `${movie.progress || 0}%` }}
              />
            </div>
            <div className="flex items-center gap-1 px-1">
              {!isPaused ? (
                <button 
                  onClick={(e) => { e.stopPropagation(); onPause?.(); }}
                  className="p-1 hover:bg-amber-500/10 hover:text-amber-500 text-slate-400 transition-all rounded-md"
                  title="Pause Upgrade"
                >
                  <Pause className="w-3 h-3" />
                </button>
              ) : (
                <button 
                  onClick={(e) => { e.stopPropagation(); onResume?.(); }}
                  className="p-1 hover:bg-emerald-500/10 hover:text-emerald-500 text-slate-400 transition-all rounded-md"
                  title="Resume Upgrade"
                >
                  <Play className="w-3 h-3 fill-current" />
                </button>
              )}
              <button 
                onClick={(e) => { e.stopPropagation(); onCancel?.(); }}
                className="p-1 hover:bg-red-500/10 hover:text-red-500 text-slate-400 transition-all rounded-md"
                title="Cancel Upgrade"
              >
                <Ban className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>
      );
    case 'verifying_upgrade':
      return <span className="text-[10px] sm:text-xs px-2 py-1 rounded-full bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20 flex w-max items-center gap-1.5 uppercase font-bold tracking-widest animate-pulse">Verifying</span>;
    default:
      return <span className="text-xs px-2 py-1 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-transparent uppercase tracking-wider font-semibold text-[10px]">{movie.status}</span>;
  }
}

function SortHeader({ label, sortKey, currentSort, onSort }: { label: string, sortKey: keyof Movie, currentSort: { key: keyof Movie | null, direction: 'asc' | 'desc' }, onSort: (key: keyof Movie) => void }) {
  const isActive = currentSort.key === sortKey;
  
  return (
    <th className="px-4 py-3 font-medium group cursor-pointer select-none" onClick={() => onSort(sortKey)}>
      <div className="flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-200 transition-colors">
        {label}
        <div className={cn("opacity-0 group-hover:opacity-100 transition-opacity flex flex-col -gap-1", isActive && "opacity-100 text-indigo-600 dark:text-indigo-400")}>
          <svg className={cn("w-2.5 h-2.5 fill-current transition-colors", isActive && currentSort.direction === 'asc' ? "text-indigo-600 dark:text-indigo-400" : "text-slate-300 dark:text-slate-600")} viewBox="0 0 32 32">
            <path d="M16 4l-12 12h24z" />
          </svg>
          <svg className={cn("w-2.5 h-2.5 fill-current transition-colors", isActive && currentSort.direction === 'desc' ? "text-indigo-600 dark:text-indigo-400" : "text-slate-300 dark:text-slate-600")} viewBox="0 0 32 32">
            <path d="M16 28l12-12h-24z" />
          </svg>
        </div>
      </div>
    </th>
  );
}

function ActionBtn({ icon, onClick, title, danger, active, disabled }: { icon: React.ReactNode, onClick: () => void, title: string, danger?: boolean, active?: boolean, disabled?: boolean }) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "p-1.5 rounded transition-all transform active:scale-95",
        disabled ? "opacity-30 cursor-not-allowed grayscale" :
        danger ? "text-slate-400 dark:text-slate-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10" : 
        active ? "text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/10 hover:bg-indigo-100 dark:hover:bg-indigo-500/20" :
        "text-slate-400 dark:text-slate-500 hover:text-slate-900 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
      )}
    >
      {icon}
    </button>
  );
}

