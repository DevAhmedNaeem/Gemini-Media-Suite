// Clean self-contained processor Web Worker with color neutrality filters and multi-candidate support.
// Avoids nested module paths to prevent Vite/Webpack bundle resolve failures.

self.onmessage = async function (e) {
  const { imageData, width, height, inpaintStrength = 3 } = e.data;

  try {
    const rawData = imageData.data || imageData;
    const imgData = { width, height, data: rawData };

    // 1. Run multi-fallback detection (keeps existing strict detection logic)
    const detectResult = detectWatermark(imgData);

    if (detectResult.found && detectResult.rects && detectResult.rects.length > 0) {
      // Create the OffscreenCanvas first so we can use its context for professionalInpaint
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      const finalImgData = new ImageData(rawData, width, height);
      ctx.putImageData(finalImgData, 0, 0);

      // 2. Run the professional texture-cloning inpainting for every detected watermark bounding box
      for (const rect of detectResult.rects) {
        professionalInpaint(ctx, rect.x, rect.y, rect.width, rect.height);
      }

      // 3. Convert the modified canvas content to PNG Blob
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
    // Light logo passes (Lowered confidence thresholds to 0.3 / very sensitive to catch semi-transparent overlays)
    { type: 'light', thresh: 150, strict: true },
    { type: 'light', thresh: 120, strict: true },
    { type: 'light', thresh: 90, strict: true },
    { type: 'light', thresh: 60, strict: true },
    { type: 'light', thresh: 150, strict: false },
    { type: 'light', thresh: 120, strict: false },
    { type: 'light', thresh: 90, strict: false },
    { type: 'light', thresh: 60, strict: false },
    { type: 'light', thresh: 40, strict: false },
    { type: 'light', thresh: 30, strict: false }, // Catching super faint semi-transparent overlays

    // Dark logo passes (Lowered confidence thresholds to 0.3 / very sensitive)
    { type: 'dark', thresh: 100, strict: true },
    { type: 'dark', thresh: 120, strict: true },
    { type: 'dark', thresh: 150, strict: true },
    { type: 'dark', thresh: 100, strict: false },
    { type: 'dark', thresh: 120, strict: false },
    { type: 'dark', thresh: 150, strict: false },
    { type: 'dark', thresh: 180, strict: false }, // Catching very faint dark semi-transparent overlays on light backgrounds
    { type: 'dark', thresh: 200, strict: false }
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
    const result = runDetectionPass(imageData, config.thresh, config.strict, config.type);
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
 * Executes a single detection pass with specified brightness threshold, strictness, and logo type parameters.
 */
function runDetectionPass(imageData, thresh, strict, type = 'light') {
  const { width, height, data } = imageData;
  const isLight = (type === 'light');

  // Step 1 — Pixel map with Color Neutrality Check and lowered constraints
  const brightMap = new Uint8Array(width * height);
  const maxDiff = 55; // Increased maxDiff (55) allows for highly semi-transparent/grey/blue watermarks on any background

  // Search the entire image, not just corners
  const minX = 0;
  const minY = 0;

  for (let y = minY; y < height; y++) {
    for (let x = minX; x < width; x++) {
      const i = y * width + x;
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      
      let isCandidate = false;
      if (isLight) {
        if (r > thresh && g > thresh && b > thresh) {
          if (Math.abs(r - g) < maxDiff && Math.abs(g - b) < maxDiff && Math.abs(r - b) < maxDiff) {
            isCandidate = true;
          }
        }
      } else {
        if (r < thresh && g < thresh && b < thresh) {
          if (Math.abs(r - g) < maxDiff && Math.abs(g - b) < maxDiff && Math.abs(r - b) < maxDiff) {
            isCandidate = true;
          }
        }
      }

      if (isCandidate) {
        brightMap[i] = 1;
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

          if (count > 10000) {
            isTooLarge = true;
            break;
          }

          // 4-connectivity neighbors within full bounds
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

    // FIX 3 & 5: Size limits (Minimum size 10x10, Maximum size 100x100)
    // Anything larger than 100x100 is NOT a Gemini watermark - skip it completely.
    if (w < 10 || w > 100 || h < 10 || h > 100) continue;

    // FIX 5: Safeguard: aspect ratio must not be wider than 3:1 or taller than 3:1
    const aspect = w / h;
    if (aspect < 0.33 || aspect > 3.0) continue;

    // FIX 5: Safeguard: cannot cover more than 2% of the total image area
    const area = w * h;
    const totalImageArea = width * height;
    if (area > totalImageArea * 0.02) continue;

    // FIX 5: Text protection: calculate horizontal edge density inside bounding box
    let highContrastEdges = 0;
    let totalPairsChecked = 0;
    for (let cy = y; cy < y + h; cy++) {
      for (let cx = x; cx < x + w - 1; cx++) {
        const idx1 = (cy * width + cx) * 4;
        const idx2 = (cy * width + (cx + 1)) * 4;
        const l1 = 0.299 * data[idx1] + 0.587 * data[idx1 + 1] + 0.114 * data[idx1 + 2];
        const l2 = 0.299 * data[idx2] + 0.587 * data[idx2 + 1] + 0.114 * data[idx2 + 2];
        if (Math.abs(l1 - l2) > 80) { // High contrast horizontal boundary
          highContrastEdges++;
        }
        totalPairsChecked++;
      }
    }
    const edgeDensity = highContrastEdges / (totalPairsChecked || 1);
    if (edgeDensity > 0.15) {
      // High-contrast text/numbers detected - NEVER remove this!
      continue;
    }

    // FIX 4: Corner Priority & Semi-Transparency Validation
    // Corners are within 25% margin from image bounds
    const isNearCorner = (x < width * 0.25 || x + w > width * 0.75) && (y < height * 0.25 || y + h > height * 0.75);
    
    // Calculate average intensity of the cluster
    let sumIntensity = 0;
    for (const index of cluster.indices) {
      const r = data[index * 4];
      const g = data[index * 4 + 1];
      const b = data[index * 4 + 2];
      sumIntensity += (r + g + b) / 3;
    }
    const avgIntensity = sumIntensity / cluster.pixelCount;
    const isSemiTransparent = (avgIntensity > 60 && avgIntensity < 220);

    // If NOT near a corner AND NOT semi-transparent, skip it!
    if (!isNearCorner && !isSemiTransparent) {
      continue;
    }

    // FIX 1 & 2: Strict Gemini Logo 4-pointed Star Verification with Confidence score >= 0.85
    // Gemini logo is aspect close to 1:1
    let aspectScore = 0;
    if (aspect >= 0.75 && aspect <= 1.33) {
      aspectScore = 1.0 - Math.abs(1.0 - aspect) * 3.0; // Perfect 1.0 at aspect 1:1, drops to 0.0 at 0.67 or 1.33
    }
    aspectScore = Math.max(0, aspectScore);

    // Step 4 — 3x3 Grid Density check
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

    // Center density must be highly filled (usually center contains solid or denser translucent core)
    const centerDensity = densities[1][1];
    let centerScore = Math.max(0, Math.min(1, (centerDensity - 0.2) / 0.6)); // 1.0 at 0.8+, 0.0 at 0.2-

    // Corners must be relatively empty compared to the center
    const cornersSum = densities[0][0] + densities[0][2] + densities[2][0] + densities[2][2];
    const cornersAvg = cornersSum / 4;

    // Opposing corners / arms symmetry
    const symCardinal = 1.0 - Math.max(Math.abs(densities[0][1] - densities[2][1]), Math.abs(densities[1][0] - densities[1][2]));
    const symCorners = 1.0 - Math.max(Math.abs(densities[0][0] - densities[2][2]), Math.abs(densities[0][2] - densities[2][0]));
    const symmetryScore = Math.max(0, (symCardinal + symCorners) / 2);

    // Cardinal tips average
    const cardinalSum = densities[0][1] + densities[2][1] + densities[1][0] + densities[1][2];
    const cardinalAvg = cardinalSum / 4;

    // Cardinal must dominate corners by a substantial margin (classic 4-pointed star pointed tips check)
    // For a strict Gemini logo, the ratio of cardinal density to corner density is very high (tips are extended, corners empty)
    const ratio = cardinalAvg / (cornersAvg + 0.01);
    let ratioScore = Math.max(0, Math.min(1, (ratio - 1.2) / 2.0)); // 1.0 if ratio is 3.2+, 0.0 if ratio <= 1.2

    // Let's enforce that for 0.85 confidence, we must meet these criteria perfectly
    let confidence = 0;
    
    // Only verify as a star if aspect, center, and ratio indicate a symmetric diamond star
    if (centerDensity >= 0.35 && ratio >= 2.2) {
      confidence = (aspectScore * 0.2) + (centerScore * 0.2) + (ratioScore * 0.4) + (symmetryScore * 0.2);
    }

    // Enforce high confidence threshold to >= 0.85
    if (confidence >= 0.85) {
      passedCandidates.push({
        x, y, w, h, fillRatio: pixelCount / area
      });
    }
  }

  if (passedCandidates.length === 0) {
    return { found: false };
  }

  // Format all passed candidates as padded rectangles
  const rects = passedCandidates.map(cand => {
    const pad = 2; // Tight 2px padding — minimises visible patch footprint
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

/**
 * Professional texture synthesis inpainting algorithm using weighted inverse distance averaging.
 */
function professionalInpaint(ctx, maskX, maskY, maskW, maskH) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const full = ctx.getImageData(0, 0, W, H);
  const data = full.data;

  function getPixel(x, y) {
    x = Math.max(0, Math.min(W-1, Math.round(x)));
    y = Math.max(0, Math.min(H-1, Math.round(y)));
    const i = (y * W + x) * 4;
    return [data[i], data[i+1], data[i+2]];
  }

  function setPixel(x, y, r, g, b) {
    const i = (y * W + x) * 4;
    data[i] = r; data[i+1] = g; data[i+2] = b; data[i+3] = 255;
  }

  // Fill row by row using surrounding pixel weighted average
  // Weight closer pixels much more heavily (inverse distance)
  for (let py = maskY; py < maskY + maskH; py++) {
    for (let px = maskX; px < maskX + maskW; px++) {
      
      const samples = [];
      const radius = Math.max(maskW, maskH) + 8;
      
      // Sample from a ring around the mask — skip mask pixels
      for (let sy = py - radius; sy <= py + radius; sy += 2) {
        for (let sx = px - radius; sx <= px + radius; sx += 2) {
          // Skip if inside mask region
          if (sx >= maskX && sx < maskX + maskW && 
              sy >= maskY && sy < maskY + maskH) continue;
          if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
          
          const dist = Math.sqrt((sx-px)**2 + (sy-py)**2);
          if (dist > radius) continue;
          
          const weight = 1 / (dist * dist + 0.0001);
          const [r,g,b] = getPixel(sx, sy);
          samples.push({ r, g, b, weight });
        }
      }

      if (samples.length === 0) continue;

      const totalW = samples.reduce((s, p) => s + p.weight, 0);
      const r = samples.reduce((s, p) => s + p.r * p.weight, 0) / totalW;
      const g = samples.reduce((s, p) => s + p.g * p.weight, 0) / totalW;
      const b = samples.reduce((s, p) => s + p.b * p.weight, 0) / totalW;

      setPixel(px, py, Math.round(r), Math.round(g), Math.round(b));
    }
  }

  ctx.putImageData(full, 0, 0);

  // Final feather pass — blend edges smoothly
  const pad = 3;
  const bx = Math.max(0, maskX - pad);
  const by = Math.max(0, maskY - pad);
  const bw = Math.min(W - bx, maskW + pad * 2);
  const bh = Math.min(H - by, maskH + pad * 2);

  const edgeData = ctx.getImageData(bx, by, bw, bh);
  const ed = edgeData.data;
  const tempCopy = new Uint8ClampedArray(ed);

  for (let y = 1; y < bh - 1; y++) {
    for (let x = 1; x < bw - 1; x++) {
      const isEdge = (
        x <= pad || x >= bw - pad ||
        y <= pad || y >= bh - pad
      );
      if (!isEdge) continue;
      for (let c = 0; c < 3; c++) {
        const i = (y * bw + x) * 4 + c;
        ed[i] = Math.round((
          tempCopy[i] * 2 +
          tempCopy[((y-1)*bw+x)*4+c] +
          tempCopy[((y+1)*bw+x)*4+c] +
          tempCopy[(y*bw+x-1)*4+c] +
          tempCopy[(y*bw+x+1)*4+c]
        ) / 6);
      }
    }
  }

  ctx.putImageData(edgeData, bx, by);
}
