/**
 * POST /api/cases/[id]/detect-filing
 *
 * Detect filing type and title from PDF filename + header text.
 * Supports single file or batch detection.
 *
 * 3-tier fallback chain:
 *   1. Redis cache → instant if background scanner already classified it
 *   2. Regex-based detection → fast, handles most common patterns
 *   3. Semantic classification → accurate, uses LanceDB embeddings
 *
 * Body: { filePath: string } or { filePaths: string[] }
 * Returns: { detection } or { detections[] }
 *   Each detection includes: { filingType, title, confidence, source }
 *   source: 'cache' | 'regex' | 'semantic'
 */

import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { detectFiling } from '@/services/filing-detector';
import { getClassifier, type ClassificationResult } from '@/services/filing-type-classifier';

/**
 * Run the 3-tier detection for a single file path.
 */
async function detectWithFallback(filePath: string): Promise<ClassificationResult> {
  const classifier = getClassifier();

  // Tier 1: Redis cache
  const cached = await classifier.getCachedDetection(filePath);
  if (cached) return cached;

  // Tier 2: Regex-based detection (fast)
  try {
    const regexResult = await detectFiling(filePath);
    if (regexResult.confidence >= 0.75) {
      // High-confidence regex match — use it and cache
      const result: ClassificationResult = {
        filingType: regexResult.filingType,
        title: regexResult.title,
        confidence: regexResult.confidence,
        source: 'regex',
      };
      // Cache in background (don't await)
      classifier.cacheDetection(filePath, result).catch(() => {});
      return result;
    }
  } catch { /* regex failed, fall through */ }

  // Tier 3: Semantic classification (accurate)
  try {
    const semanticResult = await classifier.classifyFiling(filePath);
    // Cache the result
    classifier.cacheDetection(filePath, semanticResult).catch(() => {});
    return semanticResult;
  } catch {
    // All tiers failed — fall back to regex result or defaults
    try {
      const fallback = await detectFiling(filePath);
      return { ...fallback, source: 'regex' as const };
    } catch {
      return {
        filingType: 'Other',
        title: path.basename(filePath).replace(/\.pdf$/i, '') || 'Unknown',
        confidence: 0,
        source: 'regex',
      };
    }
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Verify case exists
    const caseRecord = await prisma.case.findUnique({ where: { id } });
    if (!caseRecord) {
      return NextResponse.json({ error: 'Case not found' }, { status: 404 });
    }

    const body = await request.json();

    // Single file detection
    if (body.filePath) {
      const detection = await detectWithFallback(body.filePath);
      return NextResponse.json({ detection });
    }

    // Batch detection
    if (body.filePaths && Array.isArray(body.filePaths)) {
      const detections = await Promise.all(
        body.filePaths.map(async (fp: string) => {
          try {
            const detection = await detectWithFallback(fp);
            return { filePath: fp, ...detection };
          } catch {
            return {
              filePath: fp,
              filingType: 'Other',
              title: path.basename(fp).replace(/\.pdf$/i, '') || fp,
              confidence: 0,
              source: 'regex' as const,
            };
          }
        })
      );
      return NextResponse.json({ detections });
    }

    return NextResponse.json({ error: 'Provide filePath or filePaths' }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Detection failed' },
      { status: 500 }
    );
  }
}
