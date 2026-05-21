# ✨ Gemini Watermark Remover

This is a premium, high-performance **Gemini Watermark Remover** built using **React, TailwindCSS, and JavaScript (Web Workers)**. It provides instant, completely local, in-browser detection and removal of the Gemini 4-pointed sparkle star watermark from images, with advanced support for multi-threaded bulk folder uploads and ZIP archiving.

---

## 🚀 Features

* **⚡ Web Worker Multi-Threading**: Offloads heavy pixel-manipulation, detection, and inpainting algorithms to background Web Workers, keeping the React UI running smoothly at 60fps.
* **📂 Bulk Folder & Drag-and-Drop Traversal**: Drop individual images or whole folders. Recursively traverses directory entries to load folders while preserving their subfolder structure.
* **🔍 Multi-Fallback Adaptive Star Detection**: Locates the 4-pointed sparkle star in the bottom-right corner using color neutrality filters, BFS-based connected component labeling (flood fill), average border luminance checks, and 3x3 cardinal density shape verification.
* **🎨 High-Quality IDW Inpainting**: Fills in the watermark bounding box using Inverse Distance Weighting (IDW) interpolation from surrounding pixels, followed by a customizable edge box-blur transition.
* **🎚️ Customizable Inpaint Strength**: Allows the user to control the boundary blending intensity to achieve flawless results on both complex and flat backgrounds.
* **📦 One-Click ZIP Downloader**: Generates and packages processed images back into their original format and subfolder structures using JSZip.
* **🔒 100% Offline & Private**: No images are uploaded to any server. All processing runs purely client-side in your web browser.
* **🎉 Premium UI & Confetti**: Features a modern dark-mode glassmorphic interface, micro-animations, real-time batch statistics, and canvas-confetti celebrations upon successful cleanup.

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

## 📷 Preview

*A sleek, modern dark-mode dashboard displaying real-time processing queues, bulk upload areas, and interactive inpainting controls.*

![Dashboard Preview](https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=1200&q=80)

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
   npm run dev
   ```

4. Open [http://localhost:3001](http://localhost:3001) (or the port specified in your console) in your web browser.
