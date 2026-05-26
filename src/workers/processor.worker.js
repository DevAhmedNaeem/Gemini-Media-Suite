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
      // 2. Run inpainting directly on raw ImageData (no canvas needed yet)
      for (const rect of detectResult.rects) {
        inpaintRegion(imgData, rect.x, rect.y, rect.width, rect.height);
      }

      // 3. Convert the modified ImageData to PNG Blob via OffscreenCanvas
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      const finalImgData = new ImageData(rawData, width, height);
      ctx.putImageData(finalImgData, 0, 0);

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
 * Horizon Gradient Inpainting — bilinear interpolation from real per-row/column
 * edge neighbors. Perfectly reconstructs gradients, skin tones, and flat fills.
 * Operates directly on raw ImageData (no canvas ctx needed).
 */
function inpaintRegion(imageData, x, y, w, h) {
  const { data, width, height } = imageData;

  // Clamp-read a pixel from the full canvas
  function getPixel(px, py) {
    if (px < 0) px = 0;
    if (py < 0) py = 0;
    if (px >= width)  px = width  - 1;
    if (py >= height) py = height - 1;
    const i = (py * width + px) * 4;
    return [data[i], data[i+1], data[i+2], data[i+3]];
  }

  // Write a pixel back into the full canvas
  function setPixel(px, py, r, g, b, a) {
    const i = (py * width + px) * 4;
    data[i]   = r;
    data[i+1] = g;
    data[i+2] = b;
    data[i+3] = a;
  }

  // Step 1: Fill every pixel with bilinear gradient interpolation.
  // For each pixel we read the REAL neighbors just outside the box on all 4 sides
  // at that exact row/column — giving accurate per-row and per-column colors.
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      // Normalised position inside the box (0 = left/top edge, 1 = right/bottom edge)
      const tx = (px - x) / Math.max(w - 1, 1);
      const ty = (py - y) / Math.max(h - 1, 1);

      // Real pixels just outside each edge at this exact row / column
      const leftPx  = getPixel(x - 1,     py);
      const rightPx = getPixel(x + w,     py);
      const topPx   = getPixel(px,     y - 1);
      const botPx   = getPixel(px,     y + h);

      // Horizontal interpolation (left → right along this row)
      const hR = leftPx[0] + (rightPx[0] - leftPx[0]) * tx;
      const hG = leftPx[1] + (rightPx[1] - leftPx[1]) * tx;
      const hB = leftPx[2] + (rightPx[2] - leftPx[2]) * tx;

      // Vertical interpolation (top → bottom along this column)
      const vR = topPx[0] + (botPx[0] - topPx[0]) * ty;
      const vG = topPx[1] + (botPx[1] - topPx[1]) * ty;
      const vB = topPx[2] + (botPx[2] - topPx[2]) * ty;

      // Blend horizontal and vertical 50/50
      setPixel(px, py,
        Math.round((hR + vR) / 2),
        Math.round((hG + vG) / 2),
        Math.round((hB + vB) / 2),
        255
      );
    }
  }

  // Step 2: 3-pass box blur on the edge ring only (approximates Gaussian).
  // Interior pixels keep their smooth gradient; only the seam is softened.
  const blurPad = 2;
  const bx  = Math.max(0, x - blurPad);
  const by2 = Math.max(0, y - blurPad);
  const bw  = Math.min(width  - bx,  w + blurPad * 2);
  const bh  = Math.min(height - by2, h + blurPad * 2);

  for (let pass = 0; pass < 3; pass++) {
    // Snapshot current state so blur reads from the previous pass
    const snap = new Uint8ClampedArray(data);

    function snapPixel(px, py) {
      if (px < 0) px = 0;
      if (py < 0) py = 0;
      if (px >= width)  px = width  - 1;
      if (py >= height) py = height - 1;
      const i = (py * width + px) * 4;
      return [snap[i], snap[i+1], snap[i+2]];
    }

    for (let py = by2 + 1; py < by2 + bh - 1; py++) {
      for (let px = bx + 1; px < bx + bw - 1; px++) {
        // Only touch the edge ring — leave the gradient interior intact
        const nearEdge = (
          px <= x + 2 || px >= x + w - 3 ||
          py <= y + 2 || py >= y + h - 3
        );
        if (!nearEdge) continue;

        let r = 0, g = 0, b = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const p = snapPixel(px + dx, py + dy);
            r += p[0]; g += p[1]; b += p[2];
          }
        }
        setPixel(px, py, Math.round(r / 9), Math.round(g / 9), Math.round(b / 9), 255);
      }
    }
  }

  return imageData;
}
