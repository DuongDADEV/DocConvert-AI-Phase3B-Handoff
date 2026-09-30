import { PDFDocument } from 'pdf-lib';
import { Buffer } from 'node:buffer';

export class PagePdfExtractor {
  /**
   * Creates a new isolated PDF buffer containing ONLY the requested 1-based page numbers.
   * Maintains original page order, never mutates the original buffer.
   */
  async createSubPdf(originalPdfBuffer: Buffer, pageNumbers: number[]): Promise<Buffer> {
    if (!pageNumbers || pageNumbers.length === 0) {
      throw new Error('Không có số trang nào được chỉ định để tạo PDF con.');
    }

    const originalDoc = await PDFDocument.load(originalPdfBuffer);
    const totalPages = originalDoc.getPageCount();

    // Validate page numbers
    for (const p of pageNumbers) {
      if (p < 1 || p > totalPages) {
        throw new Error(`Số trang ${p} không hợp lệ trong tài liệu gốc (${totalPages} trang).`);
      }
    }

    const subDoc = await PDFDocument.create();
    // pdf-lib uses 0-based indices
    const zeroBasedIndices = pageNumbers.map((p) => p - 1);
    const copiedPages = await subDoc.copyPages(originalDoc, zeroBasedIndices);

    for (const page of copiedPages) {
      subDoc.addPage(page);
    }

    const savedBytes = await subDoc.save();
    return Buffer.from(savedBytes);
  }
}

export const pagePdfExtractor = new PagePdfExtractor();
