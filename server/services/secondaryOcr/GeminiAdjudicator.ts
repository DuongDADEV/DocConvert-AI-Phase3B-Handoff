import process from 'node:process';
import { GoogleGenAI } from '@google/genai';
import type { RegionSnippet, SecondaryOcrContext } from './types.js';

export interface GeminiAdjudicationResult {
  decision: 'A' | 'B' | 'UNKNOWN';
  confidence: number;
  reason: string;
}

export class GeminiAdjudicator {
  private ai: GoogleGenAI | null = null;

  constructor() {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (apiKey && !apiKey.startsWith('MY_') && !apiKey.includes('placeholder') && apiKey.length > 20) {
      this.ai = new GoogleGenAI({ apiKey });
    }
  }

  /**
   * Adjudicates between Candidate A and Candidate B using cropped snippet image and context.
   * Last-resort fallback only.
   */
  async adjudicate(
    snippet: RegionSnippet,
    candidateARaw: string,
    candidateBRaw: string,
    context: SecondaryOcrContext
  ): Promise<GeminiAdjudicationResult> {
    if (!this.ai) {
      return {
        decision: 'UNKNOWN',
        confidence: 0,
        reason: 'GEMINI_API_KEY_NOT_CONFIGURED',
      };
    }

    try {
      const base64Image = snippet.imageBuffer.toString('base64');
      const prompt = `
Bạn là chuyên gia thẩm định ký tự OCR trong bảng tính tài liệu (ngân hàng / hóa đơn / báo cáo tài chính).
Hình ảnh đính kèm là một ô dữ liệu được cắt chính xác từ bảng.
Đang có sự bất đồng trích xuất giữa hai ứng viên:
- Ứng viên A: "${candidateARaw}"
- Ứng viên B: "${candidateBRaw}"

Ngữ cảnh:
- Loại dữ liệu kỳ vọng: ${context.expectedDataType || 'Không rõ'}
- Tiêu đề cột: ${context.headerLabel || 'Không rõ'}
- Mẫu quy chuẩn kỳ vọng: ${context.expectedPattern || 'Không có'}

Nhiệm vụ:
Nhìn kỹ vào hình ảnh ô và xác định ứng viên nào phản ánh chính xác ký tự thực tế trên tài liệu.
Nếu hình ảnh mờ, bị che khuất hoặc không thể khẳng định chắc chắn 100%, hãy trả về UNKNOWN để chuyển người dùng đối soát thủ công.

Trả về duy nhất định dạng JSON:
{
  "decision": "A" | "B" | "UNKNOWN",
  "confidence": number, // từ 0.0 đến 1.0
  "reason": "Giải thích ngắn gọn lý do chọn hoặc vì sao không rõ"
}
`;

      const response = await this.ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: snippet.mimeType || 'image/png',
                  data: base64Image,
                },
              },
              {
                text: prompt,
              },
            ],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });

      const text = response.text || '';
      const parsed = JSON.parse(text);

      const decision = parsed.decision === 'A' || parsed.decision === 'B' ? parsed.decision : 'UNKNOWN';
      const confidence = typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5;

      return {
        decision,
        confidence,
        reason: parsed.reason || 'Gemini adjudication completed',
      };
    } catch (err: any) {
      console.warn('[GeminiAdjudicator] Error during adjudication:', err.message || err);
      return {
        decision: 'UNKNOWN',
        confidence: 0,
        reason: `ADJUDICATION_FAILED: ${err.message || 'Unknown error'}`,
      };
    }
  }
}
