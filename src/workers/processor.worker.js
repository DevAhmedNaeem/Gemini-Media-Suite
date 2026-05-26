// Clean self-contained processor Web Worker with color neutrality filters and multi-candidate support.
// Avoids nested module paths to prevent Vite/Webpack bundle resolve failures.

self.onmessage = async function (e) {
  const { imageData, width, height, inpaintStrength = 3 } = e.data;

  try {
    const rawData = imageData.data || imageData;
    const imgData = { width, height, data: rawData };

    // 1. Run multi-fallback detection
    const detectResult = detectWatermark(imgData);

    if (detectResult.found && detectResult.rects && detectResult.rects.length > 0) {
      // 2. Setup the OffscreenCanvas with the original image data first
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      const finalImgData = new ImageData(rawData, width, height);
      ctx.putImageData(finalImgData, 0, 0);

      // 3. Run inpainting using canvas 2D context on ALL detected watermark candidates
      for (const rect of detectResult.rects) {
        inpaintRegion(
          ctx,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          width,
          height
        );
      }

      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const reader = new FileReaderSync();
      const cleanedImageDataURL = reader.readAsDataURL(blob);

      self.postMessage({ found: true, cleanedImageDataURL });
    } else {
      self.postMessage({ found: false, cleanedImageDataURL: null });
    }
  } catch (err) {
    self.postMessage({ found: false, error: err.toString(), cleanedImageDataURL: null });
  }
};

/**
 * Robust multi-fallback 4-pointed Gemini star detection algorithm
 */
function detectWatermark(imageData) {
  const scanConfigs = [
    { thresh: 215, strict: true },
    { thresh: 180, strict: true },
    { thresh: 150, strict: true },
    { thresh: 120, strict: true },
    { thresh: 215, strict: false },
    { thresh: 180, strict: false },
    { thresh: 150, strict: false },
    { thresh: 110, strict: false }
  ];

  const allDetectedRects = [];
  const seenRects = [];

  const isDuplicate = (rx, ry, rw, rh) => {
    for (const r of seenRects) {
      const overlapX = Math.max(0, Math.min(rx + rw, r.x + r.w) - Math.max(rx, r.x));
      const overlapY = Math.max(0, Math.min(ry + rh, r.y + r.h) - Math.max(ry, r.y));
      if (overlapX > 0 && overlapY > 0) {
        const intersection = overlapX * overlapY;
        const union = (rw * rh) + (r.w * r.h) - intersection;
        if (intersection / union > 0.3) return true;
      }
    }
    return false;
  };

  for (const config of scanConfigs) {
    const result = runDetectionPass(imageData, config.thresh, config.strict);
    if (result.found && result.rects && result.rects.length > 0) {
      for (const rect of result.rects) {
        if (!isDuplicate(rect.x, rect.y, rect.width, rect.height)) {
          allDetectedRects.push(rect);
          seenRects.push({
            x: rect.x,
            y: rect.y,
            w: rect.width,
            h: rect.height
          });
        }
      }
    }
  }

  if (allDetectedRects.length > 0) {
    return {
      found: true,
      rects: allDetectedRects
    };
  }

  return { found: false };
}

/**
 * Executes a single detection pass with specified brightness threshold and strictness parameters.
 */
