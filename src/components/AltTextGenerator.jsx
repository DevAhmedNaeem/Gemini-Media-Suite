import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sparkles, Download, UploadCloud, FolderClosed, Check, X, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import JSZip from 'jszip';
import confetti from 'canvas-confetti';

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

// Query Google Gemini API
export async function generateAltTextGemini(imageFile) {
  const API_KEY = "AIzaSyCq0HLGVlBlt0m0HbGB1Z-WQgeFeD5OrKs";

  // Convert image to base64
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // result is "data:image/jpeg;base64,XXXX" — extract only the base64 part
      const base64String = reader.result.split(',')[1];
      resolve(base64String);
    };
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(imageFile);
  });

  // Determine mime type
  const mimeType = imageFile.type || 'image/jpeg';

  const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${API_KEY}`;

  let response;
  let responseText;

  try {
    response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: 'Describe this image in exactly 5 to 6 words. Reply with only those words, nothing else, no punctuation.' },
            {
              inlineData: {
                mimeType: mimeType,
                data: base64
              }
            }
          ]
        }]
      })
    });

    try {
      responseText = await response.text();
    } catch (e) {
      throw new Error('Could not read response');
    }
  } catch (networkErr) {
    throw new Error('Network error: ' + networkErr.message);
  }

  if (!response.ok) {
    if (response.status === 400) throw new Error('Bad request. Check API key or image type.');
    if (response.status === 403) throw new Error('Invalid or unauthorized Gemini API key.');
    if (response.status === 429) throw new Error('Rate limit hit. Standard key limit is 15 RPM. Try again in 60s.');
    throw new Error('API error ' + response.status + ': ' + responseText.slice(0, 120));
  }

  let result;
  try {
    result = JSON.parse(responseText);
  } catch (e) {
    throw new Error('Bad JSON response: ' + responseText.slice(0, 100));
  }

  const caption = result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!caption) {
    throw new Error('Empty response from Gemini API. Raw: ' + JSON.stringify(result).slice(0, 100));
  }

  // Trim to 6 words max as safety net and remove punctuation
  const cleanCaption = caption.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, '').trim();
  const formattedCaption = cleanCaption.charAt(0).toUpperCase() + cleanCaption.slice(1);
  const words = formattedCaption.split(/\s+/);
  return words.slice(0, 6).join(' ');
}

// Sleep helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Batching constants
const BATCH_SIZE = 14; // stay safely under 15 RPM limit
const RATE_LIMIT_WAIT_MS = 62000; // 62 seconds (2s buffer over 60s)

// Helper: format alt text for filename preserving spaces and casing
function formatAltTextForFilename(text) {
  if (!text) return '';
  return text
    .toString()
    .trim()
    // Remove invalid filename characters on Windows/Mac/Linux
    .replace(/[<>:"\/\\|?*\x00-\x1F]/g, '')
    // Replace multiple spaces with a single space
    .replace(/\s+/g, ' ');
}

export default function AltTextGenerator() {
  const [queue, setQueue] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [processedCount, setProcessedCount] = useState(0);
  const [showToast, setShowToast] = useState(null);



  // Cooldown state (Step 2)
  const [isCooldown, setIsCooldown] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [cooldownBatchInfo, setCooldownBatchInfo] = useState({ current: 0, total: 0 });
  const [currentProcessingIndex, setCurrentProcessingIndex] = useState(0);

  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const queueRef = useRef(queue);
  // Sync ref to prevent stale closures in fetch callbacks
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  // Clean up Object URLs on component unmount
  useEffect(() => {
    return () => {
      queueRef.current.forEach(item => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
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

  // Traverses input file list and registers valid images into queue
  const addFiles = useCallback((fileList) => {
    const validImageExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
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
        altText: '',
        errorMessage: null
      }));

    if (newItems.length > 0) {
      setQueue(prev => [...prev, ...newItems]);
    }
  }, []);

  const clearQueue = useCallback(() => {
    queue.forEach(item => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
    setQueue([]);
    setIsProcessing(false);
    setProcessedCount(0);
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

  const retrySingleItem = async (item) => {
    if (isProcessing) return;
    setQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'processing', errorMessage: null } : q));
    try {
      const generatedText = await generateAltTextGemini(item.file);
      setQueue(prev => prev.map(q => q.id === item.id ? {
        ...q, status: 'success', altText: generatedText, errorMessage: null
      } : q));
    } catch (err) {
      setQueue(prev => prev.map(q => q.id === item.id ? {
        ...q, status: 'error', altText: 'image description not available', errorMessage: err.message || 'Failed'
      } : q));
    }
  };

  // Step 1: Main batching loop using the exact pattern specified
  const startProcessing = async () => {
    if (queue.length === 0 || isProcessing) return;

    setIsProcessing(true);
    setProcessedCount(0);
    setCurrentProcessingIndex(1);
    setIsCooldown(false);
    setCooldownSeconds(0);
    setCooldownBatchInfo({ current: 0, total: 0 });

    setQueue(prev => prev.map(item => ({
      ...item,
      status: 'waiting',
      altText: '',
      errorMessage: null
    })));

    // Snapshot the queue items for processing
    const imageFiles = [...queueRef.current];

    // Map the requested helper functions
    const generateAltText = async (item) => {
      return await generateAltTextGemini(item.file);
    };

    const updateImageStatus = (fileNameOrId, status, altText = null, errorMessage = null) => {
      setQueue(prev => {
        let idx = prev.findIndex(q => q.id === fileNameOrId);
        if (idx === -1) idx = prev.findIndex(q => q.name === fileNameOrId && q.status !== 'success');
        if (idx === -1) idx = prev.findIndex(q => q.name === fileNameOrId);
        if (idx === -1) return prev;
        
        return prev.map((q, i) => {
          if (i === idx) {
            let mappedStatus = 'waiting';
            if (status === 'processing') mappedStatus = 'processing';
            if (status === 'done') mappedStatus = 'success';
            if (status === 'failed') mappedStatus = 'error';
            
            return {
              ...q,
              status: mappedStatus,
              altText: status === 'done' ? altText : (status === 'failed' ? 'image description not available' : q.altText),
              errorMessage: errorMessage
            };
          }
          return q;
        });
      });
      
      if (status === 'done' || status === 'failed') {
        setProcessedCount(prev => prev + 1);
      }
    };

    // --- USER LOOP START ---
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      
      // Update currently processing index for the UI state
      setCurrentProcessingIndex(i + 1);
      
      // Update status to processing using the unique ID
      updateImageStatus(file.id, 'processing');
      
      try {
        let altText = null;
        let success = false;
        
        try {
          altText = await generateAltText(file);
          success = true;
        } catch (err) {
          const isRateLimit = err.message?.toLowerCase().includes('rate limit') || err.message?.includes('429');
          if (isRateLimit) {
            // Wait 15 seconds silently and retry once
            await sleep(15000);
            try {
              altText = await generateAltText(file);
              success = true;
            } catch (retryErr) {
              throw retryErr;
            }
          } else {
            throw err;
          }
        }
        
        if (success) {
          updateImageStatus(file.id, 'done', altText);
        }
      } catch (err) {
        updateImageStatus(file.id, 'failed', null, err.message);
      }

      // Wait 4 seconds before moving to the next image
      await sleep(4000);
    }
    // --- USER LOOP END ---

    // onAllDone
    setIsProcessing(false);
    setIsCooldown(false);
    setCooldownSeconds(0);

    // Fire confetti on complete
    confetti({
      particleCount: 120,
      spread: 80,
      origin: { y: 0.6 },
      colors: ['#7C3AED', '#4F46E5', '#10B981']
    });

    setShowToast(`Successfully processed all images!`);
  };

  const handleDownloadAll = async () => {
    if (queue.length === 0 || isZipping) return;
    setIsZipping(true);

    const zip = new JSZip();
    const usedNames = new Set();

    try {
      const promises = queue.map(async (item) => {
        const zipPath = item.relativePath || item.name;

        // Split directory path and filename
        const lastSlashIndex = zipPath.lastIndexOf('/');
        const dirPath = lastSlashIndex !== -1 ? zipPath.substring(0, lastSlashIndex + 1) : '';
        const filenameWithExt = lastSlashIndex !== -1 ? zipPath.substring(lastSlashIndex + 1) : zipPath;

        // Split filename and extension
        const dotIndex = filenameWithExt.lastIndexOf('.');
        const ext = dotIndex !== -1 ? filenameWithExt.substring(dotIndex) : '';
        const nameWithoutExt = dotIndex !== -1 ? filenameWithExt.substring(0, dotIndex) : filenameWithExt;

        // Clean original filename by stripping domain and generator prefixes (e.g. steptodown.com, Gemini_Generated_Image)
        let cleanOriginalName = nameWithoutExt
          .replace(/Gemini_Generated_Image_[a-z0-9_]*/gi, '')
          .replace(/steptodown\.com\d*/gi, '');
        // Trim any leftover underscores, hyphens, or dots at ends
        cleanOriginalName = cleanOriginalName.trim().replace(/^[_.-]+|[_.-]+$/g, '');

        // Get the alt text, format it beautifully, and construct the new filename
        const altTextVal = item.altText?.trim() || 'image description not available';
        const formattedAlt = formatAltTextForFilename(altTextVal);
        
        // Final SEO name: cleanOriginalName_formattedAlt.extension or just formattedAlt.extension
        let seoFilename = cleanOriginalName
          ? `${cleanOriginalName}_${formattedAlt}${ext}`
          : `${formattedAlt}${ext}`;

        // Prevent name collisions in the ZIP folder
        let counter = 1;
        const baseNameWithoutExt = cleanOriginalName 
          ? `${cleanOriginalName}_${formattedAlt}` 
          : formattedAlt;
          
        while (usedNames.has(dirPath + seoFilename)) {
          seoFilename = `${baseNameWithoutExt}_${counter}${ext}`;
          counter++;
        }
        usedNames.add(dirPath + seoFilename);
          
        const newZipPath = dirPath + seoFilename;

        // Zip renamed image file directly, NO separate .txt file
        zip.file(newZipPath, item.file);
      });

      await Promise.all(promises);

      const zipBlob = await zip.generateAsync({ type: 'blob' });

      let zipName = 'alt_text_images.zip';
      const firstPath = queue.find(item => item.relativePath)?.relativePath;
      if (firstPath) {
        const rootFolder = firstPath.split('/')[0];
        if (rootFolder) zipName = `${rootFolder}_alt_text.zip`;
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

  const successItems = queue.filter(item => item.status === 'success');
  const progressPercent = queue.length > 0 ? Math.round((processedCount / queue.length) * 100) : 0;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Hidden Upload Inputs */}
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
                Drop folder or images here
              </p>
              <p className="text-sm text-[#888896] mt-1.5 font-sans">
                Supports JPG, PNG, WEBP — recursively traverses all subfolders
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
          {/* Left Column: Image Previews List */}
          <div className="w-[65%] h-full flex flex-col p-6 overflow-hidden bg-[#0D0D10]">
            <div className="flex items-center justify-between mb-5 shrink-0">
              <div className="flex items-center gap-2">
                <h2 className="text-xs font-bold text-white tracking-wider uppercase font-display text-glow">
                  Images List
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

            {/* Scrollable list of items */}
            <div className="space-y-2.5 pb-8 overflow-y-auto flex-1 pr-1">
              {queue.map((item) => {
                let badgeBg = 'bg-[#181822] text-[#888896] border-[#2A2A35]';
                let badgeText = 'Waiting';

                if (item.status === 'processing') {
                  badgeBg = 'bg-[#1E3A8A] text-[#93C5FD] border-[#1D4ED8]/30 animate-pulse';
                  badgeText = 'Generating...';
                } else if (item.status === 'success') {
                  badgeBg = 'bg-[#064E3B] text-[#6EE7B7] border-[#047857]/30';
                  badgeText = 'Done ✓';
                } else if (item.status === 'error') {
                  badgeBg = 'bg-[#7F1D1D] text-[#FCA5A5] border-[#B91C1C]/30';
                  badgeText = 'Failed';
                }

                return (
                  <div
                    key={item.id}
                    className="flex items-center gap-4 bg-[#18181F] border border-[#2E2E38]/50 rounded-xl p-3.5 shadow-sm transition-all duration-300 hover:border-[#3B3B48]"
                  >
                    {/* Thumbnail Container */}
                    <div className="w-12 h-12 rounded-lg bg-[#0D0D10] border border-[#2E2E38]/50 overflow-hidden shrink-0 relative">
                      <img
                        src={item.previewUrl}
                        alt={item.name}
                        className="w-full h-full object-cover select-none pointer-events-none"
                      />
                      {item.status === 'processing' && (
                        <div className="absolute inset-0 bg-[#0D0D10]/60 flex items-center justify-center">
                          <Loader2 size={16} className="text-[#7C3AED] animate-spin" />
                        </div>
                      )}
                    </div>

                    {/* File Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span
                          title={item.relativePath || item.name}
                          className="text-xs font-semibold text-white truncate block max-w-[250px] sm:max-w-[350px]"
                        >
                          {item.name}
                        </span>
                        {item.relativePath && (
                          <span className="text-[10px] text-[#888896] truncate font-mono hidden md:block">
                            in {item.relativePath.substring(0, item.relativePath.lastIndexOf('/') || 0)}
                          </span>
                        )}
                      </div>

                      <div className="mt-1 flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded text-[9px] font-semibold border shrink-0 ${badgeBg}`}>
                          {badgeText}
                        </span>
                        
                        {item.status === 'error' && (
                          <button
                            onClick={() => retrySingleItem(item)}
                            disabled={isProcessing}
                            className="px-2 py-0.5 rounded text-[9px] font-semibold border border-[#7C3AED]/30 bg-[#7C3AED]/10 text-[#7C3AED] hover:bg-[#7C3AED]/20 disabled:opacity-40 disabled:hover:bg-[#7C3AED]/10 transition-all flex items-center gap-1 shrink-0"
                          >
                            <RefreshCw size={9} />
                            Retry
                          </button>
                        )}
                        
                        {item.status === 'success' && (
                          <span className="text-xs text-[#E8E8F0] font-sans font-medium line-clamp-1 italic text-glow-subtle">
                            "{item.altText}"
                          </span>
                        )}

                        {item.status === 'error' && (
                          <span className="text-[10px] text-[#EF4444] font-sans font-medium truncate" title={item.errorMessage}>
                            {item.errorMessage}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Column: Settings & Execution Panel */}
          <div className="w-[35%] h-full border-l border-[#1C1C24] bg-[#121218] flex flex-col p-6 overflow-y-auto">
            <div className="space-y-4 flex-1">

              {/* Generate Alt Text button */}
              <button
                onClick={startProcessing}
                disabled={isProcessing || queue.length === 0}
                className="w-full py-4 rounded-xl text-white font-bold tracking-wide uppercase transition-all duration-300 transform active:scale-95 disabled:opacity-50 disabled:scale-100 disabled:cursor-not-allowed bg-gradient-to-r from-[#7C3AED] to-[#4F46E5] hover:opacity-95 shadow-xl shadow-[#7C3AED]/20 text-sm flex items-center justify-center gap-2"
              >
                {isProcessing ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Processing image {currentProcessingIndex} of {queue.length}...
                  </>
                ) : (
                  'Generate Alt Text'
                )}
              </button>

              {/* Info line below the button — always visible */}
              <p className="text-[10px] text-[#888896] text-center leading-relaxed">
                Paced Processing: 4s delay between image requests to prevent rate limits
              </p>

              {/* Progress bar during execution */}
              {(isProcessing || progressPercent > 0) && (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-[#888896]">
                    <span>
                      {isProcessing 
                        ? `Processing image ${currentProcessingIndex} of ${queue.length}...`
                        : `Progress: ${processedCount} / ${queue.length} images`
                      }
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
              )}

            </div>

            {/* Downloader Footer Button */}
            <div className="pt-6 border-t border-[#1C1C24] shrink-0 mt-6">
              <button
                onClick={handleDownloadAll}
                disabled={isProcessing || isCooldown || queue.length === 0 || isZipping}
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
                    Download ZIP
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Toast Notification */}
      {showToast && (
        <div className="fixed bottom-6 right-6 z-50 bg-[#18181F] border border-[#10B981] px-5 py-4 rounded-xl shadow-2xl flex items-center gap-3 animate-slide-in">
          <div className="bg-[#10B981]/20 text-[#10B981] p-1.5 rounded-lg">
            <Check size={18} className="stroke-[3]" />
          </div>
          <div>
            <p className="text-white font-semibold text-sm">Processing Complete</p>
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
