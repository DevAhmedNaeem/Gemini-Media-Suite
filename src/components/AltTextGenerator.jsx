import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Download, UploadCloud, FolderClosed, Check, X, Loader2, AlertCircle, RefreshCw, Copy, Wand2 } from 'lucide-react';
import JSZip from 'jszip';
import confetti from 'canvas-confetti';
import { GoogleGenerativeAI } from '@google/generative-ai';

const HARDCODED_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || '';

// System instruction balancing natural English with 2-3 elevated descriptive words
const SYSTEM_INSTRUCTION = `You are an expert web accessibility (WCAG) and SEO specialist. Your task is to generate clear, natural alternative text for images that balances everyday English with 2 to 3 descriptive, elevated vocabulary words.

STRICT RULES:
1. LENGTH: Your response MUST be EXACTLY 5 to 8 words long. No exceptions.
2. BALANCED VOCABULARY (2-3 ELEVATED WORDS): Keep the overall sentence clear, natural, and easy to read, but include 2 to 3 precise, descriptive, or elevated words (adjectives, verbs, or specific nouns) to enrich SEO and visual detail.
   - Combine natural sentence structure with 2 to 3 precise terms like "corroded", "pressurized", "calibrating", "luxury coupe", "industrial", "workstation".
   - Avoid overly dense or obscure academic jargon (like "effervescence" or "traversing emerald space").
3. NO FORBIDDEN STARTERS: Strictly FORBIDDEN from using "photo of", "image of", "picture of", "This is a photo of", or "Image showing". Begin directly with the primary subject.
4. TONE: Professional, descriptive, natural, and accessible.
5. EXAMPLES:
   - "Water leaking from a corroded metallic pipeline"
   - "Technician calibrating complex industrial engine components"
   - "Tow truck transporting a white luxury coupe"
   - "Engineer inspecting architectural blueprints at workstation"
   - "Gas valve exhibiting visible pressure leakage"`;

const MODEL_CANDIDATES = [
  'gemini-2.5-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-flash-latest'
];

// Helper to check if an error is a retryable transient server/rate issue (429, 503, 500, 504)
const isTransientError = (err) => {
  if (!err) return false;
  const status = err.status;
  const msg = (err.message || '').toLowerCase();

  return (
    status === 429 ||
    status === 503 ||
    status === 500 ||
    status === 504 ||
    status === 404 ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('500') ||
    msg.includes('504') ||
    msg.includes('quota') ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('temporarily') ||
    msg.includes('not found') ||
    msg.includes('no longer available')
  );
};

// Traverses drag & drop folder structures recursively
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

