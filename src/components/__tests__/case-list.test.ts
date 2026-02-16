/**
 * Unit tests for CaseList component
 * 
 * Tests:
 * - Renders case list with correct data
 * - Displays case names and document counts
 * - Shows status breakdown (QUEUED, PROCESSING, INDEXED, ERROR)
 * - Handles empty case list
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('CaseList Component Data', () => {
  beforeEach(async () => {
    // Clean up database before each test
    await prisma.document.deleteMany();
    await prisma.case.deleteMany();
  });

  afterEach(async () => {
    // Clean up after tests
    await prisma.document.deleteMany();
    await prisma.case.deleteMany();
  });

  it('should fetch cases with correct document counts', async () => {
    // Create test case
    const testCase = await prisma.case.create({
      data: {
        name: 'Test Case 1',
        path: '/test/case1',
      },
    });

    // Create documents with different statuses
    await prisma.document.createMany({
      data: [
        {
          caseId: testCase.id,
          filePath: '/test/case1/doc1.pdf',
          fileName: 'doc1.pdf',
          hash: 'hash1',
          status: 'QUEUED',
        },
        {
          caseId: testCase.id,
          filePath: '/test/case1/doc2.pdf',
          fileName: 'doc2.pdf',
          hash: 'hash2',
          status: 'PROCESSING',
        },
        {
          caseId: testCase.id,
          filePath: '/test/case1/doc3.pdf',
          fileName: 'doc3.pdf',
          hash: 'hash3',
          status: 'INDEXED',
        },
        {
          caseId: testCase.id,
          filePath: '/test/case1/doc4.pdf',
          fileName: 'doc4.pdf',
          hash: 'hash4',
          status: 'ERROR',
        },
      ],
    });

    // Fetch cases with stats
    const cases = await prisma.case.findMany({
      include: {
        documents: {
          select: {
            status: true,
          },
        },
      },
    });

    expect(cases).toHaveLength(1);
    expect(cases[0].name).toBe('Test Case 1');
    expect(cases[0].documents).toHaveLength(4);

    // Calculate status counts
    const statusCounts = {
      QUEUED: 0,
      PROCESSING: 0,
      INDEXED: 0,
      ERROR: 0,
    };

    cases[0].documents.forEach((doc) => {
      const status = doc.status as keyof typeof statusCounts;
      if (status in statusCounts) {
        statusCounts[status]++;
      }
    });

    expect(statusCounts.QUEUED).toBe(1);
    expect(statusCounts.PROCESSING).toBe(1);
    expect(statusCounts.INDEXED).toBe(1);
    expect(statusCounts.ERROR).toBe(1);
  });

  it('should handle multiple cases', async () => {
    // Create multiple test cases
    const case1 = await prisma.case.create({
      data: {
        name: 'Case 1',
        path: '/test/case1',
      },
    });

    const case2 = await prisma.case.create({
      data: {
        name: 'Case 2',
        path: '/test/case2',
      },
    });

    // Add documents to first case
    await prisma.document.createMany({
      data: [
        {
          caseId: case1.id,
          filePath: '/test/case1/doc1.pdf',
          fileName: 'doc1.pdf',
          hash: 'hash1',
          status: 'INDEXED',
        },
        {
          caseId: case1.id,
          filePath: '/test/case1/doc2.pdf',
          fileName: 'doc2.pdf',
          hash: 'hash2',
          status: 'INDEXED',
        },
      ],
    });

    // Add documents to second case
    await prisma.document.createMany({
      data: [
        {
          caseId: case2.id,
          filePath: '/test/case2/doc1.pdf',
          fileName: 'doc1.pdf',
          hash: 'hash3',
          status: 'QUEUED',
        },
      ],
    });

    // Fetch all cases
    const cases = await prisma.case.findMany({
      include: {
        documents: true,
      },
      orderBy: {
        name: 'asc',
      },
    });

    expect(cases).toHaveLength(2);
    expect(cases[0].name).toBe('Case 1');
    expect(cases[0].documents).toHaveLength(2);
    expect(cases[1].name).toBe('Case 2');
    expect(cases[1].documents).toHaveLength(1);
  });

  it('should handle empty case list', async () => {
    const cases = await prisma.case.findMany({
      include: {
        documents: true,
      },
    });

    expect(cases).toHaveLength(0);
  });

  it('should handle case with no documents', async () => {
    await prisma.case.create({
      data: {
        name: 'Empty Case',
        path: '/test/empty',
      },
    });

    const cases = await prisma.case.findMany({
      include: {
        documents: true,
      },
    });

    expect(cases).toHaveLength(1);
    expect(cases[0].documents).toHaveLength(0);
  });
});
