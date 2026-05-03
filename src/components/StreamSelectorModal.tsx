import React, { useState, useMemo } from 'react';
import { X, RefreshCw } from 'lucide-react';
import * as Slider from '@radix-ui/react-slider';
import { motion } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const parseStreamMetadata = (title: string, name: string) => {
  const t = (title + ' ' + name).toLowerCase();
  
  let res = 'Unknown';
  if (t.includes('2160p') || t.includes('4k')) res = '2160p';
  else if (t.includes('1080p')) res = '1080p';
  else if (t.includes('720p')) res = '720p';
  else if (t.includes('480p')) res = '480p';

  let video = 'Other';
  if (t.includes('dv') || t.includes('dovi') || t.includes('dolby vision')) video = 'Dolby Vision';
  else if (t.includes('hdr10')) video = 'HDR10';
  else if (t.includes('hdr')) video = 'HDR';
  else if (t.includes('sdr')) video = 'SDR';
  else if (t.includes('hevc') || t.includes('x265') || t.includes('h265')) video = 'HEVC';
  else if (t.includes('avc') || t.includes('x264') || t.includes('h264')) video = 'AVC';

  let audio = 'Other';
  if (t.includes('thd') || t.includes('truehd')) audio = 'TrueHD';
  else if (t.includes('atmos')) audio = 'Atmos';
  else if (t.includes('dts-hd') || t.includes('dtshd') || t.includes('dts-hd ma')) audio = 'DTS-HD MA';
  else if (t.includes('dts')) audio = 'DTS';
  else if (t.includes('eac3') || t.includes('dd+')) audio = 'EAC3';
  else if (t.includes('ac3') || t.includes('dd')) audio = 'AC3';
  else if (t.includes('aac')) audio = 'AAC';

  let sizeGiB = 0;
  const gbMatch = t.match(/([\d.]+)\s*(gb|gib)/);
  const mbMatch = t.match(/([\d.]+)\s*(mb|mib)/);
  if (gbMatch) sizeGiB = parseFloat(gbMatch[1]);
  else if (mbMatch) sizeGiB = parseFloat(mbMatch[1]) / 1024;

  let bitrateMbps = 0;
  let bitrateEstimated = false;

  const bitrateMatch = t.match(/([\d.]+)\s*mbps/);
  if (bitrateMatch) {
    bitrateMbps = parseFloat(bitrateMatch[1]);
  } else if (sizeGiB > 0) {
    bitrateMbps = (sizeGiB * 1024 * 1024 * 1024 * 8) / 7200 / 1000000;
    bitrateEstimated = true;
  }

  const extensionMatch = t.match(/\.(mkv|mp4|avi|webm|ts|m2ts)$/i);
  const extension = extensionMatch ? extensionMatch[0] : '.mkv';

  return { res, video, audio, sizeGiB, bitrateMbps, bitrateEstimated, extension };
};

