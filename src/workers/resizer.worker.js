// Self-contained resizer Web Worker rewritten for target-size binary-search quality compression.
// Keeps UI fully responsive off the main thread while doing intensive canvas adjustments.

self.onmessage = async function (e) {
  const {
    file,
    width,
    height,
    targetSizeKb = 200
  } = e.data;

  try {
    // 1. Create an ImageBitmap from the image file/blob
    const imgBitmap = await createImageBitmap(file);
    const ow = imgBitmap.width;
    const oh = imgBitmap.height;

    // 2. Calculate the target dimensions
    let targetWidth = ow;
    let targetHeight = oh;

    if (width && height && width > 0 && height > 0) {
      // Both dimensions specified: scale exactly to that dimension ignoring aspect ratio
      targetWidth = width;
      targetHeight = height;
    } else if (width && width > 0) {
      // Only width specified: height scales proportionally
      targetWidth = width;
      targetHeight = Math.round((oh / ow) * width);
    } else if (height && height > 0) {
      // Only height specified: width scales proportionally
      targetHeight = height;
      targetWidth = Math.round((ow / oh) * height);
    }

    // Ensure we don't scale down to 0
    targetWidth = Math.max(1, targetWidth);
    targetHeight = Math.max(1, targetHeight);

    const tw = targetWidth;
    const th = targetHeight;

    // 3. Create OffscreenCanvas and draw the image bitmap using center-cropping (no stretching)
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d');

    if (width && height && width > 0 && height > 0) {
      // Crop to cover targetWidth x targetHeight (similar to object-fit: cover)
      const r_src = ow / oh;
      const r_target = targetWidth / targetHeight;
      let srcX = 0;
      let srcY = 0;
      let srcWidth = ow;
      let srcHeight = oh;

      if (r_src > r_target) {
        // Original is wider: crop sides
        srcWidth = oh * r_target;
        srcX = (ow - srcWidth) / 2;
      } else {
        // Original is taller: crop top/bottom
        srcHeight = ow / r_target;
        srcY = (oh - srcHeight) / 2;
      }

      ctx.drawImage(imgBitmap, srcX, srcY, srcWidth, srcHeight, 0, 0, targetWidth, targetHeight);
    } else {
      // Single dimension scale: draw full image
      ctx.drawImage(imgBitmap, 0, 0, targetWidth, targetHeight);
    }

    // Cleanup ImageBitmap memory immediately
    imgBitmap.close();

    // 4. Resolve Target Size in bytes
    const targetSizeBytes = targetSizeKb * 1024;
    const originalSizeBytes = file.size;

    let mimeType = file.type || 'image/jpeg';
    let bestBlob = null;
    let bestQuality = 1.0;

    // A flag to check if we can keep the original file untouched
    const noResizingOccurred = (tw === ow && th === oh);

    if (mimeType === 'image/png') {
      // First, try exporting as standard PNG (lossless)
      let pngBlob = await canvas.convertToBlob({ type: 'image/png' });
      
      if (pngBlob.size <= targetSizeBytes) {
        bestBlob = pngBlob;
        bestQuality = 1.0;
      } else {
        // PNG exceeds target size: fallback to WebP and compress!
        mimeType = 'image/webp';
        bestBlob = await runBinarySearchQuality(canvas, mimeType, targetSizeBytes);
      }
    } else if (mimeType === 'image/gif') {
      // GIFs cannot easily be compressed in binary search canvas quality; keep standard
      let gifBlob = await canvas.convertToBlob({ type: 'image/gif' });
      bestBlob = gifBlob;
    } else {
      // JPEG / WebP / other lossy format
      if (noResizingOccurred && originalSizeBytes <= targetSizeBytes) {
        // Keep original untouched file if already under target size and no resizing is requested
        bestBlob = file;
        bestQuality = 1.0;
      } else {
        // Run quality binary search to match the target size
        bestBlob = await runBinarySearchQuality(canvas, mimeType, targetSizeBytes);
      }
    }

    // 5. Generate Data URL for UI preview using FileReaderSync inside Web Worker
    const reader = new FileReaderSync();
    const resizedDataURL = reader.readAsDataURL(bestBlob);

    // 6. Post result back to main thread
    self.postMessage({
      success: true,
      resizedDataURL,
      resizedBlob: bestBlob,
      originalWidth: ow,
      originalHeight: oh,
      targetWidth: tw,
      targetHeight: th,
      originalSize: originalSizeBytes,
      resizedSize: bestBlob.size,
      finalMimeType: mimeType
    });

  } catch (err) {
    self.postMessage({
      success: false,
      error: err.toString()
    });
  }
};

/**
 * Binary search quality selector to hit target size limit.
 */
async function runBinarySearchQuality(canvas, mimeType, targetSizeBytes) {
  let bestBlob = null;

  // 1. Try high quality = 0.95 first
  let testBlob = await canvas.convertToBlob({ type: mimeType, quality: 0.95 });
  if (testBlob.size <= targetSizeBytes) {
    bestBlob = testBlob;
    
    // Check if 1.0 fits too
    let maxBlob = await canvas.convertToBlob({ type: mimeType, quality: 1.0 });
    if (maxBlob.size <= targetSizeBytes) {
      bestBlob = maxBlob;
    }
  } else {
    // 2. Binary search on quality in [0.05, 0.95]
    let low = 0.05;
    let high = 0.95;
    let iterations = 6;

    for (let i = 0; i < iterations; i++) {
      const mid = (low + high) / 2;
      const tempBlob = await canvas.convertToBlob({ type: mimeType, quality: mid });

      if (tempBlob.size <= targetSizeBytes) {
        bestBlob = tempBlob;
        low = mid; // Try to maximize quality while staying under target
      } else {
        high = mid; // Needs to be smaller, decrease quality
      }
    }

    // 3. Fallback: if even quality = 0.05 exceeds target size, use 0.05 as best effort
    if (!bestBlob) {
      bestBlob = await canvas.convertToBlob({ type: mimeType, quality: 0.05 });
    }
  }

  return bestBlob;
}
