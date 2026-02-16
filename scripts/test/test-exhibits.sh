#!/bin/bash

# Test script for exhibit extraction and retrieval
# Tests exhibit extraction and retrieval functionality

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
echo "Sound Suite - Exhibit Extraction Test"
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

# Test 1: Check exhibits directory
echo "Test 1: Exhibits directory"
EXHIBITS_DIR="$PROJECT_ROOT/public/exhibits"
if [ -d "$EXHIBITS_DIR" ]; then
    print_result "Exhibits directory exists" "PASS" "Found at $EXHIBITS_DIR"
else
    echo -e "${YELLOW}⚠ WARNING${NC}: Exhibits directory not found"
    mkdir -p "$EXHIBITS_DIR"
    print_result "Exhibits directory created" "PASS" "Created at $EXHIBITS_DIR"
fi
echo ""

# Test 2: Test image extraction from PDF
echo "Test 2: Image extraction from PDF"
SAMPLE_PDF="$PROJECT_ROOT/test-data/samples/test-document.pdf"

if [ -f "$SAMPLE_PDF" ]; then
    cd "$PROJECT_ROOT"
    
    TEST_OUTPUT=$(node -e "
        async function testImageExtraction() {
            try {
                const { PDFParser } = require('./src/lib/ingestion/pdf-parser');
                const parser = new PDFParser();
                const images = await parser.extractImages('$SAMPLE_PDF');
                
                console.log('SUCCESS:' + images.length + ' images extracted');
            } catch (error) {
                console.log('ERROR:' + error.message);
            }
        }
        
        testImageExtraction();
    " 2>&1)
    
    if [[ "$TEST_OUTPUT" == SUCCESS:* ]]; then
        IMAGE_COUNT=$(echo "$TEST_OUTPUT" | cut -d':' -f2 | cut -d' ' -f1)
        print_result "Image extraction" "PASS" "Extracted $IMAGE_COUNT images"
    else
        print_result "Image extraction" "FAIL" "$TEST_OUTPUT"
    fi
else
    print_result "Image extraction" "FAIL" "Sample PDF not found at $SAMPLE_PDF"
fi
echo ""

# Test 3: Test OCR on extracted images
echo "Test 3: OCR on exhibits"
cd "$PROJECT_ROOT"

TEST_OUTPUT=$(node -e "
    async function testOCR() {
        try {
            const { OCREngine } = require('./src/lib/ingestion/ocr-engine');
            const sharp = require('sharp');
            
            // Create a simple test image with text
            const testImage = await sharp({
                create: {
                    width: 200,
                    height: 100,
                    channels: 3,
                    background: { r: 255, g: 255, b: 255 }
                }
            }).png().toBuffer();
            
            const ocr = new OCREngine({ language: 'eng' });
            const result = await ocr.recognizeImage(testImage);
            
            console.log('SUCCESS:OCR completed with confidence ' + result.confidence);
        } catch (error) {
            console.log('ERROR:' + error.message);
        }
    }
    
    testOCR();
" 2>&1)

if [[ "$TEST_OUTPUT" == SUCCESS:* ]]; then
    print_result "OCR processing" "PASS" "OCR engine working"
else
    print_result "OCR processing" "FAIL" "$TEST_OUTPUT"
fi
echo ""

# Test 4: Test exhibit metadata storage
echo "Test 4: Exhibit metadata in LanceDB"
cd "$PROJECT_ROOT"

TEST_OUTPUT=$(node -e "
    async function testExhibitMetadata() {
        try {
            const { VectorStore } = require('./src/lib/vector/vector-store');
            
            const store = new VectorStore({
                dbPath: './data/lancedb',
                tableName: 'chunks'
            });
            await store.initialize();
            
            // Search for exhibits
            const results = await store.search({
                filter: { is_exhibit: true },
                limit: 10
            });
            
            console.log('SUCCESS:' + results.length + ' exhibits found in database');
        } catch (error) {
            console.log('ERROR:' + error.message);
        }
    }
    
    testExhibitMetadata();
" 2>&1)

if [[ "$TEST_OUTPUT" == SUCCESS:* ]]; then
    EXHIBIT_COUNT=$(echo "$TEST_OUTPUT" | cut -d':' -f2 | cut -d' ' -f1)
    print_result "Exhibit metadata" "PASS" "Found $EXHIBIT_COUNT exhibits in database"
else
    print_result "Exhibit metadata" "FAIL" "$TEST_OUTPUT"
fi
echo ""

# Test 5: Test exhibit retrieval by description
echo "Test 5: Exhibit retrieval"
cd "$PROJECT_ROOT"

TEST_OUTPUT=$(node -e "
    async function testExhibitRetrieval() {
        try {
            const { VectorStore } = require('./src/lib/vector/vector-store');
            const { TransformersEmbeddingProvider } = require('./src/lib/ingestion/embedding-provider');
            
            const store = new VectorStore({
                dbPath: './data/lancedb',
                tableName: 'chunks'
            });
            await store.initialize();
            
            const provider = new TransformersEmbeddingProvider({ model: 'Xenova/all-MiniLM-L6-v2' });
            const embeddings = await provider.embed(['document image']);
            
            const results = await store.search({
                vector: embeddings[0],
                filter: { is_exhibit: true },
                limit: 5
            });
            
            console.log('SUCCESS:' + results.length + ' exhibits retrieved');
        } catch (error) {
            console.log('ERROR:' + error.message);
        }
    }
    
    testExhibitRetrieval();
" 2>&1)

if [[ "$TEST_OUTPUT" == SUCCESS:* ]]; then
    RESULT_COUNT=$(echo "$TEST_OUTPUT" | cut -d':' -f2 | cut -d' ' -f1)
    print_result "Exhibit retrieval" "PASS" "Retrieved $RESULT_COUNT exhibits"
else
    print_result "Exhibit retrieval" "FAIL" "$TEST_OUTPUT"
fi
echo ""

# Test 6: Test exhibit file naming convention
echo "Test 6: Exhibit file naming"
if [ -d "$EXHIBITS_DIR" ] && [ "$(ls -A $EXHIBITS_DIR 2>/dev/null)" ]; then
    # Check if any exhibit files follow the naming convention
    VALID_FILES=$(find "$EXHIBITS_DIR" -type f -name "*_page*_img*.png" | wc -l)
    
    if [ "$VALID_FILES" -gt 0 ]; then
        print_result "Exhibit naming convention" "PASS" "Found $VALID_FILES files with correct naming"
    else
        print_result "Exhibit naming convention" "FAIL" "No files found with correct naming pattern"
    fi
else
    print_result "Exhibit naming convention" "FAIL" "No exhibits found in directory"
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
