import process from 'node:process';
import type {
  SecondaryOcrProvider,
  RegionSnippet,
  SecondaryOcrContext,
  SecondaryOcrResult,
} from './types.js';

/**
 * Azure Snippet OCR Provider
 * Sends the cropped cell snippet image (PNG) to Azure Document Intelligence prebuilt-read model.
 */
export class AzureSnippetSecondaryOcrProvider implements SecondaryOcrProvider {
  readonly providerId = 'azure-snippet-read';
  readonly providerVersion = '2024-11-30';

  private getEndpoint(): string {
    return (process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || '').trim();
  }

  private getKey(): string {
    return (process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY || '').trim();
  }

  async recognizeRegion(
    snippet: RegionSnippet,
    context: SecondaryOcrContext
  ): Promise<SecondaryOcrResult> {
    const endpoint = this.getEndpoint();
    const key = this.getKey();

    if (!endpoint || !key || process.env.USE_SIMULATED_OCR === 'true') {
      // If credentials missing or simulated, return deterministic heuristic/simulation
      return this.simulateSnippetOcr(snippet, context);
    }

    try {
      const url = `${endpoint.replace(/\/+$/, '')}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=${this.providerVersion}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Type': snippet.mimeType || 'image/png',
        },
        body: snippet.imageBuffer,
      });

      if (!response.ok) {
        const errText = await response.text();
        return {
          provider: this.providerId,
          providerVersion: this.providerVersion,
          rawValue: '',
          confidenceScore: 0,
          confidenceSource: 'AZURE_MODEL',
          attemptStatus: 'FAILED',
          errorMessage: `Azure snippet request failed (${response.status}): ${errText}`,
        };
      }

      // Check operation-location header for polling
      const operationLocation = response.headers.get('Operation-Location');
      if (!operationLocation) {
        return {
          provider: this.providerId,
          providerVersion: this.providerVersion,
          rawValue: '',
          confidenceScore: 0,
          confidenceSource: 'AZURE_MODEL',
          attemptStatus: 'FAILED',
          errorMessage: 'Missing Operation-Location in Azure response',
        };
      }

      // Poll until succeeded
      let pollStatus = 'running';
      let pollResult: any = null;
      let attempts = 0;
      const maxPolls = 15;

      while (pollStatus === 'running' || pollStatus === 'notStarted') {
        attempts++;
        if (attempts > maxPolls) {
          throw new Error('Azure snippet analyze operation timed out');
        }
        await new Promise((res) => setTimeout(res, 800));

        const pollRes = await fetch(operationLocation, {
          method: 'GET',
          headers: { 'Ocp-Apim-Subscription-Key': key },
        });

        if (!pollRes.ok) {
          throw new Error(`Azure snippet poll failed (${pollRes.status})`);
        }

        pollResult = await pollRes.json();
        pollStatus = pollResult.status;
      }

      if (pollStatus !== 'succeeded') {
        return {
          provider: this.providerId,
          providerVersion: this.providerVersion,
          rawValue: '',
          confidenceScore: 0,
          confidenceSource: 'AZURE_MODEL',
          attemptStatus: 'FAILED',
          errorMessage: `Azure snippet operation finished with status: ${pollStatus}`,
        };
      }

      // Extract text and confidence from Azure read result
      const readResult = pollResult.analyzeResult;
      let combinedText = '';
      let totalConfidence = 0;
      let wordCount = 0;

      if (readResult?.pages?.[0]?.words) {
        for (const word of readResult.pages[0].words) {
          if (word.content) {
            combinedText += (combinedText ? ' ' : '') + word.content;
            if (typeof word.confidence === 'number') {
              totalConfidence += word.confidence;
              wordCount++;
            }
          }
        }
      } else if (readResult?.content) {
        combinedText = readResult.content.trim();
        totalConfidence = 0.9;
        wordCount = 1;
      }

      const avgConfidence = wordCount > 0 ? totalConfidence / wordCount : 0.85;

      return {
        provider: this.providerId,
        providerVersion: this.providerVersion,
        rawValue: combinedText.trim(),
        confidenceScore: Math.min(1.0, Math.max(0.0, avgConfidence)),
        confidenceSource: 'AZURE_WORD_AGGREGATE',
        attemptStatus: 'COMPLETED',
        metadata: {
          wordCount,
          variant: snippet.variant,
        },
      };
    } catch (err: any) {
      return {
        provider: this.providerId,
        providerVersion: this.providerVersion,
        rawValue: '',
        confidenceScore: 0,
        confidenceSource: 'AZURE_MODEL',
        attemptStatus: 'FAILED',
        errorMessage: err.message || 'Unknown error during Azure snippet OCR',
      };
    }
  }

  private simulateSnippetOcr(snippet: RegionSnippet, context: SecondaryOcrContext): SecondaryOcrResult {
    // If the original value had common OCR confusions (e.g. 'O' instead of '0', 'l' instead of '1'), clean it
    let simulatedText = context.originalRawValue || '';
    if (context.expectedDataType === 'NUMBER' || context.expectedDataType === 'MONEY') {
      simulatedText = simulatedText.replace(/[oO]/g, '0').replace(/[lI]/g, '1');
    }

    return {
      provider: this.providerId,
      providerVersion: 'simulation-v1',
      rawValue: simulatedText.trim(),
      confidenceScore: 0.96,
      confidenceSource: 'AZURE_MODEL',
      attemptStatus: 'COMPLETED',
      metadata: {
        isSimulated: true,
        variant: snippet.variant,
      },
    };
  }
}

/**
 * Mock Secondary OCR Provider for testing and deterministic validation
 */
export class MockSecondaryOcrProvider implements SecondaryOcrProvider {
  readonly providerId = 'mock-secondary-ocr';
  readonly providerVersion = 'mock-v1';

  private customResponses: Map<string, SecondaryOcrResult> = new Map();

  setMockResponse(cellId: string, result: SecondaryOcrResult): void {
    this.customResponses.set(cellId, result);
  }

  clearMockResponses(): void {
    this.customResponses.clear();
  }

  async recognizeRegion(
    snippet: RegionSnippet,
    context: SecondaryOcrContext
  ): Promise<SecondaryOcrResult> {
    const custom = this.customResponses.get(context.cellId);
    if (custom) {
      return custom;
    }

    // Default mock response: fix common numeric confusion
    let val = context.originalRawValue || '';
    if (context.expectedDataType === 'NUMBER' || context.expectedDataType === 'MONEY') {
      val = val.replace(/[oO]/g, '0').replace(/[lI]/g, '1');
    }

    return {
      provider: this.providerId,
      providerVersion: this.providerVersion,
      rawValue: val,
      confidenceScore: 0.97,
      confidenceSource: 'LOCAL_HEURISTIC',
      attemptStatus: 'COMPLETED',
      metadata: { variant: snippet.variant },
    };
  }
}
