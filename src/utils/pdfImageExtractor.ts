import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * Renders an uploaded PDF's page(s) into crisp PNG overview and tiled detail crops
 * so Gemini can accurately read dense 4pt AutoCAD/SHX signalling tags and title blocks.
 */
export async function renderPdfHighResCrops(base64Pdf: string): Promise<string[]> {
  const binStr = atob(base64Pdf);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }

  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  const doc = await loadingTask.promise;

  try {
    const crops: string[] = [];
    const pageCount = Math.min(2, doc.numPages);

    for (let p = 1; p <= pageCount; p++) {
      const page = await doc.getPage(p);
      const baseVp = page.getViewport({ scale: 1 });

      // 1) Overview PNG at up to 2200px wide
      const overviewScale = Math.min(3.0, Math.max(0.5, 2200 / Math.max(1, baseVp.width)));
      const overviewVp = page.getViewport({ scale: overviewScale });
      const ovCanvas = document.createElement('canvas');
      ovCanvas.width = Math.max(1, Math.floor(overviewVp.width));
      ovCanvas.height = Math.max(1, Math.floor(overviewVp.height));
      await page.render({ canvas: ovCanvas, viewport: overviewVp, background: '#ffffff' }).promise;
      crops.push(ovCanvas.toDataURL('image/png').split(',')[1]);

      // 2) For wide landscape engineering drawings, slice 3 overlapping high-DPI yard zones
      // PLUS a dedicated zoomed Title Block (bottom-right) & Header Banner (top-center) crop
      // so tiny Station Name, Station Code, and Station ID annotations are always legible.
      if (p === 1 && baseVp.width > baseVp.height * 1.15) {
        const hiResScale = Math.min(4.5, Math.max(1.5, 4800 / Math.max(1, baseVp.width)));
        const hiVp = page.getViewport({ scale: hiResScale });
        const fullW = Math.floor(hiVp.width);
        const fullH = Math.floor(hiVp.height);

        if (fullW > 1800 && fullH > 300) {
          const fullCanvas = document.createElement('canvas');
          fullCanvas.width = fullW;
          fullCanvas.height = fullH;
          await page.render({ canvas: fullCanvas, viewport: hiVp, background: '#ffffff' }).promise;

          const sliceCrop = (sx: number, sy: number, sw: number, sh: number) => {
            const tile = document.createElement('canvas');
            tile.width = Math.max(1, sw);
            tile.height = Math.max(1, sh);
            const tctx = tile.getContext('2d');
            if (tctx) {
              tctx.fillStyle = '#ffffff';
              tctx.fillRect(0, 0, tile.width, tile.height);
              tctx.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, tile.width, tile.height);
              crops.push(tile.toDataURL('image/png').split(',')[1]);
            }
          };

          // 3 horizontal yard strips (Left, Center, Right)
          const sliceWidth = Math.ceil(fullW * 0.42);
          const offsets = [0, Math.floor(fullW * 0.29), Math.max(0, fullW - sliceWidth)];
          for (const sx of offsets) {
            sliceCrop(sx, 0, sliceWidth, fullH);
          }

          // Bottom-Right Title Block crop (Station Name, Code, ID, Drg No.)
          const tbW = Math.ceil(fullW * 0.42);
          const tbH = Math.ceil(fullH * 0.36);
          sliceCrop(Math.max(0, fullW - tbW), Math.max(0, fullH - tbH), tbW, tbH);

          // Top Header Banner crop
          const hdrW = Math.ceil(fullW * 0.72);
          const hdrH = Math.ceil(fullH * 0.22);
          sliceCrop(Math.floor((fullW - hdrW) / 2), 0, hdrW, hdrH);
        }
      }
    }

    return crops;
  } finally {
    void loadingTask.destroy();
  }
}
