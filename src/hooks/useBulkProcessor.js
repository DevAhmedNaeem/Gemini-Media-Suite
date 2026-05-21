import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Creates a new Web Worker instance using Vite's URL import convention.
 */
function createProcessorWorker() {
  return new Worker(
    new URL('../workers/processor.worker.js', import.meta.url),
    { type: 'module' }
  );
}

/**
 * Helper to load a preview URL into an HTMLImageElement asynchronously.
 */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = url;
  });
}

export function useBulkProcessor() {
  const [queue, setQueue] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [inpaintStrength, setInpaintStrength] = useState(3); // 1-10 slider, default 3
  const [showToast, setShowToast] = useState(null); // toast message

  const activeWorkersRef = useRef(new Map()); // Map of itemId -> Worker
  const queueRef = useRef(queue);
  const isProcessingRef = useRef(isProcessing);
  const inpaintStrengthRef = useRef(inpaintStrength);

  // Keep references up to date for worker processes
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  useEffect(() => {
    inpaintStrengthRef.current = inpaintStrength;
  }, [inpaintStrength]);

  // Clean up preview URLs when component unmounts
  useEffect(() => {
    return () => {
      queueRef.current.forEach(item => {
        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
        }
      });
    };
  }, []);

  const addFiles = useCallback((fileList) => {
    const newItems = Array.from(fileList)
      .filter(file => file.type.startsWith('image/'))
      .map(file => ({
        id: Math.random().toString(36).substring(2, 9),
        file,
        name: file.name,
        relativePath: file.webkitRelativePath || '',
        previewUrl: URL.createObjectURL(file),
        status: 'waiting', // waiting, scanning, removed, not_found, error
        cleanedImageDataURL: null,
        errorMessage: null
      }));

    if (newItems.length > 0) {
      setQueue(prev => [...prev, ...newItems]);
    }
  }, []);

  const clearQueue = useCallback(() => {
    // Terminate any active workers
    activeWorkersRef.current.forEach(worker => {
      worker.terminate();
    });
    activeWorkersRef.current.clear();

    // Revoke old object URLs
    queue.forEach(item => {
      if (item.previewUrl) {
        URL.revokeObjectURL(item.previewUrl);
      }
    });

    setQueue([]);
    setIsProcessing(false);
    setShowToast(null);
  }, [queue]);

  const updateItemStatus = useCallback((id, updates) => {
    setQueue(prev => prev.map(item => {
      if (item.id === id) {
        return { ...item, ...updates };
      }
      return item;
    }));
  }, []);

  const processItem = useCallback(async (item) => {
    updateItemStatus(item.id, { status: 'scanning' });

    let worker = null;
    try {
      // 1. Load image and extract ImageData
      const img = await loadImage(item.previewUrl);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // 2. Instantiate and track Web Worker
      worker = createProcessorWorker();
      activeWorkersRef.current.set(item.id, worker);

      // 3. Post to worker and wait for response
      const result = await new Promise((resolve, reject) => {
        worker.onmessage = (e) => {
          if (e.data.error) {
            reject(new Error(e.data.error));
          } else {
            resolve(e.data);
          }
        };
        worker.onerror = (err) => {
          reject(err);
        };

        worker.postMessage({
          imageData,
          width: imageData.width,
          height: imageData.height,
          inpaintStrength: inpaintStrengthRef.current
        }, [imageData.data.buffer]);
      });

      // 4. Update item status based on result
      if (result.found) {
        updateItemStatus(item.id, {
          status: 'removed',
          cleanedImageDataURL: result.cleanedImageDataURL
        });
      } else {
        updateItemStatus(item.id, {
          status: 'not_found'
        });
      }
    } catch (err) {
      console.error(`Error processing file ${item.name}:`, err);
      updateItemStatus(item.id, {
        status: 'error',
        errorMessage: err.message || 'Processing failed'
      });
    } finally {
      if (worker) {
        worker.terminate();
      }
      activeWorkersRef.current.delete(item.id);
    }
  }, [updateItemStatus]);

  // Master orchestrator loop
  useEffect(() => {
    if (!isProcessing) return;

    let isSubscribed = true;

    const orchestrate = async () => {
      const currentQueue = queueRef.current;
      const waitingItems = currentQueue.filter(item => item.status === 'waiting');
      const activeCount = activeWorkersRef.current.size;

      // If nothing is waiting and no active workers, we are completely done!
      if (waitingItems.length === 0 && activeCount === 0) {
        setIsProcessing(false);
        
        // Calculate total removed
        const removedCount = currentQueue.filter(item => item.status === 'removed').length;
        setShowToast(`Done! ${removedCount} watermark${removedCount === 1 ? '' : 's'} removed.`);
        return;
      }

      // Max 4 concurrent workers
      const maxWorkers = 4;
      const spawnCount = Math.min(maxWorkers - activeCount, waitingItems.length);

      if (spawnCount > 0 && isSubscribed) {
        const itemsToSpawn = waitingItems.slice(0, spawnCount);
        
        itemsToSpawn.forEach(item => {
          // Immediately set item to a pseudo-scanning state in ref to prevent double-spawning
          // since React state updates are batched/async
          item.status = 'scanning';

          processItem(item).then(() => {
            if (isSubscribed) {
              // Trigger next orchestrator pass
              orchestrate();
            }
          });
        });
      }
    };

    orchestrate();

    return () => {
      isSubscribed = false;
    };
  }, [isProcessing, processItem]);

  const startProcessing = useCallback(() => {
    // Reset any processed items back to waiting (except when keeping previous state)
    // For dead-simple UX: just process all that are waiting or reset and process everything
    setQueue(prev => prev.map(item => {
      if (item.status === 'removed' || item.status === 'not_found' || item.status === 'error') {
        return { ...item, status: 'waiting', cleanedImageDataURL: null, errorMessage: null };
      }
      return item;
    }));
    
    setIsProcessing(true);
    setShowToast(null);
  }, []);

  // Compute live statistics
  const stats = {
    total: queue.length,
    waiting: queue.filter(i => i.status === 'waiting').length,
    scanning: queue.filter(i => i.status === 'scanning').length,
    removed: queue.filter(i => i.status === 'removed').length,
    notFound: queue.filter(i => i.status === 'not_found').length,
    error: queue.filter(i => i.status === 'error').length,
    processed: queue.filter(i => i.status === 'removed' || i.status === 'not_found' || i.status === 'error').length
  };

  const progressPercent = stats.total > 0 ? Math.round((stats.processed / stats.total) * 100) : 0;

  return {
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
  };
}
