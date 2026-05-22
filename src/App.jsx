import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sparkles, Download, UploadCloud, FolderClosed, Check, X, Loader2, AlertCircle, RefreshCw, Scale, ChevronLeft, ChevronRight } from 'lucide-react';
import JSZip from 'jszip';
import confetti from 'canvas-confetti';

// Import our custom bulk processor hook
import { useBulkProcessor } from './hooks/useBulkProcessor';
import ImageResizer from './components/ImageResizer';

// Helper: recursively traverse directory entries for drag and drop folder uploads
const traverseFileTree = (item, path = '') => {
  return new Promise((resolve) => {
    if (item.isFile) {
      item.file((file) => {
        // Define webkitRelativePath on the File object so it mirrors the standard webkitdirectory input behavior
        Object.defineProperty(file, 'webkitRelativePath', {
          value: path + item.name,
          writable: false
        });
        resolve([file]);
      });
    } else if (item.isDirectory) {
      const dirReader = item.createReader();
      const readAllEntries = () => {
        return new Promise((resolveEntries) => {
          const allEntries = [];
          const readEntries = () => {
            dirReader.readEntries((entries) => {
              if (entries.length === 0) {
                resolveEntries(allEntries);
              } else {
                allEntries.push(...entries);
                readEntries();
              }
            }, () => resolveEntries(allEntries));
          };
          readEntries();
        });
      };
      
      readAllEntries().then((entries) => {
        const promises = entries.map(entry => traverseFileTree(entry, path + item.name + '/'));
        Promise.all(promises).then((results) => {
          resolve(results.flat());
        });
      });
    } else {
      resolve([]);
    }
  });
};

// Helper: Convert Data URL back to Blob of a custom MIME type (preserves format)
const dataURLToCustomBlob = (dataurl, targetMime) => {
  return new Promise((resolve) => {
    // If it's already the target mime or target mime is PNG, just convert directly using standard fast method
    if (!targetMime || targetMime === 'image/png') {
      const arr = dataurl.split(',');
      const mime = arr[0].match(/:(.*?);/)[1];
      const bstr = atob(arr[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      resolve(new Blob([u8arr], { type: mime }));
      return;
    }

    // Otherwise, load into an Image and draw to a canvas to export as targetMime
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          // Fallback if canvas export fails
          const arr = dataurl.split(',');
          const mime = arr[0].match(/:(.*?);/)[1];
          const bstr = atob(arr[1]);
          let n = bstr.length;
          const u8arr = new Uint8Array(n);
          while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
          }
          resolve(new Blob([u8arr], { type: mime }));
        }
      }, targetMime, 0.95); // High quality for jpeg/webp
    };
    img.onerror = () => {
      // Fallback
      const arr = dataurl.split(',');
      const mime = arr[0].match(/:(.*?);/)[1];
      const bstr = atob(arr[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      resolve(new Blob([u8arr], { type: mime }));
    };
    img.src = dataurl;
  });
};

