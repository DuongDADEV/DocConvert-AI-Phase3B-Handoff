import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { PDFDocument, rgb } from 'pdf-lib';
import { PageRenderer } from '../../services/secondaryOcr/PageRenderer.js';
import { RegionExtractor } from '../../services/secondaryOcr/RegionExtractor.js';
import type { BoundingBox } from '../../services/secondaryOcr/types.js';

console.log('================================================================');
console.log('   PHASE 7.1 — PART F: RENDERING & REGION EXTRACTION TESTS');
console.log('================================================================\n');

export async function runRenderingAndGeometryTests() {
  const artifactDir = path.resolve('.data/test_artifacts/phase7_1_crops');
  if (!fs.existsSync(artifactDir)) {
    fs.mkdirSync(artifactDir, { recursive: true });
  }

  const renderer = new PageRenderer();
  const extractor = new RegionExtractor();
  let passedCount = 0;

  function assertTest(condition: boolean, testName: string, detail: string) {
    assert(condition, `[FAIL] ${testName}: ${detail}`);
    console.log(`✅ [PASS] ${testName}: ${detail}`);
    passedCount++;
  }

  // 1. Native PDF Rendering
  console.log('--- 1. Testing Native PDF Rendering ---');
  const pdfDoc = await PDFDocument.create();
  const page1 = pdfDoc.addPage([595, 842]); // A4
  page1.drawText('NATIVE TEST TABLE - DOC CONVERT', { x: 50, y: 800, size: 14, color: rgb(0, 0, 0) });
  page1.drawText('TXN-001 | 15/01/2026 | 1,500,000 VND', { x: 50, y: 750, size: 12, color: rgb(0, 0, 0) });
  const nativePdfBuf = Buffer.from(await pdfDoc.save());

  const t0 = performance.now();
  const renderedNative = await renderer.renderPage('doc_native', nativePdfBuf, 'application/pdf', {
    pageNumber: 1,
    dpi: 150,
  });
  const renderNativeDuration = performance.now() - t0;

  assertTest(renderedNative.width > 0 && renderedNative.height > 0, 'Native Render Size', `Width: ${renderedNative.width}px, Height: ${renderedNative.height}px`);
  assertTest(renderedNative.dpi === 150, 'Native Render DPI', 'DPI is 150');
  assertTest(renderedNative.imageBuffer.length > 1000, 'Native Render Buffer', `Buffer size: ${renderedNative.imageBuffer.length} bytes`);
  console.log(`⏱️ Native PDF render duration: ${renderNativeDuration.toFixed(1)}ms`);

  // 2. Real Scanned PDF with Rotation (Nam A Bank 270 deg)
  console.log('\n--- 2. Testing Real Scanned PDF with Rotation (Nam A Bank) ---');
  const realPdfPath = path.resolve('scratch/nam_a_fresh.pdf');
  let realPdfBuf: Buffer | null = null;
  if (fs.existsSync(realPdfPath)) {
    realPdfBuf = fs.readFileSync(realPdfPath);
  }

  if (realPdfBuf) {
    const tRot0 = performance.now();
    const renderedRealRot = await renderer.renderPage('doc_real_nam_a', realPdfBuf, 'application/pdf', {
      pageNumber: 1,
      dpi: 150,
    });
    const renderRotDuration = performance.now() - tRot0;

    assertTest(renderedRealRot.width > 0 && renderedRealRot.height > 0, 'Rotated PDF Render', `Rendered 270° scanned page (${renderedRealRot.width}x${renderedRealRot.height}px)`);
    assertTest(renderedRealRot.imageBuffer.length > 50000, 'Rotated PDF Buffer', `Buffer size: ${renderedRealRot.imageBuffer.length} bytes`);
    console.log(`⏱️ Scanned 270° PDF render duration: ${renderRotDuration.toFixed(1)}ms`);

    // Verify Multi-page Rendering & Caching
    console.log('\n--- 3. Testing Multi-page Rendering & Caching ---');
    const renderedPage2 = await renderer.renderPage('doc_real_nam_a', realPdfBuf, 'application/pdf', {
      pageNumber: 2,
      dpi: 150,
    });
    assertTest(renderedPage2.pageNumber === 2, 'Multi-page Render Page 2', 'Rendered page 2 successfully');

    // Test Caching speedup
    const tCache0 = performance.now();
    const cachedPage1 = await renderer.renderPage('doc_real_nam_a', realPdfBuf, 'application/pdf', {
      pageNumber: 1,
      dpi: 150,
    });
    const cacheDuration = performance.now() - tCache0;
    assertTest(cachedPage1 === renderedRealRot, 'PageRenderer Cache Hit', `Returned cached instance in ${cacheDuration.toFixed(2)}ms`);
  }

  // 4. Raster Image Rendering (PNG / JPG)
  console.log('\n--- 4. Testing Raster Image Rendering ---');
  const testPngPath = path.resolve('scratch/crops/case_B_tight_300dpi.png');
  if (fs.existsSync(testPngPath)) {
    const pngBuf = fs.readFileSync(testPngPath);
    const renderedPng = await renderer.renderPage('doc_png', pngBuf, 'image/png', {
      pageNumber: 1,
      dpi: 300,
    });
    assertTest(renderedPng.width > 0 && renderedPng.height > 0, 'Raster PNG Render', `Width: ${renderedPng.width}, Height: ${renderedPng.height}`);
  }

  // 5. RegionExtractor: Coordinate System Unit Conversions
  console.log('\n--- 5. Testing Bounding-Box Coordinate Conversions (point, inch, normalized, pixel) ---');
  // At 150 DPI:
  // 1 point = 150 / 72 = 2.0833 px
  // 1 inch = 150 px
  // normalized 0.5 = 0.5 * page width
  const testBboxPoint: BoundingBox = { x: 72, y: 72, width: 144, height: 36, unit: 'point' };
  const cropPoint = await extractor.extractRegion('cell_pt', renderedNative, testBboxPoint, { paddingPx: 0 });
  const expectedPxX = Math.floor(72 * (150 / 72)); // 150
  const expectedPxW = Math.ceil(144 * (150 / 72)); // 300
  assertTest(cropPoint.cropBox.x === expectedPxX, 'Point Conversion X', `x: ${cropPoint.cropBox.x} === ${expectedPxX}`);
  assertTest(cropPoint.cropBox.width === expectedPxW, 'Point Conversion Width', `width: ${cropPoint.cropBox.width} === ${expectedPxW}`);

  const testBboxInch: BoundingBox = { x: 1.0, y: 2.0, width: 2.0, height: 0.5, unit: 'inch' };
  const cropInch = await extractor.extractRegion('cell_inch', renderedNative, testBboxInch, { paddingPx: 0 });
  assertTest(cropInch.cropBox.x === 150, 'Inch Conversion X', `x: ${cropInch.cropBox.x} === 150 (1 inch * 150 DPI)`);
  assertTest(cropInch.cropBox.y === 300, 'Inch Conversion Y', `y: ${cropInch.cropBox.y} === 300 (2 inch * 150 DPI)`);
  assertTest(cropInch.cropBox.width === 300, 'Inch Conversion Width', `width: ${cropInch.cropBox.width} === 300 (2 inch * 150 DPI)`);
  assertTest(cropInch.cropBox.height === 75, 'Inch Conversion Height', `height: ${cropInch.cropBox.height} === 75 (0.5 inch * 150 DPI)`);

  const testBboxNorm: BoundingBox = { x: 0.1, y: 0.2, width: 0.4, height: 0.1, unit: 'normalized' };
  const cropNorm = await extractor.extractRegion('cell_norm', renderedNative, testBboxNorm, { paddingPx: 0 });
  const expectedNormX = Math.floor(0.1 * renderedNative.width);
  assertTest(cropNorm.cropBox.x === expectedNormX, 'Normalized Conversion X', `x: ${cropNorm.cropBox.x} === ${expectedNormX}`);

  const testBboxPixel: BoundingBox = { x: 50, y: 80, width: 120, height: 40, unit: 'pixel' };
  const cropPixel = await extractor.extractRegion('cell_px', renderedNative, testBboxPixel, { paddingPx: 0 });
  assertTest(cropPixel.cropBox.x === 50 && cropPixel.cropBox.width === 120, 'Pixel Unit Direct', 'Preserves pixel coordinates directly');

  // 6. Padding & Page Boundary Clamping
  console.log('\n--- 6. Testing Padding and Page Boundary Clamping ---');
  const edgeBbox: BoundingBox = { x: 5, y: 5, width: 50, height: 50, unit: 'pixel' };
  const cropPadded = await extractor.extractRegion('cell_pad', renderedNative, edgeBbox, { paddingPx: 10 });
  assertTest(cropPadded.cropBox.x === 0, 'Clamping Min Boundary', 'x clamped to 0 when x - pad < 0');
  assertTest(cropPadded.cropBox.y === 0, 'Clamping Min Y Boundary', 'y clamped to 0 when y - pad < 0');

  const bottomEdgeBbox: BoundingBox = {
    x: renderedNative.width - 20,
    y: renderedNative.height - 20,
    width: 30,
    height: 30,
    unit: 'pixel',
  };
  const cropBottomPadded = await extractor.extractRegion('cell_bottom', renderedNative, bottomEdgeBbox, { paddingPx: 15 });
  assertTest(
    cropBottomPadded.cropBox.x + cropBottomPadded.cropBox.width <= renderedNative.width,
    'Clamping Max Width',
    'x + width does not exceed renderedPage.width'
  );
  assertTest(
    cropBottomPadded.cropBox.y + cropBottomPadded.cropBox.height <= renderedNative.height,
    'Clamping Max Height',
    'y + height does not exceed renderedPage.height'
  );

  // 7. Preprocessing Variants & Saving Debug Crops
  console.log('\n--- 7. Testing Preprocessing Variants & Debug Crops ---');
  const targetBbox: BoundingBox = { x: 50, y: 700, width: 250, height: 60, unit: 'point' };
  const variants = ['original', 'grayscale', 'enhanced_contrast', 'binarized_otsu'] as const;

  for (const variant of variants) {
    const snippet = await extractor.extractRegion(`variant_${variant}`, renderedNative, targetBbox, {
      variant,
      paddingPx: 8,
    });
    assertTest(snippet.imageBuffer.length > 500, `Preprocessing Variant: ${variant}`, `Buffer length: ${snippet.imageBuffer.length} bytes`);

    // Save debug artifact
    const artifactPath = path.join(artifactDir, `debug_crop_${variant}.png`);
    fs.writeFileSync(artifactPath, snippet.imageBuffer);
  }
  console.log(`📁 Debug crop artifacts saved to: ${artifactDir}`);

  console.log(`\n================================================================`);
  console.log(`   RENDERING & GEOMETRY MATRIX PASSED: ${passedCount}/${passedCount}`);
  console.log(`================================================================\n`);
  return { passedCount };
}

if (process.argv[1]?.endsWith('rendering_and_geometry.test.ts')) {
  runRenderingAndGeometryTests().catch((err) => {
    console.error('Test run failed:', err);
    process.exit(1);
  });
}
