import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Scale, Download, UploadCloud, FolderClosed, Check, X, Loader2, AlertCircle, RefreshCw, Sliders, Settings2 } from 'lucide-react';
import JSZip from 'jszip';
import confetti from 'canvas-confetti';

// Traverses drag & drop folder structures recursively (handles webkitRelativePath simulation)
const traverseFileTree = (item, path = '') => {
  return new Promise((resolve) => {
    if (item.isFile) {
      item.file((file) => {
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

export default function ImageResizer() {
  // Queue state
  const [queue, setQueue] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showToast, setShowToast] = useState(null);

  // Resize settings (Simple Width / Height inputs)
  const [targetWidth, setTargetWidth] = useState('');
  const [targetHeight, setTargetHeight] = useState('');
  const [targetSizeKb, setTargetSizeKb] = useState(200);

  // Statistics & Progress
  const [processedCount, setProcessedCount] = useState(0);
  const [totalProcessedOriginalSize, setTotalProcessedOriginalSize] = useState(0);
  const [totalProcessedResizedSize, setTotalProcessedResizedSize] = useState(0);
  const [processingTime, setProcessingTime] = useState(0);

  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const activeWorkersRef = useRef(new Map());
  const queueRef = useRef(queue);
  const isProcessingRef = useRef(isProcessing);

  const settingsRef = useRef({
    targetWidth,
    targetHeight,
    targetSizeKb
  });

  // Keep references synced for workers
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  useEffect(() => {
    settingsRef.current = {
      targetWidth,
      targetHeight,
      targetSizeKb
    };
  }, [targetWidth, targetHeight, targetSizeKb]);

  // Clean up Object URLs on unmount
  useEffect(() => {
    return () => {
      queueRef.current.forEach(item => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        if (item.resizedPreviewUrl && !item.resizedPreviewUrl.startsWith('data:')) {
          URL.revokeObjectURL(item.resizedPreviewUrl);
        }
      });
    };
  }, []);

  // Dismiss Toast helper
  useEffect(() => {
    if (showToast) {
      const timer = setTimeout(() => setShowToast(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [showToast]);

  // Read dimensions of added images to enable real-time feedback
  const loadImageDimensions = (item) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        resolve({
          width: img.naturalWidth,
          height: img.naturalHeight
        });
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => {
        resolve({ width: 0, height: 0 });
      };
      img.src = URL.createObjectURL(item.file);
    });
  };

  const addFiles = useCallback(async (fileList) => {
    const validImageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const newItems = Array.from(fileList)
      .filter(file => {
        const nameLower = file.name.toLowerCase();
        return file.type.startsWith('image/') || validImageExtensions.some(ext => nameLower.endsWith(ext));
      })
      .map(file => ({
        id: Math.random().toString(36).substring(2, 9),
        file,
        name: file.name,
        relativePath: file.webkitRelativePath || '',
        previewUrl: URL.createObjectURL(file),
        status: 'waiting', // waiting, processing, success, error
        resizedBlob: null,
        resizedPreviewUrl: null,
        originalWidth: 0,
        originalHeight: 0,
        targetWidth: 0,
        targetHeight: 0,
        resizedSize: 0,
        errorMessage: null,
        finalMimeType: null
      }));

    if (newItems.length > 0) {
      setQueue(prev => [...prev, ...newItems]);
      
      // Load dimensions asynchronously in background
      for (const item of newItems) {
        const dims = await loadImageDimensions(item);
        setQueue(prev => prev.map(q => {
          if (q.id === item.id) {
            return {
              ...q,
              originalWidth: dims.width,
              originalHeight: dims.height
            };
          }
          return q;
        }));
      }
    }
  }, []);

  const clearQueue = useCallback(() => {
    activeWorkersRef.current.forEach(worker => worker.terminate());
    activeWorkersRef.current.clear();

    queue.forEach(item => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      if (item.resizedPreviewUrl && !item.resizedPreviewUrl.startsWith('data:')) {
        URL.revokeObjectURL(item.resizedPreviewUrl);
      }
    });

    setQueue([]);
    setIsProcessing(false);
    setProcessedCount(0);
    setTotalProcessedOriginalSize(0);
    setTotalProcessedResizedSize(0);
    setProcessingTime(0);
  }, [queue]);

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
          if (entry) promises.push(traverseFileTree(entry));
        }
      }
      
      if (promises.length > 0) {
        Promise.all(promises).then((filesArrays) => {
          const flatFiles = filesArrays.flat();
          if (flatFiles.length > 0) addFiles(flatFiles);
        });
        return;
      }
    }

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }, [addFiles]);

  const handleSelectFiles = () => fileInputRef.current?.click();
  const handleSelectFolder = () => folderInputRef.current?.click();

  const handleFileInputChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
    }
  };

  // Web Worker Instance Creator
  const createResizerWorker = () => {
    return new Worker(
      new URL('../workers/resizer.worker.js', import.meta.url),
      { type: 'module' }
    );
  };

  // Perform single image resize via Worker
  const processImage = useCallback((item) => {
    return new Promise((resolve) => {
      setQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'processing' } : q));

      let worker = null;
      try {
        worker = createResizerWorker();
        activeWorkersRef.current.set(item.id, worker);

        worker.onmessage = (e) => {
          const res = e.data;
          if (res.success) {
            setQueue(prev => prev.map(q => q.id === item.id ? {
              ...q,
              status: 'success',
              resizedBlob: res.resizedBlob,
              resizedPreviewUrl: res.resizedDataURL,
              originalWidth: res.originalWidth,
              originalHeight: res.originalHeight,
              targetWidth: res.targetWidth,
              targetHeight: res.targetHeight,
              resizedSize: res.resizedBlob.size,
              finalMimeType: res.finalMimeType
            } : q));

            setTotalProcessedOriginalSize(prev => prev + res.originalSize);
            setTotalProcessedResizedSize(prev => prev + res.resizedBlob.size);
            setProcessedCount(prev => prev + 1);
            resolve(true);
          } else {
            throw new Error(res.error || 'Resizing error');
          }
          worker.terminate();
          activeWorkersRef.current.delete(item.id);
        };

        worker.onerror = (err) => {
          throw err;
        };

        const currentSettings = settingsRef.current;
        worker.postMessage({
          file: item.file,
          width: currentSettings.targetWidth ? Number(currentSettings.targetWidth) : 0,
          height: currentSettings.targetHeight ? Number(currentSettings.targetHeight) : 0,
          targetSizeKb: Number(currentSettings.targetSizeKb)
        });

      } catch (err) {
        console.error(`Error resizing ${item.name}:`, err);
        setQueue(prev => prev.map(q => q.id === item.id ? {
          ...q,
          status: 'error',
          errorMessage: err.message || 'Resizing failed'
        } : q));
        setProcessedCount(prev => prev + 1);
        if (worker) {
          worker.terminate();
          activeWorkersRef.current.delete(item.id);
        }
        resolve(false);
      }
    });
  }, []);

  // Orchestrator Loop for bulk resizing
  const startProcessing = async () => {
    if (queue.length === 0 || isProcessing) return;

    setIsProcessing(true);
    setProcessedCount(0);
    setTotalProcessedOriginalSize(0);
    setTotalProcessedResizedSize(0);
    setProcessingTime(0);

    // Reset status of all elements to waiting
    setQueue(prev => prev.map(item => ({
      ...item,
      status: 'waiting',
      resizedBlob: null,
      resizedPreviewUrl: item.resizedPreviewUrl && !item.resizedPreviewUrl.startsWith('data:') ? (URL.revokeObjectURL(item.resizedPreviewUrl), null) : null,
      errorMessage: null,
      finalMimeType: null
    })));

    const startTime = performance.now();
    const batchQueue = [...queueRef.current];
    const maxConcurrency = 4;
    let activeTasks = 0;
    let currentIndex = 0;

    return new Promise((resolve) => {
      const processNext = async () => {
        if (currentIndex >= batchQueue.length && activeTasks === 0) {
          // Finish up!
          const duration = ((performance.now() - startTime) / 1000).toFixed(1);
          setProcessingTime(Number(duration));
          setIsProcessing(false);

          confetti({
            particleCount: 120,
            spread: 80,
            origin: { y: 0.6 },
            colors: ['#7C3AED', '#4F46E5', '#10B981']
          });

          setShowToast(`Successfully processed ${batchQueue.length} images!`);
          resolve(true);
          return;
        }

        while (activeTasks < maxConcurrency && currentIndex < batchQueue.length) {
          const item = batchQueue[currentIndex++];
          activeTasks++;

          // Execute processing
          processImage(item).then(() => {
            activeTasks--;
            processNext();
          });
        }
      };

      processNext();
    });
  };

  // ZIP Generation preserving relative folder paths & adjusting extensions automatically
  const handleDownloadAll = async () => {
    if (queue.length === 0 || isZipping) return;
    setIsZipping(true);

    const zip = new JSZip();

    try {
      const promises = queue.map(async (item) => {
        const zipPath = item.relativePath || item.name;

        // If successfully resized, package the resized Blob
        if (item.status === 'success' && item.resizedBlob) {
          let finalPath = zipPath;
          
          const lastDotIndex = finalPath.lastIndexOf('.');
          let basePath = lastDotIndex !== -1 ? finalPath.substring(0, lastDotIndex) : finalPath;
          let ext = lastDotIndex !== -1 ? finalPath.substring(lastDotIndex) : '';

          // Remap extension if converted to modern compressed mime types
          if (item.finalMimeType === 'image/webp' && ext.toLowerCase() !== '.webp') {
            ext = '.webp';
          } else if (item.finalMimeType === 'image/jpeg' && ext.toLowerCase() !== '.jpg' && ext.toLowerCase() !== '.jpeg') {
            ext = '.jpg';
          }

          finalPath = `${basePath}${ext}`;
          zip.file(finalPath, item.resizedBlob);
        } else {
          // Fallback to original untouched file
          zip.file(zipPath, item.file);
        }
      });

      await Promise.all(promises);
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      
      let zipName = 'resized_images.zip';
      const firstPath = queue.find(item => item.relativePath)?.relativePath;
      if (firstPath) {
        const rootFolder = firstPath.split('/')[0];
        if (rootFolder) zipName = `${rootFolder}_resized.zip`;
      }

      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = zipName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to create ZIP package:', err);
    } finally {
      setIsZipping(false);
    }
  };

  // UI Utilities
  const formatBytes = (bytes, decimals = 2) => {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  };

  // Statistics counters
  const successItems = queue.filter(item => item.status === 'success');
  const progressPercent = queue.length > 0 ? Math.round((processedCount / queue.length) * 100) : 0;

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Hidden Upload Inputs */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileInputChange}
        multiple
        accept="image/png, image/jpeg, image/webp, image/gif"
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

      {queue.length === 0 ? (
        /* Empty State Drop Zone */
        <div className="flex-1 flex items-center justify-center p-8 bg-[#0D0D10]">
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
              <p className="text-lg font-semibold text-white font-display">
                Drop folder or images to resize
              </p>
              <p className="text-sm text-[#888896] mt-1.5 font-sans">
                Supports JPG, PNG, WEBP, GIF — Offline, locally in your browser
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
                className="bg-[#181822] hover:bg-[#20202B] text-white border border-[#2E2E38] text-xs font-semibold px-5 py-2.5 rounded-xl flex items-center gap-1.5 transition-all"
              >
                <FolderClosed size={14} className="text-[#888896]" />
                Select Folder
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Workspace Active State */
        <div className="flex-1 flex overflow-hidden">
          {/* Left Column: Image Previews & Statistics */}
          <div className="w-[65%] h-full flex flex-col p-6 overflow-y-auto bg-[#0D0D10]">
            <div className="flex items-center justify-between mb-5 shrink-0">
              <div className="flex items-center gap-2">
                <h2 className="text-xs font-bold text-white tracking-wider uppercase font-display text-glow">
                  Batch Queue
                </h2>
                <span className="bg-[#181822] border border-[#2E2E38] px-2.5 py-0.5 rounded-full text-xs font-mono text-[#888896]">
                  {queue.length} files
                </span>
              </div>

              <button
                onClick={clearQueue}
                disabled={isProcessing}
                className="text-xs text-[#888896] hover:text-white disabled:opacity-40 flex items-center gap-1 transition-colors"
              >
                <RefreshCw size={12} className={isProcessing ? 'animate-spin' : ''} />
                Clear All
              </button>
            </div>

            {/* Thumbnail Preview Grid */}
            <div className="grid grid-cols-4 gap-4 pb-8">
              {queue.map((item) => {
                let badgeBg = 'bg-[#181822] text-[#888896] border-[#2A2A35]';
                let badgeText = 'Waiting';

                if (item.status === 'processing') {
                  badgeBg = 'bg-[#1E3A8A] text-[#93C5FD] border-[#1D4ED8]/30';
                  badgeText = 'Resizing...';
                } else if (item.status === 'success') {
                  badgeBg = 'bg-[#064E3B] text-[#6EE7B7] border-[#047857]/30';
                  badgeText = 'Resized ✓';
                } else if (item.status === 'error') {
                  badgeBg = 'bg-[#7F1D1D] text-[#FCA5A5] border-[#B91C1C]/30';
                  badgeText = 'Error';
                }

                const preview = item.resizedPreviewUrl || item.previewUrl;
                const sizeChange = item.status === 'success'
                  ? Math.round(((item.file.size - item.resizedSize) / item.file.size) * 100)
                  : 0;

                return (
                  <div
                    key={item.id}
                    className="group bg-[#18181F] border border-[#2E2E38]/50 rounded-xl overflow-hidden shadow-md flex flex-col relative transition-all duration-300 hover:border-[#3B3B48]"
                  >
                    {/* Thumbnail Image */}
                    <div className="aspect-square bg-[#0D0D10] w-full relative overflow-hidden shrink-0">
                      <img
                        src={preview}
                        alt={item.name}
                        className="w-full h-full object-cover select-none pointer-events-none group-hover:scale-[1.02] transition-transform duration-300"
                      />

                      {/* Success Overlay */}
                      {item.status === 'success' && (
                        <div className="absolute inset-0 bg-[#064E3B]/10 flex items-center justify-center backdrop-blur-[0.5px]">
                          <div className="bg-[#10B981] text-white p-1.5 rounded-full shadow-lg scale-100">
                            <Check size={14} className="stroke-[3]" />
                          </div>
                        </div>
                      )}

                      {/* Resizing Processing Spinner */}
                      {item.status === 'processing' && (
                        <div className="absolute inset-0 bg-[#0D0D10]/70 flex items-center justify-center">
                          <Loader2 className="w-6 h-6 text-[#7C3AED] animate-spin" />
                        </div>
                      )}
                    </div>

                    {/* Metadata Detail */}
                    <div className="p-3 flex flex-col justify-between flex-1 gap-2">
                      <div>
                        <span title={item.name} className="text-xs font-semibold text-white truncate max-w-full block font-sans">
                          {item.name}
                        </span>
                        {item.originalWidth > 0 && (
                          <div className="text-[10px] text-[#888896] mt-0.5 font-mono">
                            {item.status === 'success' ? (
                              <div className="space-y-0.5">
                                <div>
                                  {item.originalWidth}x{item.originalHeight} ➔ <span className="text-[#10B981] font-bold">{item.targetWidth}x{item.targetHeight}</span>
                                </div>
                                <div className="text-[9px]">
                                  {formatBytes(item.file.size)} ➔ <span className="text-[#10B981] font-bold">{formatBytes(item.resizedSize)}</span>
                                </div>
                              </div>
                            ) : (
                              <div className="space-y-0.5">
                                <div>{item.originalWidth} x {item.originalHeight} px</div>
                                <div className="text-[9px]">{formatBytes(item.file.size)}</div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center justify-between">
                        <span className={`px-2 py-0.5 rounded text-[9px] font-mono border ${badgeBg}`}>
                          {badgeText}
                        </span>

                        {item.status === 'success' && (
                          <span className="text-[10px] font-mono font-bold text-[#10B981]">
                            {sizeChange > 0 ? `-${sizeChange}%` : `${Math.abs(sizeChange)}%`}
                          </span>
                        )}

                        {item.status === 'error' && (
                          <span title={item.errorMessage} className="text-[#EF4444] cursor-pointer hover:text-red-400">
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

          {/* Right Column: Settings & Configuration Panel */}
          <div className="w-[35%] h-full border-l border-[#1C1C24] bg-[#121218] flex flex-col p-6 overflow-y-auto">
            <div className="space-y-6 flex-1">
              
              {/* Core Run Action Button */}
              <button
                onClick={startProcessing}
                disabled={isProcessing || queue.length === 0}
                className="w-full py-4 rounded-xl text-white font-bold tracking-wide uppercase transition-all duration-300 transform active:scale-95 disabled:opacity-50 disabled:scale-100 disabled:cursor-not-allowed bg-gradient-to-r from-[#7C3AED] to-[#4F46E5] hover:opacity-95 shadow-xl shadow-[#7C3AED]/20 text-sm flex items-center justify-center gap-2"
              >
                {isProcessing ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Resizing batch...
                  </>
                ) : (
                  'Resize & Compress All'
                )}
              </button>

              {/* Progress bar during execution */}
              {isProcessing && (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-[#888896]">
                    <span>Processing: {processedCount} / {queue.length} images</span>
                    <span className="text-white">{progressPercent}%</span>
                  </div>
                  <div className="h-2 w-full bg-[#18181F] border border-[#2E2E38] rounded-full overflow-hidden">
                    <div
                      style={{ width: `${progressPercent}%` }}
                      className="h-full bg-gradient-to-r from-[#7C3AED] to-[#4F46E5] rounded-full transition-all duration-300 relative overflow-hidden"
                    >
                      <div className="absolute inset-0 bg-[linear-gradient(90deg,transparent_0%,rgba(255,255,255,0.25)_50%,transparent_100%)] animate-[shimmer_1.5s_infinite]" />
                    </div>
                  </div>
                </div>
              )}

              {/* Statistics Dashboard Panel */}
              {successItems.length > 0 && !isProcessing && (
                <div className="bg-[#18181F] border border-[#1E1E26] rounded-xl p-4 space-y-3 font-mono text-xs">
                  <div className="flex justify-between items-center text-[#E8E8F0] border-b border-[#2E2E38]/30 pb-2 mb-1">
                    <span className="font-semibold text-white uppercase text-[10px] tracking-wider font-sans">
                      Compression Statistics
                    </span>
                    {processingTime > 0 && (
                      <span className="text-[10px] text-[#888896]">{processingTime}s</span>
                    )}
                  </div>
                  <div className="flex justify-between items-center text-[#888896]">
                    <span>Original Size:</span>
                    <span className="text-white font-bold">{formatBytes(totalProcessedOriginalSize)}</span>
                  </div>
                  <div className="flex justify-between items-center text-[#888896]">
                    <span>Compressed Size:</span>
                    <span className="text-[#10B981] font-bold">{formatBytes(totalProcessedResizedSize)}</span>
                  </div>
                  <div className="flex justify-between items-center border-t border-[#2E2E38]/30 pt-2 text-[#E8E8F0]">
                    <span className="font-bold">Bandwidth Saved:</span>
                    <span className="font-bold text-[#10B981]">
                      {Math.max(0, Math.round(((totalProcessedOriginalSize - totalProcessedResizedSize) / (totalProcessedOriginalSize || 1)) * 100))}%
                    </span>
                  </div>
                </div>
              )}

              {/* Card 1: Size Settings */}
              <div className="bg-[#18181F] border border-[#1E1E26] rounded-xl p-4 space-y-3.5">
                <div className="flex items-center gap-1.5 border-b border-[#2E2E38]/50 pb-2 mb-1">
                  <Sliders size={13} className="text-[#7C3AED]" />
                  <span className="text-xs font-bold text-white tracking-wide uppercase font-display">
                    Size Settings
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-semibold text-[#888896]">Width (px)</label>
                    <input
                      type="number"
                      placeholder="Auto"
                      value={targetWidth}
                      onChange={(e) => {
                        const val = e.target.value;
                        setTargetWidth(val === '' ? '' : Math.max(1, parseInt(val) || 0));
                      }}
                      disabled={isProcessing}
                      className="w-full bg-[#0D0D10] border border-[#2E2E38] rounded-lg p-2 text-xs text-white font-mono focus:border-[#7C3AED] focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-semibold text-[#888896]">Height (px)</label>
                    <input
                      type="number"
                      placeholder="Auto"
                      value={targetHeight}
                      onChange={(e) => {
                        const val = e.target.value;
                        setTargetHeight(val === '' ? '' : Math.max(1, parseInt(val) || 0));
                      }}
                      disabled={isProcessing}
                      className="w-full bg-[#0D0D10] border border-[#2E2E38] rounded-lg p-2 text-xs text-white font-mono focus:border-[#7C3AED] focus:outline-none"
                    />
                  </div>
                </div>
                <p className="text-[10px] text-[#888896] leading-relaxed">
                  Enter target dimensions. If only one input is provided, the other scales proportionally. If both are defined, the engine resizes every image to exactly those dimensions, stretching if needed, ignoring aspect ratio completely, and fully allowing upscaling.
                </p>
              </div>

              {/* Card 2: Target File Size */}
              <div className="bg-[#18181F] border border-[#1E1E26] rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-1.5 border-b border-[#2E2E38]/50 pb-2 mb-1">
                  <Settings2 size={13} className="text-[#7C3AED]" />
                  <span className="text-xs font-bold text-white tracking-wide uppercase font-display">
                    Target File Size
                  </span>
                </div>
                <div className="space-y-1.5">
                  <div className="flex justify-between items-center">
                    <label className="text-[10px] font-semibold text-[#888896] block">Target Size (KB)</label>
                    <span className="text-xs font-mono font-semibold text-[#7C3AED]">{targetSizeKb} KB</span>
                  </div>
                  <input
                    type="range"
                    min="10"
                    max="2000"
                    step="10"
                    value={targetSizeKb}
                    onChange={(e) => setTargetSizeKb(parseInt(e.target.value))}
                    disabled={isProcessing}
                    className="w-full h-1 bg-[#2E2E38] rounded-lg appearance-none cursor-pointer accent-[#7C3AED] disabled:opacity-40"
                  />
                  <div className="flex justify-between text-[8px] font-mono text-[#888896] pt-0.5">
                    <span>10 KB</span>
                    <span>1000 KB</span>
                    <span>2000 KB</span>
                  </div>
                </div>
                <p className="text-[10px] text-[#888896] leading-relaxed">
                  Sets the desired maximum output size. The engine uses a local binary search on image quality to compress under this limit. Lossless PNGs automatically fall back to WebP if PNG compression exceeds target.
                </p>
              </div>

            </div>

            {/* Downloader Footer Button */}
            <div className="pt-6 border-t border-[#1C1C24] shrink-0 mt-6">
              <button
                onClick={handleDownloadAll}
                disabled={isProcessing || queue.length === 0 || successItems.length === 0 || isZipping}
                className="w-full py-3.5 rounded-xl font-semibold border border-[#2E2E38] hover:border-[#3B3B48] text-[#E8E8F0] hover:bg-[#18181F] disabled:opacity-20 disabled:hover:bg-transparent disabled:hover:border-[#2E2E38] disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 text-xs"
              >
                {isZipping ? (
                  <>
                    <Loader2 size={15} className="animate-spin" />
                    Packaging ZIP Archive...
                  </>
                ) : (
                  <>
                    <Download size={15} />
                    Download All Resized
                  </>
                )}
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Toast popup */}
      {showToast && (
        <div className="fixed bottom-6 right-6 z-50 bg-[#18181F] border border-[#10B981] px-5 py-4 rounded-xl shadow-2xl flex items-center gap-3 animate-slide-in">
          <div className="bg-[#10B981]/20 text-[#10B981] p-1.5 rounded-lg">
            <Check size={18} className="stroke-[3]" />
          </div>
          <div>
            <p className="text-white font-semibold text-sm">Operation Complete</p>
            <p className="text-[#888896] text-xs mt-0.5">{showToast}</p>
          </div>
          <button onClick={() => setShowToast(null)} className="text-[#888896] hover:text-white ml-2">
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

