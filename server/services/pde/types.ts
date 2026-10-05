import type { OCRAnalysisResult, OCRExtractedTable, OCRLine, OCRMetadataObservation } from '../ocr/types.js';
import type { PageClassification } from '../preflightService.js';

export type ProcessingStrategy =
  | 'LOCAL_NATIVE'
  | 'AZURE_FULL_PAGE'
  | 'HYBRID'
  | 'LOCAL_RECHECK'
  | 'AZURE_FALLBACK';

export interface PageProcessingDecision {
  pageNumber: number;
  classification: PageClassification;
  preferredStrategy: ProcessingStrategy;
  fallbackStrategy?: ProcessingStrategy;
  requiresAzure: boolean;
  requiresLocalExtraction: boolean;
  requiresRegionAnalysis: boolean;
  requiresSecondPass: boolean;
  decisionReason: string;
  decisionVersion: string;
}

export interface DocumentProcessingPlan {
  documentId: string;
  totalPages: number;
  localPages: number;
  azurePages: number;
  hybridPages: number;
  recheckPages: number;
  estimatedAzurePages: number;
  decisionVersion: string;
  decisions: PageProcessingDecision[];
}

import type { ProcessingPageTechnicalTelemetry } from '../../types/processingPricing.js';

export interface PageExtractionResult {
  pageNumber: number;
  strategyUsed: ProcessingStrategy;
  source: 'LOCAL' | 'AZURE' | 'HYBRID' | 'AZURE_FALLBACK';
  text: string;
  confidence?: number;
  lines?: OCRLine[];
  tables: OCRExtractedTable[];
  rawMetadataObservations?: OCRMetadataObservation[];
  coordinateSystem?: {
    unit: 'point' | 'inch' | 'pixel';
    scale?: number;
  };
  telemetry?: ProcessingPageTechnicalTelemetry;
}

export interface LocalPageExtraction {
  pageNumber: number;
  rawText: string;
  charCount: number;
  blockCount: number;
  items: Array<{
    text: string;
    transform: number[];
    width: number;
    height: number;
    x: number;
    y: number;
  }>;
  lines: OCRLine[];
  tables: OCRExtractedTable[];
  structureSufficient: boolean;
  structureRequiresFallback: boolean;
  structureReason?: string;
  coordinateSystem: {
    unit: 'point';
    scale: number;
  };
}
