# ✨ Gemini Media Suite — Watermark Remover, Resizer & Bulk AI Alt Text Generator

This is a premium, high-performance web application containing a powerful multi-tab media suite: **Gemini Watermark Remover**, **Bulk Image Resizer & Optimizer**, and **Bulk AI Alt Text Generator & Renamer**. Built purely offline and utilizing high-performance client-side techniques such as **React 18, TailwindCSS, and JavaScript Web Workers**, it executes intensive image processes directly inside the browser, safeguarding 100% data privacy with zero server uploads.

---

## 📸 Core Utilities

### 1. 🌟 Gemini Watermark Remover
Locates and removes the Gemini 4-pointed sparkle star watermark from images:
* **🔍 Multi-Fallback Adaptive Star Detection**: Locates the sparkle star in the bottom-right corner using color neutrality filters, BFS-based connected component labeling (flood fill), and shape verification.
* **🎨 High-Quality IDW Inpainting**: Fills in the bounding box using Inverse Distance Weighting (IDW) interpolation from surrounding pixels, capped by an edge-box transition blur.
* **🎚️ Customizable Inpaint Strength**: Control boundary blending aggressiveness to yield perfect results on both plain and complex textures.

### 2. 📏 Bulk Image Resizer & Optimizer
A streamlined, premium bulk image resizer tailored for high-speed offline size constraints:
* **📐 Intuitive Proportion Sizing**: Enter a target **Width (px)**, **Height (px)**, or both. If only one input is provided, the other scales proportionally. If both are defined, the engine fits the image within those boundaries preserving the aspect ratio.
* **🛡️ No Upscaling Guarantee**: Caps calculated dimensions at the original bounds to prevent upscaling smaller images, protecting image fidelity.
* **🎯 Target File Size Compression (Binary Search)**: Enter a target limit in KB (e.g. `200 KB`). The Web Worker runs an iterative **binary search** over the canvas export quality parameter `[0.05, 0.95]` to achieve the maximum visual clarity that fits under your size constraint.
* **🔄 Lossless PNG WebP Fallback**: If a transparent PNG exceeds the target size, the engine automatically converts it to high-density lossy WebP to apply quality compression and hit your size limit.
* **📂 Directory Tree Preserving ZIP Exporter**: Supports recursively dropping folders and subfolders. Generates a nested ZIP archive matching your exact input directory structure, and automatically updates fallback extensions (e.g. `.png` to `.webp`) to keep system compatibility.

### 3. 🏷️ Bulk AI Alt Text Generator & Renamer
An intelligent bulk alt text generator powered by Google Gemini to instantly create SEO-optimized image descriptions:
* **⚡ High-Capacity Lite Model**: Leverages `gemini-flash-lite-latest` (Gemini 3.1 Flash Lite) to offer massive free tier limits (up to 1,500 daily requests) instead of extremely restrictive standard model quotas.
* **⏱️ Proactive Cooldown Pacing**: Implements a precise sliding-window manager that automatically pauses for 62 seconds after every 14 images to safely stay below Gemini's 15 Requests-Per-Minute (RPM) limit. Includes a real-time visual countdown timer.
* **🛡️ Smart Retry Logic**: Gracefully recovers from temporary network drops or rate limit hits, auto-waiting and resuming exactly from where the processing loop paused.
* **📁 Directory Tree SEO Exporter**: Recursively processes folders, generates precise 5-6 word alt descriptions, and renames images to the clean, SEO-optimized alt text (e.g. `original_file_name_seo_description.jpg`). Exports the entire matching nested directory tree directly to a ZIP package without server uploads.

---

## 🚀 Key Features

* **⚡ Web Worker Multi-Threading**: Offloads heavy pixel-manipulation, resizing, and binary-search algorithms to background Web Workers, keeping the React UI running smoothly at 60fps.
* **📂 Bulk Folder Uploads**: Drop files or entire folders. Recursively traverses directory entries to load folders while preserving their nested structure.
* **🔒 100% Offline & Private**: All resizing and editing run client-side in the browser using HTML5 OffscreenCanvas. No files are ever sent to an external server.
* **📊 Compression Statistics**: Displays original total size vs. compressed total size, and calculates exact bandwidth saved.
* **🎉 Premium UI & Confetti**: Features a modern dark-mode glassmorphic interface, micro-animations, progress indicators, and canvas-confetti completion celebrations.

---

## 🛠️ Technologies Used

* **React 18** (Core UI framework)
* **Vite** (Next-gen frontend build tool)
* **TailwindCSS 3** (Utility-first styling framework)
* **HTML5 Canvas & Web Workers** (Offline multi-threaded image processing)
* **JSZip** (Client-side ZIP compression)
* **Lucide React** (Clean modern iconography)
* **Canvas Confetti** (Completion celebration)

---

## ⚡ Getting Started

### Prerequisites

Make sure you have **Node.js** (v18 or higher) installed on your system.

### Installation & Run

1. **Clone the repository**:
   ```bash
   git clone https://github.com/DevAhmedNaeem/Watermark-Remover-Image-Resizer-.git
   cd Watermark-Remover-Image-Resizer-
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the local development server**:
   ```bash
   npm.cmd run dev
   ```

4. Open [http://localhost:3001](http://localhost:3001) in your browser.
