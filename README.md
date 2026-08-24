# Gemini Media Suite - Watermark Remover & Image Resizer

A high-performance web application containing a powerful multi-tab media suite: Gemini Watermark Remover and Bulk Image Resizer & Optimizer. Built using React 18, TailwindCSS, and JavaScript Web Workers for an all-in-one client-side image production workflow.

---

## Core Utilities

### 1. Gemini Watermark Remover
Locates and removes the Gemini 4-pointed sparkle star watermark from images:
* **Multi-Fallback Adaptive Star Detection**: Locates the sparkle star in the bottom-right corner using color neutrality filters, BFS-based connected component labeling, and shape verification.
* **High-Quality IDW Inpainting**: Fills in the bounding box using Inverse Distance Weighting interpolation from surrounding pixels, capped by an edge-box transition blur.
* **Customizable Inpaint Strength**: Control boundary blending aggressiveness to yield clean results on both plain and complex textures.

### 2. Bulk Image Resizer & Optimizer
Streamlined bulk image resizer tailored for high-speed offline size constraints:
* **Precise Dimension Sizing**: Enter target Width (px) or Height (px) for proportional scaling or exact dimension resizing.
* **Full Upscaling & Orientation Support**: Small and vertical images are resized without cropping or rotation issues.
* **Target File Size Compression**: Web Worker runs an iterative binary search over canvas export quality to fit target KB limits.
* **Directory Tree Preserving ZIP Exporter**: Supports folder uploads and generates nested ZIP archives matching original directory structures.

---

## Key Features

* **Web Worker Multi-Threading**: Offloads heavy pixel-manipulation, resizing, and binary-search algorithms to background Web Workers.
* **Bulk Folder Uploads**: Recursively traverses directory entries to load folders while preserving nested structures.
* **Privacy & Performance**: Client-side image processing in the browser using HTML5 OffscreenCanvas.
* **Bandwidth Statistics**: Tracks original vs. compressed file size and total processed items.
* **Dark UI Theme**: Modern glassmorphic interface with progress indicators and completion alerts.

---

## Technologies Used

* React 18
* Vite
* TailwindCSS 3
* HTML5 Canvas & Web Workers
* JSZip
* Lucide React
* Canvas Confetti
