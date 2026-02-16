#!/bin/bash

# Test script for PDF ingestion pipeline
# Tests PDF processing with sample file

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test results
TESTS_PASSED=0
TESTS_FAILED=0

echo "=========================================="
echo "Sound Suite - Ingestion Pipeline Test"
echo "=========================================="
echo ""

# Function to print test result
print_result() {
    local test_name="$1"
    local result="$2"
    local message="$3"
    
    if [ "$result" = "PASS" ]; then
        echo -e "${GREEN}✓ PASS${NC}: $test_name"
        [ -n "$message" ] && echo "  → $message"
        ((TESTS_PASSED++))
    else
        echo -e "${RED}✗ FAIL${NC}: $test_name"
        [ -n "$message" ] && echo "  → $message"
        ((TESTS_FAILED++))
    fi
}

# Test 1: Check if database exists
echo "Test 1: Database connectivity"
if [ -f "$PROJECT_ROOT/data/sound-suite.db" ]; then
    print_result "Database exists" "PASS" "Found at data/sound-suite.db"
else
    print_result "Database exists" "FAIL" "Database not found at data/sound-suite.db"
fi
echo ""

# Test 2: Check if sample PDF directory exists
echo "Test 2: Sample PDF directory"
SAMPLE_DIR="$PROJECT_ROOT/test-data/samples"
if [ -d "$SAMPLE_DIR" ]; then
    print_result "Sample directory exists" "PASS" "Found at $SAMPLE_DIR"
else
    echo -e "${YELLOW}⚠ WARNING${NC}: Sample directory not found at $SAMPLE_DIR"
    echo "  Creating sample directory..."
    mkdir -p "$SAMPLE_DIR"
    print_result "Sample directory created" "PASS" "Created at $SAMPLE_DIR"
fi
echo ""

# Test 3: Check for sample PDF
echo "Test 3: Sample PDF file"
SAMPLE_PDF="$SAMPLE_DIR/test-document.pdf"
if [ -f "$SAMPLE_PDF" ]; then
    print_result "Sample PDF exists" "PASS" "Found at $SAMPLE_PDF"
else
    echo -e "${YELLOW}⚠ WARNING${NC}: No sample PDF found"
    echo "  Please place a test PDF at: $SAMPLE_PDF"
    print_result "Sample PDF exists" "FAIL" "No sample PDF found"
fi
echo ""

# Test 4: Test PDF text extraction (if sample exists)
if [ -f "$SAMPLE_PDF" ]; then
    echo "Test 4: PDF text extraction"
    cd "$PROJECT_ROOT"
    
    # Create a simple test script to extract text
    TEST_OUTPUT=$(node -e "
        const fs = require('fs');
        const path = require('path');
        
        async function testExtraction() {
            try {
                const { PDFParser } = require('./src/lib/ingestion/pdf-parser');
                const parser = new PDFParser();
                const result = await parser.extractText('$SAMPLE_PDF');
                
                if (result && result.length > 0) {
                    console.log('SUCCESS:' + result.length + ' pages extracted');
                } else {
                    console.log('FAIL:No pages extracted');
                }
            } catch (error) {
                console.log('ERROR:' + error.message);
            }
        }
        
        testExtraction();
    " 2>&1)
    
    if [[ "$TEST_OUTPUT" == SUCCESS:* ]]; then
        PAGE_COUNT=$(echo "$TEST_OUTPUT" | cut -d':' -f2 | cut -d' ' -f1)
        print_result "PDF text extraction" "PASS" "Extracted $PAGE_COUNT pages"
    else
        print_result "PDF text extraction" "FAIL" "$TEST_OUTPUT"
    fi
    echo ""
fi

# Test 5: Test exhibit extraction (if sample exists)
if [ -f "$SAMPLE_PDF" ]; then
    echo "Test 5: Exhibit extraction"
    cd "$PROJECT_ROOT"
    
    TEST_OUTPUT=$(node -e "
        const fs = require('fs');
        
        async function testExhibits() {
            try {
                const { PDFParser } = require('./src/lib/ingestion/pdf-parser');
                const parser = new PDFParser();
                const images = await parser.extractImages('$SAMPLE_PDF');
                
                console.log('SUCCESS:' + images.length + ' images extracted');
            } catch (error) {
                console.log('ERROR:' + error.message);
            }
        }
        
        testExhibits();
    " 2>&1)
    
    if [[ "$TEST_OUTPUT" == SUCCESS:* ]]; then
        IMAGE_COUNT=$(echo "$TEST_OUTPUT" | cut -d':' -f2 | cut -d' ' -f1)
        print_result "Exhibit extraction" "PASS" "Extracted $IMAGE_COUNT images"
    else
        print_result "Exhibit extraction" "FAIL" "$TEST_OUTPUT"
    fi
    echo ""
fi

# Test 6: Test text chunking
echo "Test 6: Text chunking"
cd "$PROJECT_ROOT"

TEST_OUTPUT=$(node -e "
    async function testChunking() {
        try {
            const { TextChunker } = require('./src/lib/ingestion/text-chunker');
            const chunker = new TextChunker({ chunkSize: 512, overlapSize: 50 });
            
            const sampleText = 'This is a test document. '.repeat(100);
            const pages = [{ pageNumber: 1, text: sampleText, textDensity: 100 }];
            const chunks = await chunker.chunkPages(pages, 'test-doc-id', 'test-case-id');
            
            if (chunks && chunks.length > 0) {
                console.log('SUCCESS:' + chunks.length + ' chunks created');
            } else {
                console.log('FAIL:No chunks created');
            }
        } catch (error) {
            console.log('ERROR:' + error.message);
        }
    }
    
    testChunking();
" 2>&1)

if [[ "$TEST_OUTPUT" == SUCCESS:* ]]; then
    CHUNK_COUNT=$(echo "$TEST_OUTPUT" | cut -d':' -f2 | cut -d' ' -f1)
    print_result "Text chunking" "PASS" "Created $CHUNK_COUNT chunks"
else
    print_result "Text chunking" "FAIL" "$TEST_OUTPUT"
fi
echo ""

# Test 7: Test embedding provider initialization
echo "Test 7: Embedding provider"
cd "$PROJECT_ROOT"

TEST_OUTPUT=$(node -e "
    async function testEmbedding() {
        try {
            const { TransformersEmbeddingProvider } = require('./src/lib/ingestion/embedding-provider');
            const provider = new TransformersEmbeddingProvider({ model: 'Xenova/all-MiniLM-L6-v2' });
            
            const dims = provider.getDimensions();
            console.log('SUCCESS:' + dims + ' dimensions');
        } catch (error) {
            console.log('ERROR:' + error.message);
        }
    }
    
    testEmbedding();
" 2>&1)

if [[ "$TEST_OUTPUT" == SUCCESS:* ]]; then
    DIMS=$(echo "$TEST_OUTPUT" | cut -d':' -f2 | cut -d' ' -f1)
    print_result "Embedding provider" "PASS" "Provider initialized with $DIMS dimensions"
else
    print_result "Embedding provider" "FAIL" "$TEST_OUTPUT"
fi
echo ""

# Summary
echo "=========================================="
echo "Test Summary"
echo "=========================================="
echo -e "Tests Passed: ${GREEN}$TESTS_PASSED${NC}"
echo -e "Tests Failed: ${RED}$TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}✗ Some tests failed${NC}"
    exit 1
fi