function runDetectionPass(imageData, thresh, strict) {
  const { width, height, data } = imageData;

  // Step 1 — Bright-pixel map with Color Neutrality Check and Bottom-Right Region Constraint
  const brightMap = new Uint8Array(width * height);
  const maxDiff = 35; // Rejects saturated colors while accepting neutral white/grey watermark

  // Limit search to the bottom-right corner to completely avoid "removing the fuck" (e.g. flowchart elements)
  const minX = Math.floor(Math.max(width * 0.75, width - 160));
  const minY = Math.floor(Math.max(height * 0.75, height - 160));

  for (let y = minY; y < height; y++) {
    for (let x = minX; x < width; x++) {
      const i = y * width + x;
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      if (r > thresh && g > thresh && b > thresh) {
        if (Math.abs(r - g) < maxDiff && Math.abs(g - b) < maxDiff && Math.abs(r - b) < maxDiff) {
          brightMap[i] = 1;
        }
      }
    }
  }

  // Step 2 — Connected component labeling (queue-based BFS flood fill)
  const visited = new Uint8Array(width * height);
  const clusters = [];

  for (let y = minY; y < height; y++) {
    for (let x = minX; x < width; x++) {
      const idx = y * width + x;
      if (brightMap[idx] && !visited[idx]) {
        let minX_c = x, maxX_c = x, minY_c = y, maxY_c = y;
        let count = 0;
        let sumX = 0, sumY = 0;

        const queue = [idx];
        visited[idx] = 1;

        let head = 0;
        let isTooLarge = false;

        while (head < queue.length) {
          const cidx = queue[head++];
          const cx = cidx % width;
          const cy = Math.floor(cidx / width);

          count++;
          sumX += cx;
          sumY += cy;

          if (cx < minX_c) minX_c = cx;
          if (cx > maxX_c) maxX_c = cx;
          if (cy < minY_c) minY_c = cy;
          if (cy > maxY_c) maxY_c = cy;

          if (count > 8000) {
            isTooLarge = true;
            break;
          }

          // 4-connectivity neighbors within the restricted bounds
          // Up
          if (cy > minY) {
            const nidx = (cy - 1) * width + cx;
            if (brightMap[nidx] && !visited[nidx]) {
              visited[nidx] = 1;
              queue.push(nidx);
            }
          }
          // Down
          if (cy < height - 1) {
            const nidx = (cy + 1) * width + cx;
            if (brightMap[nidx] && !visited[nidx]) {
              visited[nidx] = 1;
              queue.push(nidx);
            }
          }
          // Left
          if (cx > minX) {
            const nidx = cy * width + (cx - 1);
            if (brightMap[nidx] && !visited[nidx]) {
              visited[nidx] = 1;
              queue.push(nidx);
            }
          }
          // Right
          if (cx < width - 1) {
            const nidx = cy * width + (cx + 1);
            if (brightMap[nidx] && !visited[nidx]) {
              visited[nidx] = 1;
              queue.push(nidx);
            }
          }
        }

        if (!isTooLarge && count >= 4) {
          clusters.push({
            x: minX_c,
            y: minY_c,
            w: maxX_c - minX_c + 1,
            h: maxY_c - minY_c + 1,
            pixelCount: count,
            centroid: { x: sumX / count, y: sumY / count },
            indices: queue
          });
        } else {
          // If too large, mark remaining visited
          while (head < queue.length) {
            const cidx = queue[head++];
            const cx = cidx % width;
            const cy = Math.floor(cidx / width);

            if (cy > minY) {
              const nidx = (cy - 1) * width + cx;
              if (brightMap[nidx] && !visited[nidx]) { visited[nidx] = 1; queue.push(nidx); }
            }
            if (cy < height - 1) {
              const nidx = (cy + 1) * width + cx;
              if (brightMap[nidx] && !visited[nidx]) { visited[nidx] = 1; queue.push(nidx); }
            }
            if (cx > minX) {
              const nidx = cy * width + (cx - 1);
              if (brightMap[nidx] && !visited[nidx]) { visited[nidx] = 1; queue.push(nidx); }
            }
            if (cx < width - 1) {
              const nidx = cy * width + (cx + 1);
              if (brightMap[nidx] && !visited[nidx]) { visited[nidx] = 1; queue.push(nidx); }
            }
          }
        }
      }
    }
  }

  const passedCandidates = [];

  // Step 3 — Filter clusters by shape constraints
  for (const cluster of clusters) {
    const { x, y, w, h, pixelCount } = cluster;

    // Bounds check — highly relaxed to detect tiny cores of blended stars
    if (w < 4 || w > 100) continue;
    if (h < 4 || h > 100) continue;

    // Aspect ratio
    const aspect = w / h;
    if (aspect < 0.6 || aspect > 1.6) continue;

    // Fill ratio (lenient bounds to accommodate stray pixels)
    const area = w * h;
    const fillRatio = pixelCount / area;
    if (fillRatio < 0.04 || fillRatio > 0.65) continue;

    // Bounding box isolation (6px border average luminance < 220)
    const borderSize = 6;
    let sumL = 0;
    let borderCount = 0;
    const sx = Math.max(0, x - borderSize);
    const ex = Math.min(width, x + w + borderSize);
    const sy = Math.max(0, y - borderSize);
    const ey = Math.min(height, y + h + borderSize);

    for (let py = sy; py < ey; py++) {
      for (let px = sx; px < ex; px++) {
        if (px >= x && px < x + w && py >= y && py < y + h) {
          continue;
        }
        const idx = (py * width + px) * 4;
        const l = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        sumL += l;
        borderCount++;
      }
    }

    const avgLuminance = borderCount > 0 ? sumL / borderCount : 0;
    if (avgLuminance >= 220) continue;

    // Step 4 — Cross-arm shape check (3x3 grid density check)
    const x0 = 0;
    const x1 = w / 3;
    const x2 = (2 * w) / 3;
    const x3 = w;

    const y0 = 0;
    const y1 = h / 3;
    const y2 = (2 * h) / 3;
    const y3 = h;

    const cellCounts = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ];

    for (const index of cluster.indices) {
      const px = index % width;
      const py = Math.floor(index / width);
      const rx = px - x;
      const ry = py - y;

      let row = 0;
      if (ry < y1) row = 0;
      else if (ry < y2) row = 1;
      else row = 2;

      let col = 0;
      if (rx < x1) col = 0;
      else if (rx < x2) col = 1;
      else col = 2;

      cellCounts[row][col]++;
    }

    const densities = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ];

    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        let cellW = 0;
        if (c === 0) cellW = x1 - x0;
        else if (c === 1) cellW = x2 - x1;
        else cellW = x3 - x2;

        let cellH = 0;
        if (r === 0) cellH = y1 - y0;
        else if (r === 1) cellH = y2 - y1;
        else cellH = y3 - y2;

        densities[r][c] = cellCounts[r][c] / (cellW * cellH || 1);
      }
    }

    const isSmallStar = w < 12 || h < 12;

    if (isSmallStar) {
      // For very small stars, check that center has pixels and corners are relatively empty
      if (densities[1][1] < 0.20) continue;
      if (densities[0][0] > 0.25) continue;
      if (densities[0][2] > 0.25) continue;
      if (densities[2][0] > 0.25) continue;
      if (densities[2][2] > 0.25) continue;
    } else {
      // For standard stars, check center dominates, corners are dark, and cardinals dominate
      const minCenter = strict ? 0.35 : 0.20;
      const maxCorner = strict ? 0.20 : 0.30;

      if (densities[1][1] < minCenter) continue;

      if (densities[0][0] > maxCorner) continue;
      if (densities[0][2] > maxCorner) continue;
      if (densities[2][0] > maxCorner) continue;
      if (densities[2][2] > maxCorner) continue;

      // Cardinal vs Corner ratio check
      const sumCardinal = densities[0][1] + densities[2][1] + densities[1][0] + densities[1][2];
      const sumCorner = densities[0][0] + densities[0][2] + densities[2][0] + densities[2][2];
      
      const ratio = strict ? 1.5 : 1.1;
      if (sumCardinal < sumCorner * ratio) continue;
    }

    passedCandidates.push({
      x, y, w, h, fillRatio
    });
  }

  if (passedCandidates.length === 0) {
    return { found: false };
  }

  // Format all passed candidates as padded rectangles
  const rects = passedCandidates.map(cand => {
    const pad = 6;
    const outX = Math.max(0, cand.x - pad);
    const outY = Math.max(0, cand.y - pad);
    const outW = Math.min(width - outX, cand.w + pad * 2);
    const outH = Math.min(height - outY, cand.h + pad * 2);
    return {
      x: outX,
      y: outY,
      width: outW,
      height: outH
    };
  });

  return {
    found: true,
    rects
  };
}

