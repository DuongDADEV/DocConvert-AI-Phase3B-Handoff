import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { PageRenderOptions, RenderedPage } from './types.js';

export class PageRenderer {
  private pageCache: Map<string, RenderedPage> = new Map();

  /**
   * Generates a cache key for a rendered page
   */
  private getCacheKey(documentId: string, pageNumber: number, dpi: number): string {
    return `${documentId}_p${pageNumber}_dpi${dpi}`;
  }

  /**
   * Clears the in-memory cache for a document or entirely
   */
  clearCache(documentId?: string): void {
    if (documentId) {
      for (const key of this.pageCache.keys()) {
        if (key.startsWith(`${documentId}_`)) {
          this.pageCache.delete(key);
        }
      }
    } else {
      this.pageCache.clear();
    }
  }

  /**
   * Renders a specific page from a PDF or image document buffer at the specified DPI.
   */
  async renderPage(
    documentId: string,
    fileBuffer: Buffer,
    mimeType: string,
    options: PageRenderOptions
  ): Promise<RenderedPage> {
    const dpi = options.dpi || 150;
    const pageNumber = options.pageNumber || 1;
    const cacheKey = this.getCacheKey(documentId, pageNumber, dpi);

    const cached = this.pageCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    if (mimeType.startsWith('image/')) {
      return await this.renderImagePage(documentId, fileBuffer, mimeType, pageNumber, dpi, cacheKey);
    }

    return await this.renderPdfPage(documentId, fileBuffer, pageNumber, dpi, cacheKey);
  }

  /**
   * Renders a page from a PDF buffer using pdfjs-dist and @napi-rs/canvas
   */
  private async renderPdfPage(
    documentId: string,
    pdfBuffer: Buffer,
    pageNumber: number,
    dpi: number,
    cacheKey: string
  ): Promise<RenderedPage> {
    const data = new Uint8Array(pdfBuffer);
    const loadingTask = (pdfjsLib as any).getDocument({
      data,
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false,
    });

    const pdfDoc = await loadingTask.promise;
    if (pageNumber < 1 || pageNumber > pdfDoc.numPages) {
      throw new Error(`Requested pageNumber ${pageNumber} out of range (1..${pdfDoc.numPages})`);
    }

    const page = await pdfDoc.getPage(pageNumber);

    // Standard PDF points are 72 DPI.
    const scale = dpi / 72.0;
    const viewport = page.getViewport({ scale });

    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Fill white background before rendering
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    await page.render({
      canvasContext: ctx,
      viewport,
    }).promise;

    const imageBuffer = canvas.toBuffer('image/png');

    const result: RenderedPage = {
      documentId,
      pageNumber,
      width,
      height,
      dpi,
      imageBuffer,
      mimeType: 'image/png',
    };

    this.pageCache.set(cacheKey, result);
    return result;
  }

  /**
   * Handles direct image documents (JPEG, PNG, etc.)
   */
  private async renderImagePage(
    documentId: string,
    imageBuffer: Buffer,
    mimeType: string,
    pageNumber: number,
    dpi: number,
    cacheKey: string
  ): Promise<RenderedPage> {
    const img = await loadImage(imageBuffer);
    const width = img.width;
    const height = img.height;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0);

    const outBuf = canvas.toBuffer('image/png');

    const result: RenderedPage = {
      documentId,
      pageNumber,
      width,
      height,
      dpi,
      imageBuffer: outBuf,
      mimeType: 'image/png',
    };

    this.pageCache.set(cacheKey, result);
    return result;
  }
}
