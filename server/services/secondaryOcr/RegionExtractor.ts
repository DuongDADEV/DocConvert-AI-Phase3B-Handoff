import { createCanvas, loadImage } from '@napi-rs/canvas';
import type {
  BoundingBox,
  RenderedPage,
  RegionExtractOptions,
  RegionSnippet,
  PreprocessingVariant,
} from './types.js';

export class RegionExtractor {
  /**
   * Extracts a cropped region snippet for a cell bounding box from a rendered page image.
   */
  async extractRegion(
    cellId: string,
    renderedPage: RenderedPage,
    boundingBox: BoundingBox,
    options?: RegionExtractOptions
  ): Promise<RegionSnippet> {
    const padding = options?.paddingPx ?? 6;
    const variant: PreprocessingVariant = options?.variant ?? 'original';

    // 1. Calculate pixel coordinates on the rendered page
    const cropBox = this.resolveCropBox(renderedPage, boundingBox, padding);

    // 2. Load the rendered page image onto a canvas
    const img = await loadImage(renderedPage.imageBuffer);

    // 3. Create target canvas for snippet
    const snippetCanvas = createCanvas(cropBox.width, cropBox.height);
    const ctx = snippetCanvas.getContext('2d');

    // Fill white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cropBox.width, cropBox.height);

    // Draw the sub-rectangle
    ctx.drawImage(
      img,
      cropBox.x,
      cropBox.y,
      cropBox.width,
      cropBox.height,
      0,
      0,
      cropBox.width,
      cropBox.height
    );

    // 4. Apply preprocessing variant if requested
    if (variant !== 'original') {
      this.applyPreprocessing(snippetCanvas, variant);
    }

    const snippetBuffer = snippetCanvas.toBuffer('image/png');

    return {
      cellId,
      pageNumber: renderedPage.pageNumber,
      boundingBox,
      cropBox,
      variant,
      imageBuffer: snippetBuffer,
      mimeType: 'image/png',
    };
  }

  /**
   * Resolves bounding box units and applies padding and boundary clamping.
   */
  private resolveCropBox(
    renderedPage: RenderedPage,
    boundingBox: BoundingBox,
    padding: number
  ): { x: number; y: number; width: number; height: number } {
    let rawX = boundingBox.x || 0;
    let rawY = boundingBox.y || 0;
    let rawW = boundingBox.width || 0;
    let rawH = boundingBox.height || 0;

    const unit = boundingBox.unit || 'point';

    let pixelX: number;
    let pixelY: number;
    let pixelW: number;
    let pixelH: number;

    if (unit === 'point') {
      // 1 point = 1/72 inch.
      const scale = renderedPage.dpi / 72.0;
      pixelX = rawX * scale;
      pixelY = rawY * scale;
      pixelW = rawW * scale;
      pixelH = rawH * scale;
    } else if (unit === 'inch') {
      pixelX = rawX * renderedPage.dpi;
      pixelY = rawY * renderedPage.dpi;
      pixelW = rawW * renderedPage.dpi;
      pixelH = rawH * renderedPage.dpi;
    } else if (unit === 'normalized') {
      pixelX = rawX * renderedPage.width;
      pixelY = rawY * renderedPage.height;
      pixelW = rawW * renderedPage.width;
      pixelH = rawH * renderedPage.height;
    } else {
      // 'pixel': assumes base coordinate space
      pixelX = rawX;
      pixelY = rawY;
      pixelW = rawW;
      pixelH = rawH;
    }

    // Apply padding
    const xWithPad = Math.max(0, Math.floor(pixelX - padding));
    const yWithPad = Math.max(0, Math.floor(pixelY - padding));
    const wWithPad = Math.ceil(pixelW + padding * 2);
    const hWithPad = Math.ceil(pixelH + padding * 2);

    // Clamp within page boundaries
    const clampedW = Math.max(1, Math.min(wWithPad, renderedPage.width - xWithPad));
    const clampedH = Math.max(1, Math.min(hWithPad, renderedPage.height - yWithPad));

    return {
      x: xWithPad,
      y: yWithPad,
      width: clampedW,
      height: clampedH,
    };
  }

  /**
   * Applies image preprocessing filter (contrast, binarization, grayscale)
   */
  private applyPreprocessing(canvas: any, variant: PreprocessingVariant): void {
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const len = data.length;

    if (variant === 'grayscale') {
      for (let i = 0; i < len; i += 4) {
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        data[i] = gray;
        data[i + 1] = gray;
        data[i + 2] = gray;
      }
    } else if (variant === 'enhanced_contrast') {
      // Find min and max luminance for contrast stretching
      let minLum = 255;
      let maxLum = 0;
      for (let i = 0; i < len; i += 4) {
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
      }

      const diff = maxLum - minLum || 1;
      for (let i = 0; i < len; i += 4) {
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        const stretched = Math.min(255, Math.max(0, ((gray - minLum) / diff) * 255));
        data[i] = stretched;
        data[i + 1] = stretched;
        data[i + 2] = stretched;
      }
    } else if (variant === 'binarized_otsu') {
      // Otsu's thresholding algorithm
      const histogram = new Array(256).fill(0);
      const totalPixels = canvas.width * canvas.height;

      for (let i = 0; i < len; i += 4) {
        const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        histogram[gray]++;
      }

      let sum = 0;
      for (let t = 0; t < 256; t++) sum += t * histogram[t];

      let sumB = 0;
      let wB = 0;
      let wF = 0;
      let varMax = 0;
      let threshold = 128;

      for (let t = 0; t < 256; t++) {
        wB += histogram[t];
        if (wB === 0) continue;
        wF = totalPixels - wB;
        if (wF === 0) break;

        sumB += t * histogram[t];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;

        const varBetween = wB * wF * (mB - mF) * (mB - mF);
        if (varBetween > varMax) {
          varMax = varBetween;
          threshold = t;
        }
      }

      for (let i = 0; i < len; i += 4) {
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        const binary = gray < threshold ? 0 : 255;
        data[i] = binary;
        data[i + 1] = binary;
        data[i + 2] = binary;
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }
}