export default function App() {
  const {
    queue,
    isProcessing,
    inpaintStrength,
    setInpaintStrength,
    showToast,
    setShowToast,
    stats,
    progressPercent,
    addFiles,
    clearQueue,
    startProcessing
  } = useBulkProcessor();

  const [activeTab, setActiveTab] = useState('watermark');
  const [isDragging, setIsDragging] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  // Trigger confetti on successful batch completion
  const prevProcessing = useRef(false);
  useEffect(() => {
    if (prevProcessing.current && !isProcessing && stats.total > 0 && stats.processed === stats.total) {
      if (stats.removed > 0) {
        confetti({
          particleCount: 120,
          spread: 80,
          origin: { y: 0.6 },
          colors: ['#7C3AED', '#4F46E5', '#10B981']
        });
      }
    }
    prevProcessing.current = isProcessing;
  }, [isProcessing, stats.processed, stats.total, stats.removed]);

  // Auto-dismiss toast after 5 seconds
  useEffect(() => {
    if (showToast) {
      const timer = setTimeout(() => {
        setShowToast(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [showToast, setShowToast]);

  // Handle Drag & Drop events
  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    
    const items = e.dataTransfer.items;
    if (items && items.length > 0) {
      const promises = [];
      for (let i = 0; i < items.length; i++) {
        if (typeof items[i].webkitGetAsEntry === 'function') {
          const entry = items[i].webkitGetAsEntry();
          if (entry) {
            promises.push(traverseFileTree(entry));
          }
        }
      }
      
      if (promises.length > 0) {
        Promise.all(promises).then((filesArrays) => {
          const flatFiles = filesArrays.flat();
          if (flatFiles.length > 0) {
            addFiles(flatFiles);
          }
        });
        return;
      }
    }
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }, [addFiles]);

  const handleSelectFiles = () => {
    fileInputRef.current?.click();
  };

  const handleSelectFolder = () => {
    folderInputRef.current?.click();
  };

  const handleFileInputChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
    }
  };

  // ZIP Generation & Download All Cleaned
  const handleDownloadAll = async () => {
    if (queue.length === 0) return;
    setIsZipping(true);

    const zip = new JSZip();

    try {
      const promises = queue.map(async (item) => {
        // Recreate original subfolder structure & filename exactly
        const zipPath = item.relativePath || item.name;

        if (item.status === 'removed' && item.cleanedImageDataURL) {
          // Convert PNG cleaned image back to the original MIME type to preserve format
          const targetMime = item.file.type;
          const blob = await dataURLToCustomBlob(item.cleanedImageDataURL, targetMime);
          zip.file(zipPath, blob);
        } else {
          // Keep original untouched file (lossless & same format) for not_found/error/waiting items
          zip.file(zipPath, item.file);
        }
      });

      await Promise.all(promises);

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      
      // Use root folder name from the first relative path if available, e.g. "businessupscaler_cleaned.zip"
      let zipName = 'cleaned_images.zip';
      const firstPath = queue.find(item => item.relativePath)?.relativePath;
      if (firstPath) {
        const rootFolder = firstPath.split('/')[0];
        if (rootFolder) {
          zipName = `${rootFolder}_cleaned.zip`;
        }
      }

      link.download = zipName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to create ZIP archive:', err);
    } finally {
      setIsZipping(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#0D0D10] text-[#E8E8F0] antialiased selection:bg-[#7C3AED]/30 selection:text-white font-sans">
      {/* Hidden File Inputs */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileInputChange}
        multiple
        accept="image/png, image/jpeg, image/webp"
        className="hidden"
      />
      <input
        type="file"
        ref={folderInputRef}
        onChange={handleFileInputChange}
        webkitdirectory=""
        directory=""
        className="hidden"
      />

      {/* ZONE A — TOP HEADER */}
      <header className="h-[60px] border-b border-[#1C1C24] bg-[#0D0D10]/80 backdrop-blur-md px-6 flex items-center justify-between shrink-0 sticky top-0 z-40 relative">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#7C3AED] to-[#4F46E5] flex items-center justify-center shadow-lg shadow-[#7C3AED]/20">
              <Sparkles className="w-4 h-4 text-white animate-pulse" />
            </div>
            <span className="font-semibold text-base tracking-tight text-white font-display text-glow hidden sm:block">
              Gemini Tools
            </span>
          </div>

          {/* Navigation Tab Bar */}
          <div className="flex bg-[#121218]/90 border border-[#2E2E38] rounded-xl p-1 shrink-0 transition-all duration-300">
            <button
              onClick={() => setActiveTab('watermark')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-300 ${
                activeTab === 'watermark'
                  ? 'bg-gradient-to-r from-[#7C3AED] to-[#4F46E5] text-white shadow-md shadow-[#7C3AED]/15'
                  : 'text-[#888896] hover:text-[#E8E8F0] hover:bg-[#1E1E26]'
              }`}
            >
              <Sparkles size={13} />
              Watermark Remover
            </button>
            <button
              onClick={() => setActiveTab('resizer')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-300 ${
                activeTab === 'resizer'
                  ? 'bg-gradient-to-r from-[#7C3AED] to-[#4F46E5] text-white shadow-md shadow-[#7C3AED]/15'
                  : 'text-[#888896] hover:text-[#E8E8F0] hover:bg-[#1E1E26]'
              }`}
            >
              <Scale size={13} />
              Image Resizer
            </button>
          </div>
        </div>

        {/* Absolutely Centered Credit Badge */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none hidden md:block">
          <span className="text-xs font-semibold tracking-wide text-[#888896] bg-[#18181F] border border-[#2E2E38] px-4 py-1.5 rounded-full font-mono pointer-events-auto shadow-sm">
            Built By Ahmed Naeem
          </span>
        </div>

        {/* Header Clean Download Shortcut */}
        {activeTab === 'watermark' && stats.removed > 0 && !isProcessing && (
          <button
            onClick={handleDownloadAll}
            disabled={isZipping}
            className="flex items-center gap-2 bg-gradient-to-r from-[#7C3AED] to-[#4F46E5] hover:opacity-95 text-[#E8E8F0] font-semibold text-xs px-4 py-2 rounded-lg transition-all shadow-md shadow-[#7C3AED]/20 z-10 disabled:opacity-50"
          >
            {isZipping ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Zipping...
              </>
            ) : (
              <>
                <Download size={14} />
                Download All Cleaned
              </>
            )}
          </button>
        )}
      </header>

      {/* MAIN CONTAINER */}
      <main className="flex-1 flex overflow-hidden">
        {activeTab === 'watermark' ? (
          queue.length === 0 ? (
          /* ZONE B — UPLOAD AREA (empty state) */
          <div className="flex-1 flex items-center justify-center p-8">
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={handleSelectFiles}
              className={`w-full max-w-2xl aspect-[16/10] border-2 border-dashed rounded-2xl flex flex-col items-center justify-center gap-6 cursor-pointer p-8 transition-all duration-300 bg-[#121218] ${
                isDragging
                  ? 'border-[#7C3AED] bg-[#121218]/80 scale-[1.01] shadow-2xl shadow-[#7C3AED]/5'
                  : 'border-[#2E2E38] hover:border-[#3B3B48] hover:bg-[#121218]/60'
              }`}
            >
              <div className="w-16 h-16 rounded-2xl bg-[#181822] border border-[#2E2E38] flex items-center justify-center shadow-md">
                <UploadCloud className={`w-8 h-8 ${isDragging ? 'text-[#7C3AED]' : 'text-[#888896]'} transition-colors`} />
              </div>

              <div className="text-center">
                <p className="text-lg font-semibold text-white">
                  Drop a folder or images here
                </p>
                <p className="text-sm text-[#888896] mt-1.5">
                  Supports JPG, PNG, WEBP — any quantity
                </p>
              </div>

              <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={handleSelectFiles}
                  className="bg-[#181822] hover:bg-[#20202B] text-white border border-[#2E2E38] text-xs font-semibold px-5 py-2.5 rounded-xl transition-all"
                >
                  Choose Images
                </button>
                <button
                  onClick={handleSelectFolder}
                  className="bg-[#181822] hover:bg-[#20202B] text-white border border-[#2E2E38] text-xs font-semibold px-5 py-2.5 rounded-xl transition-all flex items-center gap-1.5"
                >
                  <FolderClosed size={14} className="text-[#888896]" />
                  Select Folder
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* ZONE C — PROCESSING VIEW */
          <div className="flex-1 flex overflow-hidden">
            {/* LEFT COLUMN — Image grid */}
            <div className="w-[65%] h-full flex flex-col p-6 overflow-y-auto">
              <div className="flex items-center justify-between mb-5 shrink-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-white tracking-wide uppercase">
                    Queue Items
                  </h2>
                  <span className="bg-[#181822] border border-[#2E2E38] px-2 py-0.5 rounded-full text-xs font-mono text-[#888896]">
                    {queue.length}
                  </span>
                </div>

                <button
                  onClick={clearQueue}
                  disabled={isProcessing}
                  className="text-xs text-[#888896] hover:text-white disabled:opacity-40 flex items-center gap-1 transition-colors"
                >
                  <RefreshCw size={12} className={isProcessing ? 'animate-spin' : ''} />
                  Clear Queue
                </button>
              </div>

              {/* Grid Layout */}
              <div className="grid grid-cols-4 gap-4 pb-8">
                {queue.map((item) => {
                  let badgeBg = 'bg-[#181822] text-[#888896] border-[#2A2A35]';
                  let badgeText = 'Waiting';
                  let pulseClass = '';

                  if (item.status === 'scanning') {
                    badgeBg = 'bg-[#1E3A8A] text-[#93C5FD] border-[#1D4ED8]/30';
                    badgeText = 'Scanning';
                    pulseClass = 'animate-pulse';
                  } else if (item.status === 'removed') {
                    badgeBg = 'bg-[#064E3B] text-[#6EE7B7] border-[#047857]/30';
                    badgeText = 'Removed ✓';
                  } else if (item.status === 'not_found') {
                    badgeBg = 'bg-[#78350F] text-[#FDE68A] border-[#D97706]/30';
                    badgeText = 'Not Found';
                  } else if (item.status === 'error') {
                    badgeBg = 'bg-[#7F1D1D] text-[#FCA5A5] border-[#B91C1C]/30';
                    badgeText = 'Error';
                  }

                  const preview = item.cleanedImageDataURL || item.previewUrl;

                  return (
                    <div
                      key={item.id}
                      className="group bg-[#18181F] border border-[#1E1E26] rounded-xl overflow-hidden shadow-md flex flex-col relative"
                    >
                      {/* Image Thumbnail with Checked Overlay */}
                      <div className="aspect-square bg-[#0D0D10] w-full relative overflow-hidden shrink-0">
                        <img
                          src={preview}
                          alt={item.name}
                          className="w-full h-full object-cover select-none pointer-events-none group-hover:scale-[1.03] transition-transform duration-300"
                        />

                        {/* Subtle Green Check Overlay on success */}
                        {item.status === 'removed' && (
                          <div className="absolute inset-0 bg-[#064E3B]/20 flex items-center justify-center backdrop-blur-[1px]">
                            <div className="bg-[#10B981] text-white p-2 rounded-full shadow-lg scale-110">
                              <Check size={18} className="stroke-[3]" />
                            </div>
                          </div>
                        )}

                        {/* Scanning Overlay */}
                        {item.status === 'scanning' && (
                          <div className="absolute inset-0 bg-[#0D0D10]/60 flex items-center justify-center">
                            <Loader2 className="w-7 h-7 text-[#7C3AED] animate-spin" />
                          </div>
                        )}
                      </div>

                      {/* Info Panel */}
                      <div className="p-3 flex flex-col justify-between flex-1 gap-2.5">
                        <span
                          title={item.name}
                          className="text-xs font-medium text-white truncate max-w-full block"
                        >
                          {item.name}
                        </span>

                        <div className="flex items-center justify-between">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${badgeBg} ${pulseClass}`}
                          >
                            {badgeText}
                          </span>

                          {item.status === 'error' && (
                            <span
                              title={item.errorMessage}
                              className="text-red-500 cursor-pointer hover:text-red-400"
                            >
                              <AlertCircle size={12} />
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* RIGHT COLUMN — Control panel (Only settings area) */}
            <div className="w-[35%] h-full border-l border-[#1C1C24] bg-[#121218] flex flex-col p-6 overflow-y-auto">
              <div className="flex flex-col gap-6 flex-1">
                {/* Big Primary Button */}
                <button
                  onClick={startProcessing}
                  disabled={isProcessing}
                  className="w-full py-4 rounded-xl text-white font-bold tracking-wide uppercase transition-all duration-300 transform active:scale-95 disabled:opacity-50 disabled:scale-100 disabled:cursor-not-allowed bg-gradient-to-r from-[#7C3AED] to-[#4F46E5] hover:opacity-95 shadow-xl shadow-[#7C3AED]/20 text-sm flex items-center justify-center gap-2"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      Processing...
                    </>
                  ) : (
                    'Remove All Watermarks'
                  )}
                </button>

                {/* Progress bar */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-[#888896]">
                    <span>
                      Progress: {stats.processed} / {stats.total} images
                    </span>
                    <span className="text-white">{progressPercent}%</span>
                  </div>

                  <div className="h-2 w-full bg-[#18181F] border border-[#2E2E38] rounded-full overflow-hidden">
                    <div
                      style={{ width: `${progressPercent}%` }}
                      className="h-full bg-gradient-to-r from-[#7C3AED] to-[#4F46E5] rounded-full transition-all duration-300 relative overflow-hidden"
                    >
                      {isProcessing && (
                        <div className="absolute inset-0 bg-[linear-gradient(90deg,transparent_0%,rgba(255,255,255,0.25)_50%,transparent_100%)] animate-[shimmer_1.5s_infinite]" />
                      )}
                    </div>
                  </div>
                </div>

                {/* Status Counters */}
                <div className="bg-[#18181F] border border-[#1E1E26] rounded-xl p-4 space-y-3 font-mono text-xs">
                  <div className="flex justify-between items-center text-[#E8E8F0]">
                    <span className="flex items-center gap-1.5">
                      <Check size={14} className="text-[#10B981]" />
                      ✓ Removed:
                    </span>
                    <span className="font-bold text-[#10B981]">{stats.removed}</span>
                  </div>

                  <div className="flex justify-between items-center text-[#E8E8F0]">
                    <span className="flex items-center gap-1.5">
                      <span className="w-3.5 h-3.5 border-2 border-[#F59E0B] rounded-full inline-block shrink-0" />
                      ○ Not Found:
                    </span>
                    <span className="font-bold text-[#F59E0B]">{stats.notFound}</span>
                  </div>

                  <div className="flex justify-between items-center text-[#E8E8F0]">
                    <span className="flex items-center gap-1.5">
                      <X size={14} className="text-[#EF4444]" />
                      ✕ Errors:
                    </span>
                    <span className="font-bold text-[#EF4444]">{stats.error}</span>
                  </div>
                </div>

                {/* Inpaint Strength Slider */}
                <div className="space-y-3 bg-[#18181F] border border-[#1E1E26] rounded-xl p-4">
                  <div className="flex justify-between items-center">
                    <span className="text-xs font-semibold text-white tracking-wide">
                      Inpaint Strength
                    </span>
                    <span className="text-xs font-mono font-bold text-[#7C3AED]">
                      {inpaintStrength}
                    </span>
                  </div>

                  <input
                    type="range"
                    min="1"
                    max="10"
                    value={inpaintStrength}
                    onChange={(e) => setInpaintStrength(parseInt(e.target.value))}
                    disabled={isProcessing}
                    className="w-full h-1 bg-[#2E2E38] rounded-lg appearance-none cursor-pointer accent-[#7C3AED] disabled:opacity-40 disabled:cursor-not-allowed"
                  />

                  <p className="text-[10px] text-[#888896] leading-relaxed">
                    (1 setting only — how aggressively to blend)
                  </p>
                </div>
              </div>

              {/* Lower Download Button */}
              <div className="pt-6 border-t border-[#1C1C24] shrink-0">
                <button
                  onClick={handleDownloadAll}
                  disabled={isProcessing || stats.removed === 0 || isZipping}
                  className="w-full py-3.5 rounded-xl font-semibold border border-[#2E2E38] hover:border-[#3B3B48] text-[#E8E8F0] hover:bg-[#18181F] disabled:opacity-20 disabled:hover:bg-transparent disabled:hover:border-[#2E2E38] disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 text-xs"
                >
                  {isZipping ? (
                    <>
                      <Loader2 size={15} className="animate-spin" />
                      Creating ZIP Archive...
                    </>
                  ) : (
                    <>
                      <Download size={15} />
                      Download All Cleaned
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )) : (
          <ImageResizer />
        )}
      </main>

      {/* FLOATING TOAST NOTIFICATION */}
      {showToast && (
        <div className="fixed bottom-6 right-6 z-50 bg-[#18181F] border border-[#10B981] px-5 py-4 rounded-xl shadow-2xl flex items-center gap-3 animate-slide-in">
          <div className="bg-[#10B981]/20 text-[#10B981] p-1.5 rounded-lg">
            <Check size={18} className="stroke-[3]" />
          </div>
          <div>
            <p className="text-white font-semibold text-sm">Removal Complete</p>
            <p className="text-[#888896] text-xs mt-0.5">{showToast}</p>
          </div>
          <button
            onClick={() => setShowToast(null)}
            className="text-[#888896] hover:text-[#E8E8F0] ml-2"
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