// Helper to convert File to Base64
const fileToBase64 = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const base64String = reader.result.split(',')[1];
      resolve(base64String);
    };
    reader.onerror = (error) => reject(error);
  });
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Clean and sanitize alt text output according to strict rules
const cleanAndValidateAltText = (rawText) => {
  if (!rawText) return '';
  let cleaned = rawText.trim();

  // Strip surrounding quotes
  cleaned = cleaned.replace(/^["'`]|["'`]$/g, '').trim();

  // Remove forbidden starter phrases (case insensitive)
  const forbiddenStarters = [
    /^(this is a photo of|this is an image of|this is a picture of)\s+/i,
    /^(a photo of|an image of|a picture of|photo of|image of|picture of)\s+/i,
    /^(image showing|photo showing|picture showing|showing)\s+/i,
    /^(a photograph of|photograph of)\s+/i,
    /^(a photo showing|an image showing)\s+/i
  ];

  for (const regex of forbiddenStarters) {
    cleaned = cleaned.replace(regex, '');
  }

  // Capitalize first letter
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  // Remove trailing period if present
  cleaned = cleaned.replace(/\.$/, '');

  return cleaned.trim();
};

const getWordCount = (text) => {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
};

// Helper: Convert generated alt text into a clean filesystem-safe filename
const getCleanedFilename = (altText, originalName) => {
  if (!altText || !altText.trim()) return originalName;

  let cleaned = altText
    .trim()
    .replace(/[\/\\:\*\?"<>\|]/g, '')
    .replace(/\s+/g, ' ');

  const lastDot = originalName.lastIndexOf('.');
  const ext = lastDot !== -1 ? originalName.substring(lastDot) : '';

  if (!cleaned) return originalName;
  return `${cleaned}${ext}`;
};

// Helper: Build target path inside ZIP archive with alt text as the new image filename
const getZipPath = (item) => {
  const newName = getCleanedFilename(item.altText, item.name);
  if (item.relativePath) {
    const parts = item.relativePath.split('/');
    if (parts.length > 1) {
      parts[parts.length - 1] = newName;
      return parts.join('/');
    }
  }
  return newName;
};

export default function AltTextGenerator() {
  const [queue, setQueue] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showToast, setShowToast] = useState(null);

  // Statistics & Counter
  const [processedCount, setProcessedCount] = useState(0);
  const [copiedId, setCopiedId] = useState(null);
  const [downloadedCount, setDownloadedCount] = useState(0);

  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const queueRef = useRef(queue);
  const isProcessingRef = useRef(isProcessing);
  const cancelRequestedRef = useRef(false);

  // Sync state refs
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  // Clean up Object URLs on unmount
  useEffect(() => {
    return () => {
      queueRef.current.forEach(item => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      });
    };
  }, []);

  // Download counter persistence
  useEffect(() => {
    setDownloadedCount(parseInt(localStorage.getItem('gemini_total_downloaded') || '0', 10));
    const handleStorage = () => {
      setDownloadedCount(parseInt(localStorage.getItem('gemini_total_downloaded') || '0', 10));
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const addDownloadedCount = (count) => {
    const current = parseInt(localStorage.getItem('gemini_total_downloaded') || '0', 10);
    localStorage.setItem('gemini_total_downloaded', current + count);
    window.dispatchEvent(new Event('storage'));
  };

  // Toast dismiss timer
  useEffect(() => {
    if (showToast) {
      const timer = setTimeout(() => setShowToast(null), 6000);
      return () => clearTimeout(timer);
    }
  }, [showToast]);

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
    cancelRequestedRef.current = true;
    queue.forEach(item => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
    setQueue([]);
    setIsProcessing(false);
    setProcessedCount(0);
    cancelRequestedRef.current = false;
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

  // Generate content using Gemini SDK with model candidates fallback & automatic retry loop on 503/429/transient errors
  const generateWithSdkFallback = async (genAI, base64Image, mimeType, promptText, onTransientPause) => {
    const maxGlobalRetries = 6;

    for (let retryLoop = 0; retryLoop < maxGlobalRetries; retryLoop++) {
      if (cancelRequestedRef.current) throw new Error('Processing cancelled by user');

      let lastError = null;

      // Try each model candidate in order
      for (const modelName of MODEL_CANDIDATES) {
        try {
          const model = genAI.getGenerativeModel({
            model: modelName,
            systemInstruction: SYSTEM_INSTRUCTION
          });

          const result = await model.generateContent([
            {
              inlineData: {
                data: base64Image,
                mimeType: mimeType
              }
            },
            promptText
          ]);

          const response = await result.response;
          return response.text() || '';

        } catch (err) {
          lastError = err;
          const errMsg = err.message || '';

          // If key revoked or 403 Forbidden, throw permanently
          if (err.status === 403 || errMsg.includes('leaked') || errMsg.includes('Forbidden')) {
            throw new Error('API Key Leaked / Revoked: Google disabled this API key because it was detected in a public repository.');
          }

          // If transient error (503 High Demand / 429 Rate Limit / 500 / 404), try next model candidate immediately
          if (isTransientError(err)) {
            console.warn(`Model ${modelName} encountered transient error (${err.status || err.message}), trying next candidate...`);
            continue;
          }

          throw err;
        }
      }

      // If ALL model candidates hit a transient error (e.g. 503 high demand or 429 rate limit across all models):
      if (isTransientError(lastError) && retryLoop < maxGlobalRetries - 1) {
        let waitSeconds = 5 * (retryLoop + 1); // 5s, 10s, 15s, 20s exponential backoff
        const match = lastError?.message?.match(/retry in (\d+(?:\.\d+)?)s/i);
        if (match && match[1]) {
          waitSeconds = Math.min(Math.ceil(parseFloat(match[1])), 30);
        }

        const reason = lastError?.status === 503 || lastError?.message?.includes('503') || lastError?.message?.includes('high demand')
          ? 'Google Server High Demand (503)'
          : 'Rate Limited (429)';

        if (onTransientPause) onTransientPause(reason, waitSeconds);
        console.warn(`${reason}. Pausing ${waitSeconds}s before retrying...`);
        await sleep(waitSeconds * 1000);
        continue;
      }

      throw lastError || new Error('No supported Gemini model candidate was available.');
    }
  };

  // Perform single image alt text generation using hardcoded key
  const processImage = async (item) => {
    if (cancelRequestedRef.current) return false;

    setQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'processing', errorMessage: null } : q));

    try {
      const base64Image = await fileToBase64(item.file);
      const mimeType = item.file.type || 'image/jpeg';
      const effectiveKey = import.meta.env.VITE_GEMINI_API_KEY || HARDCODED_API_KEY;

      let generatedRawText = '';

      const onTransientPause = (reason, sec) => {
        setQueue(prev => prev.map(q => q.id === item.id ? {
          ...q,
          status: 'processing',
          errorMessage: `${reason}: Retrying in ${sec}s...`
        } : q));
      };

      if (effectiveKey) {
        const genAI = new GoogleGenerativeAI(effectiveKey);

        for (let attempt = 1; attempt <= 3; attempt++) {
          if (cancelRequestedRef.current) return false;

          let promptText = 'Describe this image in clear English using 2 to 3 elevated descriptive words adhering to your system instruction. Write EXACTLY 5 to 8 words.';
          if (attempt > 1) {
            promptText = `Previous response was not 5-8 words. Write an alt text description of this image in clear English with 2-3 elevated words that is STRICTLY between 5 and 8 words long. Do not use 'photo of' or 'image of'.`;
          }

          const raw = await generateWithSdkFallback(genAI, base64Image, mimeType, promptText, onTransientPause);
          const cleaned = cleanAndValidateAltText(raw);
          const count = getWordCount(cleaned);

          generatedRawText = cleaned;
          if (count >= 5 && count <= 8) break;
          if (attempt < 3) await sleep(1000);
        }

      } else {
        const response = await fetch('/api/generate-alt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            base64Image,
            mimeType,
            prompt: 'Generate clear WCAG alt text with 2-3 elevated descriptive words. Output MUST be exactly 5 to 8 words long.'
          })
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${response.status}: Failed to generate alt text`);
        }

        const data = await response.json();
        generatedRawText = cleanAndValidateAltText(data.altText);
      }

      let finalAltText = cleanAndValidateAltText(generatedRawText);
      const words = finalAltText.split(/\s+/).filter(w => w.length > 0);
      if (words.length > 8) {
        finalAltText = words.slice(0, 8).join(' ');
      }

      setQueue(prev => prev.map(q => q.id === item.id ? {
        ...q,
        status: 'success',
        altText: finalAltText,
        errorMessage: null
      } : q));

      setProcessedCount(prev => prev + 1);
      return true;

    } catch (err) {
      console.error(`Error generating alt text for ${item.name}:`, err);
      let userMsg = err.message || 'Generation failed';

      if (userMsg.includes('leaked') || userMsg.includes('Leaked') || userMsg.includes('Forbidden')) {
        userMsg = 'API Key Leaked / Revoked: Google deactivated this API key.';
      }

      setQueue(prev => prev.map(q => q.id === item.id ? {
        ...q,
        status: 'error',
        errorMessage: userMsg
      } : q));
      setProcessedCount(prev => prev + 1);
      return false;
    }
  };

  // Main orchestrator loop - processes 1 item sequentially with a gentle 1.5s delay
  const startProcessing = async () => {
    if (queue.length === 0 || isProcessing) return;

    setIsProcessing(true);
    setProcessedCount(0);
    cancelRequestedRef.current = false;

    const listToProcess = queue.map(item => ({
      ...item,
      status: 'waiting',
      errorMessage: null
    }));

    setQueue(listToProcess);

    return new Promise(async (resolve) => {
      for (let i = 0; i < listToProcess.length; i++) {
        if (cancelRequestedRef.current) {
          setIsProcessing(false);
          resolve(false);
          return;
        }

        const item = listToProcess[i];
        await processImage(item);

        if (i < listToProcess.length - 1 && !cancelRequestedRef.current) {
          await sleep(1500);
        }
      }

      setIsProcessing(false);
      if (!cancelRequestedRef.current) {
        const hasErrors = queueRef.current.some(q => q.status === 'error');
        if (!hasErrors) {
          confetti({
            particleCount: 120,
            spread: 80,
            origin: { y: 0.6 },
            colors: ['#7C3AED', '#4F46E5', '#10B981']
          });
          setShowToast('Successfully generated alt text for all images!');
        } else {
          setShowToast('Processing finished! Transient server spikes were automatically retried.');
        }
      }
      resolve(true);
    });
  };

  const stopProcessing = () => {
    cancelRequestedRef.current = true;
    setIsProcessing(false);
  };

  const handleAltTextChange = (id, newText) => {
    setQueue(prev => prev.map(q => q.id === id ? { ...q, altText: newText } : q));
  };

  // Copy single alt text
  const copyToClipboard = (id, text) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Copy all alt texts formatted
  const copyAllToClipboard = () => {
    const successTexts = queue
      .filter(item => item.altText)
      .map(item => `${item.name}: "${item.altText}"`)
      .join('\n');

    if (!successTexts) return;
    navigator.clipboard.writeText(successTexts);
    setShowToast('Copied all alt texts to clipboard!');
  };

  // ZIP export - renames images using generated Alt Text and DOES NOT include alt_texts.txt
  const handleDownloadAllZip = async () => {
    if (queue.length === 0 || isZipping) return;
    setIsZipping(true);

    const zip = new JSZip();

    try {
      const promises = queue.map(async (item) => {
        let zipPath = getZipPath(item);

        let finalPath = zipPath;
        let counter = 1;

        const lastDot = finalPath.lastIndexOf('.');
        const basePath = lastDot !== -1 ? finalPath.substring(0, lastDot) : finalPath;
        const ext = lastDot !== -1 ? finalPath.substring(lastDot) : '';

        while (zip.file(finalPath)) {
          counter++;
          finalPath = `${basePath} (${counter})${ext}`;
        }

        zip.file(finalPath, item.file);
      });

      await Promise.all(promises);

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;

      let zipName = 'alt_text_images.zip';
      const firstPath = queue.find(item => item.relativePath)?.relativePath;
      if (firstPath) {
        const rootFolder = firstPath.split('/')[0];
        if (rootFolder) zipName = `${rootFolder}_alt_text.zip`;
      }

      link.download = zipName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      addDownloadedCount(queue.length);
    } catch (err) {
      console.error('Failed to create ZIP package:', err);
    } finally {
      setIsZipping(false);
    }
  };

  const progressPercent = queue.length > 0 ? Math.round((processedCount / queue.length) * 100) : 0;
  const successItems = queue.filter(item => item.status === 'success');

  return (
    <div className="flex-1 flex overflow-hidden">
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
        <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-8 bg-[#0D0D10] overflow-y-auto">
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={handleSelectFiles}
            className={`w-full max-w-2xl min-h-[280px] sm:min-h-[340px] sm:aspect-[16/10] flex flex-col items-center justify-center gap-5 sm:gap-6 cursor-pointer p-6 sm:p-8 premium-transition premium-dropzone ${
              isDragging ? 'premium-dropzone-dragging' : ''
            }`}
          >
            <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-[#181822] border border-[#2E2E38] flex items-center justify-center shadow-md shrink-0">
              <UploadCloud className="w-7 h-7 sm:w-8 sm:h-8 premium-dropzone-icon transition-colors" />
            </div>

            <div className="text-center px-2">
              <p className="text-base sm:text-lg font-semibold premium-dropzone-text">
                Drop folder or images to generate Alt Text
              </p>
              <p className="text-xs sm:text-sm text-[#888896] mt-1 sm:mt-1.5 font-sans">
                Generates 5 to 8 word WCAG & SEO accessible alt tags
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2.5 sm:gap-3 w-full sm:w-auto" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={handleSelectFiles}
                className="premium-secondary-button text-xs font-semibold px-4 sm:px-5 py-2.5 rounded-xl transition-all w-full sm:w-auto text-center"
              >
                Choose Images
              </button>
              <button
                onClick={handleSelectFolder}
                className="premium-secondary-button text-xs font-semibold px-4 sm:px-5 py-2.5 rounded-xl flex items-center justify-center gap-1.5 transition-all w-full sm:w-auto text-center"
              >
                <FolderClosed size={14} className="text-[#888896]" />
                Select Folder
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Workspace Active State */
        <div className="flex-1 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
          {/* Left Column: Image Queue */}
          <div className="w-full lg:flex-1 h-auto lg:h-full flex flex-col p-4 sm:p-6 overflow-y-auto bg-[#0D0D10] order-2 lg:order-1">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4 sm:mb-5 shrink-0">
              <div className="flex items-center gap-2">
                <h2 className="text-xs font-bold text-white tracking-wider uppercase font-display text-glow">
                  Alt Text Queue
                </h2>
                <span className="bg-[#181822] border border-[#2E2E38] px-2.5 py-0.5 rounded-full text-xs font-mono text-[#888896]">
                  {queue.length} files (Downloaded: {downloadedCount})
                </span>
              </div>

              <div className="flex items-center gap-3">
                {successItems.length > 0 && (
                  <button
                    onClick={copyAllToClipboard}
                    className="text-xs text-[#7C3AED] hover:text-[#93C5FD] flex items-center gap-1 transition-colors font-semibold"
                  >
                    <Copy size={12} />
                    <span>Copy All</span>
                  </button>
                )}
                <button
                  onClick={clearQueue}
                  disabled={isProcessing}
                  className="text-xs text-[#888896] hover:text-white disabled:opacity-40 flex items-center gap-1 transition-colors"
                >
                  <RefreshCw size={12} className={isProcessing ? 'animate-spin' : ''} />
                  <span>Clear All</span>
                </button>
              </div>
            </div>

            {/* List Layout */}
            <div className="space-y-3 pb-8">
              {queue.map((item) => {
                let badgeBg = 'bg-[#181822] text-[#888896] border-[#2A2A35]';
                let badgeText = 'Waiting';

                if (item.status === 'processing') {
                  badgeBg = 'bg-[#1E3A8A] text-[#93C5FD] border-[#1D4ED8]/30';
                  badgeText = 'Analyzing...';
                } else if (item.status === 'success') {
                  badgeBg = 'bg-[#064E3B] text-[#6EE7B7] border-[#047857]/30';
                  badgeText = 'Success ✓';
                } else if (item.status === 'error') {
                  badgeBg = 'bg-[#7F1D1D] text-[#FCA5A5] border-[#B91C1C]/30';
                  badgeText = 'Error';
                }

                let folderName = '';
                if (item.relativePath) {
                  const parts = item.relativePath.split('/');
                  if (parts.length > 1) {
                    folderName = parts.slice(0, -1).join(' / ');
                  }
                }

                const wordCount = getWordCount(item.altText);

                return (
                  <div
                    key={item.id}
                    className="flex flex-col bg-[#18181F] border border-[#2E2E38]/50 hover:border-[#3B3B48] rounded-xl overflow-hidden shadow-md transition-all duration-300 p-3 sm:p-3.5 gap-2.5 relative"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
                      {/* Thumbnail & File Details on mobile */}
                      <div className="flex items-center gap-3 sm:block">
                        <div className="w-14 h-14 sm:w-16 sm:h-16 bg-[#0D0D10] rounded-lg overflow-hidden shrink-0 relative">
                          <img
                            src={item.previewUrl}
                            alt={item.name}
                            className="w-full h-full object-cover select-none pointer-events-none"
                          />
                          {item.status === 'processing' && (
                            <div className="absolute inset-0 bg-[#0D0D10]/70 flex items-center justify-center">
                              <Loader2 className="w-5 h-5 text-[#7C3AED] animate-spin" />
                            </div>
                          )}
                        </div>

                        {/* Filename & Badges visible on mobile next to thumbnail */}
                        <div className="min-w-0 flex-1 sm:hidden space-y-1">
                          <span title={item.name} className="text-xs font-semibold text-white truncate block">
                            {item.name}
                          </span>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono border ${badgeBg}`}>
                              {badgeText}
                            </span>
                            {item.altText && (
                              <span className="text-[9px] font-mono text-[#888896] bg-[#121218] px-1.5 py-0.5 rounded border border-[#2A2A35]">
                                {wordCount} words
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Metadata & Alt Text Input for desktop / full width */}
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="hidden sm:flex items-center justify-between gap-2">
                          <div className="min-w-0 flex items-center gap-2">
                            <span title={item.name} className="text-xs font-semibold text-white truncate block">
                              {item.name}
                            </span>
                            {folderName && (
                              <span className="text-[10px] text-[#888896] font-mono flex items-center gap-1">
                                <FolderClosed size={10} />
                                {folderName}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            {item.altText && (
                              <span className="text-[10px] font-mono text-[#888896] bg-[#121218] px-1.5 py-0.5 rounded border border-[#2A2A35]">
                                {wordCount} words
                              </span>
                            )}
                            <span className={`px-2 py-0.5 rounded text-[9px] font-mono border ${badgeBg}`}>
                              {badgeText}
                            </span>
                          </div>
                        </div>

                        {/* Editable Alt Text & Copy Button */}
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={item.altText}
                            placeholder={
                              item.status === 'waiting'
                                ? 'Waiting to generate alt text...'
                                : item.status === 'processing'
                                ? 'Generating alt text...'
                                : 'No alt text generated.'
                            }
                            onChange={(e) => handleAltTextChange(item.id, e.target.value)}
                            disabled={item.status === 'processing'}
                            className="flex-1 min-w-0 bg-[#09090d] border border-[#2E2E38] rounded px-3 py-1.5 text-xs text-[#E8E8F0] focus:border-[#7C3AED] focus:outline-none"
                          />
                          <button
                            onClick={() => copyToClipboard(item.id, item.altText)}
                            disabled={!item.altText}
                            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-[#E8E8F0] bg-[#22222E] hover:bg-[#2E2E38] disabled:opacity-40 disabled:hover:bg-[#22222E] rounded transition-colors shrink-0"
                            title="Copy Alt Text"
                          >
                            {copiedId === item.id ? (
                              <>
                                <Check size={13} className="text-[#10B981]" />
                                <span className="text-[#10B981]">Copied</span>
                              </>
                            ) : (
                              <>
                                <Copy size={13} />
                                <span>Copy</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Detailed Error / Transient Spike Banner */}
                    {item.errorMessage && (
                      <div className={`rounded-lg p-2.5 flex items-start justify-between gap-3 text-xs ${
                        item.errorMessage.includes('Retrying') || item.errorMessage.includes('Pausing')
                          ? 'bg-[#1E3A8A]/40 border border-[#1D4ED8]/50 text-[#93C5FD]'
                          : 'bg-[#7F1D1D]/30 border border-[#B91C1C]/50 text-[#FCA5A5]'
                      }`}>
                        <div className="flex items-start gap-2 min-w-0">
                          {item.errorMessage.includes('Retrying') || item.errorMessage.includes('Pausing') ? (
                            <Loader2 size={14} className="text-[#60A5FA] shrink-0 mt-0.5 animate-spin" />
                          ) : (
                            <AlertCircle size={14} className="text-[#EF4444] shrink-0 mt-0.5" />
                          )}
                          <span className="leading-snug text-[11px] sm:text-xs">{item.errorMessage}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Column: Control Panel */}
          <div className="w-full lg:w-[360px] xl:w-[400px] shrink-0 border-t lg:border-t-0 lg:border-l border-[#1C1C24] bg-[#121218] flex flex-col p-4 sm:p-6 overflow-y-auto order-1 lg:order-2">
            <div className="space-y-5 sm:space-y-6 flex-1">

              {/* Action Buttons */}
              <div className="space-y-2">
                {!isProcessing ? (
                  <button
                    onClick={startProcessing}
                    disabled={queue.length === 0}
                    className="w-full py-3.5 sm:py-4 rounded-xl text-white text-xs sm:text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:scale-100 disabled:cursor-not-allowed premium-button"
                  >
                    <Wand2 size={16} />
                    Generate Alt Texts
                  </button>
                ) : (
                  <button
                    onClick={stopProcessing}
                    className="w-full py-3.5 sm:py-4 rounded-xl text-white text-xs sm:text-sm flex items-center justify-center gap-2 bg-[#EF4444]/90 border border-[#EF4444]/30 hover:bg-[#EF4444] transition-all font-semibold uppercase tracking-wider"
                  >
                    <Loader2 size={16} className="animate-spin" />
                    Stop Processing
                  </button>
                )}
              </div>

              {/* Progress bar */}
              {isProcessing && (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-[#888896]">
                    <span>Processing: {processedCount} / {queue.length} images</span>
                    <span className="text-white">{progressPercent}%</span>
                  </div>
                  <div className="h-2 w-full bg-[#18181F] border border-[#2E2E38] rounded-full overflow-hidden">
                    <div
                      style={{ width: `${progressPercent}%` }}
                      className="h-full premium-progress-bar transition-all duration-300 relative overflow-hidden"
                    />
                  </div>
                </div>
              )}

              {/* Download Option: Only ZIP Download button */}
              {successItems.length > 0 && !isProcessing && (
                <div className="bg-[#18181F] border border-[#2E2E38] rounded-xl p-4 space-y-3">
                  <div className="text-xs font-semibold text-white flex items-center gap-2">
                    <Download size={14} className="text-[#7C3AED]" />
                    <span>Download Images</span>
                  </div>

                  <div>
                    <button
                      onClick={handleDownloadAllZip}
                      disabled={isZipping}
                      className="w-full py-3.5 rounded-xl font-semibold bg-gradient-to-r from-[#7C3AED] to-[#4F46E5] hover:opacity-95 text-white flex items-center justify-center gap-2 transition-all shadow-md shadow-[#7C3AED]/20 text-xs sm:text-sm"
                    >
                      {isZipping ? (
                        <>
                          <Loader2 size={15} className="animate-spin" />
                          Creating ZIP Archive...
                        </>
                      ) : (
                        <>
                          <Download size={15} />
                          Download All (ZIP)
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>
      )}

      {/* FLOATING TOAST NOTIFICATION */}
      {showToast && (
        <div className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-6 sm:bottom-6 sm:max-w-md z-50 bg-[#18181F] border border-[#10B981] px-4 py-3 sm:px-5 sm:py-4 rounded-xl shadow-2xl flex items-center justify-between gap-3 animate-slide-in">
          <div className="flex items-center gap-3 min-w-0">
            <div className="bg-[#10B981]/20 text-[#10B981] p-1.5 rounded-lg shrink-0">
              <Check size={18} className="stroke-[3]" />
            </div>
            <div className="min-w-0">
              <p className="text-white font-semibold text-xs sm:text-sm">Alt Text Generator</p>
              <p className="text-[#888896] text-[11px] sm:text-xs mt-0.5 truncate">{showToast}</p>
            </div>
          </div>
          <button
            onClick={() => setShowToast(null)}
            className="text-[#888896] hover:text-[#E8E8F0] p-1 shrink-0"
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
