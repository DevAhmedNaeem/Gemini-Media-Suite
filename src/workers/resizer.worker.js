// Clean self-contained resizer Web Worker using OffscreenCanvas and createImageBitmap.
// Runs off the main UI thread to prevent UI freezing during large batch resizing operations.

self.onmessage = async function (e) {
  const {
    file,
    mode,
    width,
    height,
    maintainAspectRatio,
    percentage,
    maxDimension,
    format,
    quality
  } = e.data;

  try {
    // 1. Create an ImageBitmap from the image file/blob
    const imgBitmap = await createImageBitmap(file);

    // 2. Calculate the target dimensions based on the chosen mode
    let targetWidth = imgBitmap.width;
    let targetHeight = imgBitmap.height;

    switch (mode) {
      case 'width':
        if (width && width > 0) {
          targetWidth = width;
          targetHeight = Math.round((imgBitmap.height / imgBitmap.width) * width);
        }
        break;

      case 'height':
        if (height && height > 0) {
          targetHeight = height;
          targetWidth = Math.round((imgBitmap.width / imgBitmap.height) * height);
        }
        break;

      case 'both':
        if (width && height && width > 0 && height > 0) {
          if (maintainAspectRatio) {
            const scale = Math.min(width / imgBitmap.width, height / imgBitmap.height);
            targetWidth = Math.round(imgBitmap.width * scale);
            targetHeight = Math.round(imgBitmap.height * scale);
          } else {
            targetWidth = width;
            targetHeight = height;
          }
        }
        break;

      case 'percent':
        if (percentage && percentage > 0) {
          const factor = percentage / 100;
          targetWidth = Math.round(imgBitmap.width * factor);
          targetHeight = Math.round(imgBitmap.height * factor);
        }
        break;

      case 'max':
        if (maxDimension && maxDimension > 0) {
          if (imgBitmap.width > imgBitmap.height) {
            targetWidth = maxDimension;
            targetHeight = Math.round((imgBitmap.height / imgBitmap.width) * maxDimension);
          } else {
            targetHeight = maxDimension;
            targetWidth = Math.round((imgBitmap.width / imgBitmap.height) * maxDimension);
          }
        }
        break;

      default:
        break;
    }

    // Prevent dimensions from rounding down to zero
    targetWidth = Math.max(1, targetWidth);
    targetHeight = Math.max(1, targetHeight);

    // 3. Create OffscreenCanvas and draw the resized image bitmap
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d');

    // High quality scaling settings
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(imgBitmap, 0, 0, targetWidth, targetHeight);

    // 4. Resolve output MIME type
    let mimeType = file.type || 'image/jpeg';
    if (format && format !== 'original') {
      if (format === 'jpeg') mimeType = 'image/jpeg';
      else if (format === 'png') mimeType = 'image/png';
      else if (format === 'webp') mimeType = 'image/webp';
    }

    // 5. Convert OffscreenCanvas to Blob with quality settings
    const qualityVal = quality ? quality / 100 : 0.92;
    const resizedBlob = await canvas.convertToBlob({
      type: mimeType,
      quality: mimeType === 'image/png' ? undefined : qualityVal
    });

    // 6. Generate Data URL for UI preview using FileReaderSync inside Web Worker
    const reader = new FileReaderSync();
    const resizedDataURL = reader.readAsDataURL(resizedBlob);

    // 7. Cleanup ImageBitmap memory immediately
    imgBitmap.close();

    // 8. Post result back to main thread
    self.postMessage({
      success: true,
      resizedDataURL,
      resizedBlob,
      originalWidth: imgBitmap.width,
      originalHeight: imgBitmap.height,
      targetWidth,
      targetHeight,
      originalSize: file.size,
      resizedSize: resizedBlob.size
    });
  } catch (err) {
    self.postMessage({
      success: false,
      error: err.toString()
    });
  }
};
