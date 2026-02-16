#!/bin/bash

# Master test script - runs all test scripts sequentially
# Provides comprehensive testing of Sound Suite system

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test suite results
SUITES_PASSED=0
SUITES_FAILED=0
TOTAL_TESTS_PASSED=0
TOTAL_TESTS_FAILED=0

echo "=========================================="
echo "Sound Suite - Complete Test Suite"
echo "=========================================="
echo ""
echo "Running all test scripts..."
echo ""

# Function to run a test script
run_test_suite() {
    local script_name="$1"
    local script_path="$SCRIPT_DIR/$script_name"
    
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}Running: $script_name${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    if [ -f "$script_path" ]; then
        if bash "$script_path"; then
            echo ""
            echo -e "${GREEN}✓ $script_name completed successfully${NC}"
            ((SUITES_PASSED++))
        else
            echo ""
            echo -e "${RED}✗ $script_name failed${NC}"
            ((SUITES_FAILED++))
        fi
    else
        echo -e "${RED}✗ Script not found: $script_path${NC}"
        ((SUITES_FAILED++))
    fi
    
    echo ""
    echo ""
}

# Run all test suites
run_test_suite "test-ingestion.sh"
run_test_suite "test-search.sh"
run_test_suite "test-exhibits.sh"
run_test_suite "test-mcp-tools.sh"
run_test_suite "test-auth.sh"

# Final summary
echo "=========================================="
echo "Complete Test Suite Summary"
echo "=========================================="
echo ""
echo -e "Test Suites Passed: ${GREEN}$SUITES_PASSED${NC}"
echo -e "Test Suites Failed: ${RED}$SUITES_FAILED${NC}"
echo ""

if [ $SUITES_FAILED -eq 0 ]; then
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}✓ ALL TEST SUITES PASSED!${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 0
else
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}✗ SOME TEST SUITES FAILED${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo "Please review the failed tests above and fix any issues."
    exit 1
fi