export default function StreamSelectorModal({ data, onClose, onRefresh, onSelect, defaultFilters }: any) {
  const [resFilter, setResFilter] = useState(defaultFilters?.streamResFilter || 'All');
  const [videoFilter, setVideoFilter] = useState(defaultFilters?.streamVideoFilter || 'All');
  const [audioFilter, setAudioFilter] = useState(defaultFilters?.streamAudioFilter || 'All');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectingIdx, setSelectingIdx] = useState<number | null>(null);
  const [minBitrateFilter, setMinBitrateFilter] = useState(defaultFilters?.streamMinBitrate || 0);
  const [maxBitrateFilter, setMaxBitrateFilter] = useState(defaultFilters?.streamMaxBitrate !== undefined ? defaultFilters.streamMaxBitrate : 100);

  const handleRefresh = async () => {
    if (!onRefresh) return;
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleSelect = async (idx: number, stream: any) => {
    setSelectingIdx(idx);
    try {
      await onSelect(stream.url || stream.link || stream.externalUrl || stream.infoHash, { ...stream.meta, streamName: stream.name, filename: stream.filename });
    } finally {
      setSelectingIdx(null);
    }
  };

  const streamsWithMeta = useMemo(() => {
    if (!data.streams) return [];
    return data.streams.map((s: any) => ({
      ...s,
      meta: parseStreamMetadata(s.title, s.name)
    })).sort((a: any, b: any) => b.meta.sizeGiB - a.meta.sizeGiB);
  }, [data.streams]);

  const filteredStreams = useMemo(() => {
    return streamsWithMeta.filter((s: any) => {
      if (resFilter !== 'All' && s.meta.res !== resFilter) return false;
      if (videoFilter !== 'All' && s.meta.video !== videoFilter) return false;
      if (audioFilter !== 'All' && s.meta.audio !== audioFilter) return false;
      if (minBitrateFilter > 0 && s.meta.bitrateMbps < minBitrateFilter) return false;
      if (maxBitrateFilter < 100 && s.meta.bitrateMbps > maxBitrateFilter) return false;
      return true;
    });
  }, [streamsWithMeta, resFilter, videoFilter, audioFilter, minBitrateFilter, maxBitrateFilter]);

  const uniqueRes = ['All', ...Array.from(new Set(streamsWithMeta.map((s: any) => s.meta.res))).filter((r: any) => r !== 'Unknown')] as string[];
  const uniqueVideo = ['All', ...Array.from(new Set(streamsWithMeta.map((s: any) => s.meta.video))).filter((r: any) => r !== 'Other')] as string[];
  const uniqueAudio = ['All', ...Array.from(new Set(streamsWithMeta.map((s: any) => s.meta.audio))).filter((r: any) => r !== 'Other')] as string[];

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-[100] flex items-center justify-center p-2 sm:p-4">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl w-full max-w-4xl p-4 sm:p-6 flex flex-col max-h-[95vh] sm:max-h-[85vh]"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg sm:text-xl font-medium text-slate-900 dark:text-slate-100">Select Stream</h3>
          <div className="flex items-center gap-2">
            {onRefresh && (
              <button 
                onClick={handleRefresh} 
                disabled={isRefreshing}
                className="p-2 text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300 min-w-[44px] min-h-[44px] flex items-center justify-center disabled:opacity-50"
                title="Refresh from AIOStreams (Bypass cache)"
              >
                <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
              </button>
            )}
            <button onClick={onClose} className="p-2 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 min-w-[44px] min-h-[44px] flex items-center justify-center">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        
        <div className="grid grid-cols-1 sm:flex sm:flex-wrap gap-4 mb-4 p-4 bg-slate-50 dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800">
          <div className="flex flex-col">
             <label className="text-xs text-slate-500 dark:text-slate-400 mb-1">Resolution</label>
             <select 
                value={resFilter} 
                onChange={e => setResFilter(e.target.value)}
                className="bg-white dark:bg-slate-800 border-slate-200 dark:border-none text-sm text-slate-700 dark:text-slate-200 rounded px-2 py-2 focus:ring-1 focus:ring-indigo-500 shadow-sm min-h-[44px] sm:min-h-0"
              >
                {uniqueRes.map(r => <option key={r} value={r}>{r}</option>)}
             </select>
          </div>
          
          <div className="flex flex-col">
             <label className="text-xs text-slate-500 dark:text-slate-400 mb-1">Video Format</label>
             <select 
                value={videoFilter} 
                onChange={e => setVideoFilter(e.target.value)}
                className="bg-white dark:bg-slate-800 border-slate-200 dark:border-none text-sm text-slate-700 dark:text-slate-200 rounded px-2 py-2 focus:ring-1 focus:ring-indigo-500 shadow-sm min-h-[44px] sm:min-h-0"
              >
                {uniqueVideo.map(r => <option key={r} value={r}>{r}</option>)}
             </select>
          </div>

          <div className="flex flex-col">
             <label className="text-xs text-slate-500 dark:text-slate-400 mb-1">Audio Format</label>
             <select 
                value={audioFilter} 
                onChange={e => setAudioFilter(e.target.value)}
                className="bg-white dark:bg-slate-800 border-slate-200 dark:border-none text-sm text-slate-700 dark:text-slate-200 rounded px-2 py-2 focus:ring-1 focus:ring-indigo-500 shadow-sm min-h-[44px] sm:min-h-0"
              >
                {uniqueAudio.map(r => <option key={r} value={r}>{r}</option>)}
             </select>
          </div>

          <div className="flex flex-col flex-1 min-w-[150px] sm:min-w-[250px]">
             <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 flex justify-between">
               <span>Bitrate Range</span>
               <span className="text-indigo-600 dark:text-indigo-400">
                 {minBitrateFilter}-{maxBitrateFilter >= 100 ? 'Max' : maxBitrateFilter} Mbps
               </span>
             </label>
             <div className="pt-2 px-1">
               <Slider.Root
                  className="relative flex items-center select-none touch-none w-full h-5"
                  value={[minBitrateFilter, maxBitrateFilter]}
                  onValueChange={([min, max]) => {
                    setMinBitrateFilter(min);
                    setMaxBitrateFilter(max);
                  }}
                  max={100}
                  step={1}
                  minStepsBetweenThumbs={0}
                >
                  <Slider.Track className="bg-slate-200 dark:bg-slate-700 relative grow rounded-full h-[3px]">
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

        <div className="text-xs text-slate-400 dark:text-slate-500 mb-2">
          {data.isLoading ? 'Searching for streams...' : `Showing ${filteredStreams.length} / ${streamsWithMeta.length} streams`}
        </div>

        <div className="flex-1 overflow-y-auto space-y-2 pr-2 relative min-h-[200px]">
          {data.isLoading ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 bg-white/50 dark:bg-slate-900/50 backdrop-blur-[1px] z-10 rounded-xl">
               <RefreshCw className="w-10 h-10 text-indigo-500 animate-spin mb-4" />
               <p className="text-slate-600 dark:text-slate-300 font-medium animate-pulse">Searching AIOStreams...</p>
               <p className="text-xs text-slate-400 dark:text-slate-500 mt-2">This may take up to 10 seconds</p>
            </div>
          ) : (
            <>
              {filteredStreams.map((stream: any, idx: number) => (
                <div key={idx} className="p-3 border border-slate-100 dark:border-slate-800 rounded bg-slate-50 dark:bg-slate-800/30 hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors flex justify-between items-center gap-4 shadow-sm">
                  <div className="flex-1 text-sm text-slate-600 dark:text-slate-300 break-words whitespace-pre-wrap">
                    <span className="font-semibold text-slate-900 dark:text-slate-100 block mb-1">
                      {stream.name}{' '}
                      {stream.meta.sizeGiB > 0 && <span className="ml-2 text-indigo-600 dark:text-indigo-400 font-normal">~{stream.meta.sizeGiB.toFixed(2)} GB</span>}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">{stream.title}</span>
                    
                    <div className="flex gap-2 mt-2">
                       {stream.meta.res !== 'Unknown' && <span className="px-1.5 py-0.5 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 rounded text-[10px] border border-slate-200 dark:border-slate-700">{stream.meta.res}</span>}
                       {stream.meta.video !== 'Other' && <span className="px-1.5 py-0.5 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 rounded text-[10px] border border-slate-200 dark:border-slate-700">{stream.meta.video}</span>}
                       {stream.meta.audio !== 'Other' && <span className="px-1.5 py-0.5 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 rounded text-[10px] border border-slate-200 dark:border-slate-700">{stream.meta.audio}</span>}
                       {stream.meta.bitrateMbps > 0 && (
                         <span className="px-1.5 py-0.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded text-[10px] border border-indigo-100 dark:border-indigo-500/30">
                           ~{stream.meta.bitrateMbps.toFixed(1)} Mbps {stream.meta.bitrateEstimated ? '(est)' : ''}
                         </span>
                       )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleSelect(idx, stream)}
                    disabled={selectingIdx !== null}
                    className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-sm font-medium transition-colors shrink-0 shadow mt-2 disabled:opacity-50 min-w-[80px] flex items-center justify-center"
                  >
                    {selectingIdx === idx ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : 'Select'}
                  </button>
                </div>
              ))}
              {filteredStreams.length === 0 && (
                <div className="text-slate-500 dark:text-slate-400 text-center py-12 px-4 bg-slate-50 dark:bg-slate-950/50 rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-800">
                  <p className="text-sm font-medium mb-1">No matching streams found</p>
                  <p className="text-xs opacity-70 mb-4">
                    Try adjusting your filters or checking your AIOStreams configuration in Settings.
                  </p>
                  <button 
                    onClick={handleRefresh}
                    disabled={isRefreshing}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md text-sm font-medium transition-colors shadow-sm disabled:opacity-50"
                  >
                    <RefreshCw className={cn("w-4 h-4", isRefreshing && "animate-spin")} />
                    Try Refreshing (Force Refresh)
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}