function inpaintRegion(ctx, x, y, width, height, canvasWidth, canvasHeight) {
  // Add padding around the detected region to sample from
  const padding = 12;
  const sampleX = Math.max(0, x - padding);
  const sampleY = Math.max(0, y - padding);
  const sampleW = Math.min(canvasWidth - sampleX, width + padding * 2);
  const sampleH = Math.min(canvasHeight - sampleY, height + padding * 2);

  // Get the full sample area pixel data
  const sampleData = ctx.getImageData(sampleX, sampleY, sampleW, sampleH);
  const pixels = sampleData.data;

  // Get just the region to fill
  const regionData = ctx.getImageData(x, y, width, height);
  const regionPixels = regionData.data;

  // For every pixel inside the removal region, reconstruct it
  // by sampling ONLY from the border ring (outside the watermark box)
  // using distance-weighted average of surrounding border pixels
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let totalR = 0, totalG = 0, totalB = 0, totalWeight = 0;

      // Sample from the border ring around the entire bounding box
      // Top edge
      for (let bx = -padding; bx < width + padding; bx++) {
        for (let by = -padding; by < 0; by++) {
          const sx = px - bx;
          const sy = py - by;
          const dist = Math.sqrt(sx * sx + sy * sy);
          if (dist === 0) continue;
          const weight = 1 / (dist * dist);

          const absBx = x + bx - sampleX;
          const absBy = y + by - sampleY;
          if (absBx < 0 || absBy < 0 || absBx >= sampleW || absBy >= sampleH) continue;

          const idx = (absBy * sampleW + absBx) * 4;
          totalR += pixels[idx] * weight;
          totalG += pixels[idx + 1] * weight;
          totalB += pixels[idx + 2] * weight;
          totalWeight += weight;
        }
      }

      // Bottom edge
      for (let bx = -padding; bx < width + padding; bx++) {
        for (let by = height; by < height + padding; by++) {
          const sx = px - bx;
          const sy = py - by;
          const dist = Math.sqrt(sx * sx + sy * sy);
          if (dist === 0) continue;
          const weight = 1 / (dist * dist);

          const absBx = x + bx - sampleX;
          const absBy = y + by - sampleY;
          if (absBx < 0 || absBy < 0 || absBx >= sampleW || absBy >= sampleH) continue;

          const idx = (absBy * sampleW + absBx) * 4;
          totalR += pixels[idx] * weight;
          totalG += pixels[idx + 1] * weight;
          totalB += pixels[idx + 2] * weight;
          totalWeight += weight;
        }
      }

      // Left edge
      for (let bx = -padding; bx < 0; bx++) {
        for (let by = 0; by < height; by++) {
          const sx = px - bx;
          const sy = py - by;
          const dist = Math.sqrt(sx * sx + sy * sy);
          if (dist === 0) continue;
          const weight = 1 / (dist * dist);

          const absBx = x + bx - sampleX;
          const absBy = y + by - sampleY;
          if (absBx < 0 || absBy < 0 || absBx >= sampleW || absBy >= sampleH) continue;

          const idx = (absBy * sampleW + absBx) * 4;
          totalR += pixels[idx] * weight;
          totalG += pixels[idx + 1] * weight;
          totalB += pixels[idx + 2] * weight;
          totalWeight += weight;
        }
      }

      // Right edge
      for (let bx = width; bx < width + padding; bx++) {
        for (let by = 0; by < height; by++) {
          const sx = px - bx;
          const sy = py - by;
          const dist = Math.sqrt(sx * sx + sy * sy);
          if (dist === 0) continue;
          const weight = 1 / (dist * dist);

          const absBx = x + bx - sampleX;
          const absBy = y + by - sampleY;
          if (absBx < 0 || absBy < 0 || absBx >= sampleW || absBy >= sampleH) continue;

          const idx = (absBy * sampleW + absBx) * 4;
          totalR += pixels[idx] * weight;
          totalG += pixels[idx + 1] * weight;
          totalB += pixels[idx + 2] * weight;
          totalWeight += weight;
        }
      }

      if (totalWeight > 0) {
        const i = (py * width + px) * 4;
        regionPixels[i]     = Math.round(totalR / totalWeight);
        regionPixels[i + 1] = Math.round(totalG / totalWeight);
        regionPixels[i + 2] = Math.round(totalB / totalWeight);
        regionPixels[i + 3] = 255;
      }
    }
  }

  // Put the reconstructed region back
  ctx.putImageData(regionData, x, y);

  // Final step — apply a soft feather blur on just the filled region edges
  // This removes any hard border line between filled and original pixels
  featherEdges(ctx, x, y, width, height);
}

function featherEdges(ctx, x, y, width, height) {
  // Get a slightly expanded area
  const expand = 3;
  const ex = Math.max(0, x - expand);
  const ey = Math.max(0, y - expand);
  const ew = width + expand * 2;
  const eh = height + expand * 2;

  const edgeData = ctx.getImageData(ex, ey, ew, eh);
  const d = edgeData.data;
  const copy = new Uint8ClampedArray(d);

  // Apply a simple 3x3 box blur only on the border pixels (2px ring)
  for (let row = 1; row < eh - 1; row++) {
    for (let col = 1; col < ew - 1; col++) {
      // Only blur pixels near the edge of the filled region
      const inFillX = col >= expand && col < expand + width;
      const inFillY = row >= expand && row < expand + height;
      const nearEdgeX = col >= expand - 2 && col <= expand + width + 1;
      const nearEdgeY = row >= expand - 2 && row <= expand + height + 1;
      if (!(nearEdgeX && nearEdgeY && !(inFillX && inFillY && col > expand + 1 && col < expand + width - 2 && row > expand + 1 && row < expand + height - 2))) continue;

      let r = 0, g = 0, b = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ni = ((row + dy) * ew + (col + dx)) * 4;
          r += copy[ni];
          g += copy[ni + 1];
          b += copy[ni + 2];
        }
      }
      const i = (row * ew + col) * 4;
      d[i]     = Math.round(r / 9);
      d[i + 1] = Math.round(g / 9);
      d[i + 2] = Math.round(b / 9);
    }
  }

  ctx.putImageData(edgeData, ex, ey);
}
