#!/bin/bash

###############################################################################
# Sound Suite - Database Restore Script
# 
# This script restores the database from a backup:
# 1. Validates backup directory and manifest
# 2. Creates backup of current data (optional)
# 3. Restores SQLite database
# 4. Restores LanceDB vector data
# 5. Verifies data integrity
# 
# Usage:
#   ./scripts/db/db-restore.sh --backup /path/to/backup
#   ./scripts/db/db-restore.sh --backup /path/to/backup --no-verify
#   ./scripts/db/db-restore.sh --backup /path/to/backup --db-only
#   ./scripts/db/db-restore.sh --backup /path/to/backup --lancedb-only
# 
# Requirements: 20.5
###############################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"

# Function to print colored messages
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_header() {
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
}

###############################################################################
# Parse Arguments
###############################################################################

BACKUP_DIR=""
RESTORE_DB=true
RESTORE_LANCEDB=true
VERIFY_INTEGRITY=true

while [[ $# -gt 0 ]]; do
    case $1 in
        --backup)
            BACKUP_DIR="$2"
            shift 2
            ;;
        --db-only)
            RESTORE_LANCEDB=false
            shift
            ;;
        --lancedb-only)
            RESTORE_DB=false
            shift
            ;;
        --no-verify)
            VERIFY_INTEGRITY=false
            shift
            ;;
        *)
            print_error "Unknown argument: $1"
            echo ""
            print_info "Usage:"
            echo "  ./scripts/db/db-restore.sh --backup /path/to/backup"
            echo "  ./scripts/db/db-restore.sh --backup /path/to/backup --no-verify"
            echo "  ./scripts/db/db-restore.sh --backup /path/to/backup --db-only"
            echo "  ./scripts/db/db-restore.sh --backup /path/to/backup --lancedb-only"
            exit 1
            ;;
    esac
done

# Validate backup directory
if [ -z "$BACKUP_DIR" ]; then
    print_error "Backup directory not specified!"
    echo ""
    print_info "Usage:"
    echo "  ./scripts/db/db-restore.sh --backup /path/to/backup"
    exit 1
fi

if [ ! -d "$BACKUP_DIR" ]; then
    print_error "Backup directory not found: $BACKUP_DIR"
    exit 1
fi

###############################################################################
# Main Script
###############################################################################

print_header "Sound Suite - Database Restore"
echo ""

print_warning "═══════════════════════════════════════════════════════════"
print_warning "  WARNING: This will OVERWRITE current database data!"
print_warning "═══════════════════════════════════════════════════════════"
echo ""

# Check if .env file exists
if [ ! -f "$PROJECT_ROOT/.env" ]; then
    print_error ".env file not found!"
    print_info "Please copy .env.example to .env and configure it:"
    print_info "  cp .env.example .env"
    exit 1
fi

# Load environment variables
set -a
source "$PROJECT_ROOT/.env"
set +a

# Get paths
DB_PATH="${DATABASE_URL#file:}"
DB_PATH="$PROJECT_ROOT/$DB_PATH"

LANCEDB_PATH="${LANCEDB_PATH:-./data/lancedb}"
LANCEDB_PATH="$PROJECT_ROOT/$LANCEDB_PATH"

print_info "Configuration:"
echo "  • Database:  $DB_PATH"
echo "  • LanceDB:   $LANCEDB_PATH"
echo "  • Backup:    $BACKUP_DIR"
echo ""

###############################################################################
# Validate Backup
###############################################################################

print_info "Validating backup..."

MANIFEST_FILE="$BACKUP_DIR/manifest.json"

if [ ! -f "$MANIFEST_FILE" ]; then
    print_error "Backup manifest not found: $MANIFEST_FILE"
    print_info "This may not be a valid backup directory"
    exit 1
fi

# Read manifest
BACKUP_TIMESTAMP=$(grep '"timestamp"' "$MANIFEST_FILE" | cut -d'"' -f4)
BACKUP_VERSION=$(grep '"version"' "$MANIFEST_FILE" | cut -d'"' -f4)

print_success "Valid backup found"
echo "  • Version:   $BACKUP_VERSION"
echo "  • Timestamp: $BACKUP_TIMESTAMP"
echo ""

# Confirm restore
read -p "Are you sure you want to restore from this backup? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    print_info "Restore cancelled"
    exit 0
fi

echo ""

###############################################################################
# Backup Current Data
###############################################################################

print_info "Step 1: Backing up current data..."

CURRENT_BACKUP_DIR="$PROJECT_ROOT/data/backups/pre-restore-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$CURRENT_BACKUP_DIR"

if [ -f "$DB_PATH" ]; then
    cp "$DB_PATH" "$CURRENT_BACKUP_DIR/sound-suite.db"
    print_success "Current database backed up"
else
    print_info "No existing database to backup"
fi

if [ -d "$LANCEDB_PATH" ]; then
    cp -r "$LANCEDB_PATH" "$CURRENT_BACKUP_DIR/lancedb"
    print_success "Current LanceDB backed up"
else
    print_info "No existing LanceDB to backup"
fi

print_info "Current data backed up to: $CURRENT_BACKUP_DIR"
echo ""

###############################################################################
# Restore SQLite Database
###############################################################################

if [ "$RESTORE_DB" = true ]; then
    print_info "Step 2: Restoring SQLite database..."
    
    BACKUP_DB_FILE="$BACKUP_DIR/sound-suite.db"
    
    if [ -f "$BACKUP_DB_FILE" ]; then
        # Ensure parent directory exists
        mkdir -p "$(dirname "$DB_PATH")"
        
        # Copy database
        cp "$BACKUP_DB_FILE" "$DB_PATH"
        
        DB_SIZE=$(du -h "$DB_PATH" | cut -f1)
        print_success "Database restored: $DB_SIZE"
        
        # Verify database integrity
        if command -v sqlite3 &> /dev/null; then
            if sqlite3 "$DB_PATH" "PRAGMA integrity_check;" | grep -q "ok"; then
                print_success "Database integrity check passed"
            else
                print_error "Database integrity check failed!"
                print_warning "Database may be corrupted"
            fi
        fi
    else
        print_warning "Database file not found in backup: $BACKUP_DB_FILE"
        print_info "Skipping database restore"
    fi
else
    print_info "Step 2: Skipping SQLite restore (--lancedb-only)"
fi

echo ""

###############################################################################
# Restore LanceDB
###############################################################################

if [ "$RESTORE_LANCEDB" = true ]; then
    print_info "Step 3: Restoring LanceDB data..."
    
    BACKUP_LANCEDB_DIR="$BACKUP_DIR/lancedb"
    
    if [ -d "$BACKUP_LANCEDB_DIR" ]; then
        # Remove existing LanceDB directory
        if [ -d "$LANCEDB_PATH" ]; then
            rm -rf "$LANCEDB_PATH"
            print_info "Removed existing LanceDB directory"
        fi
        
        # Ensure parent directory exists
        mkdir -p "$(dirname "$LANCEDB_PATH")"
        
        # Copy LanceDB directory
        cp -r "$BACKUP_LANCEDB_DIR" "$LANCEDB_PATH"
        
        LANCEDB_SIZE=$(du -sh "$LANCEDB_PATH" | cut -f1)
        TABLE_COUNT=$(find "$LANCEDB_PATH" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
        
        print_success "LanceDB restored: $LANCEDB_SIZE ($TABLE_COUNT tables)"
    else
        print_warning "LanceDB directory not found in backup: $BACKUP_LANCEDB_DIR"
        print_info "Skipping LanceDB restore"
    fi
else
    print_info "Step 3: Skipping LanceDB restore (--db-only)"
fi

echo ""

###############################################################################
# Verify Integrity
###############################################################################

if [ "$VERIFY_INTEGRITY" = true ]; then
    print_info "Step 4: Verifying data integrity..."
    
    INTEGRITY_ERRORS=0
    
    # Verify database
    if [ "$RESTORE_DB" = true ] && [ -f "$DB_PATH" ]; then
        if command -v sqlite3 &> /dev/null; then
            # Check if database is accessible
            if sqlite3 "$DB_PATH" "SELECT 1;" > /dev/null 2>&1; then
                CASE_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM Case;" 2>/dev/null || echo "0")
                DOC_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM Document;" 2>/dev/null || echo "0")
                
                print_success "Database is accessible"
                echo "  • Cases:     $CASE_COUNT"
                echo "  • Documents: $DOC_COUNT"
            else
                print_error "Database is not accessible"
                INTEGRITY_ERRORS=$((INTEGRITY_ERRORS + 1))
            fi
        fi
    fi
    
    # Verify LanceDB
    if [ "$RESTORE_LANCEDB" = true ] && [ -d "$LANCEDB_PATH" ]; then
        if [ -r "$LANCEDB_PATH" ] && [ -w "$LANCEDB_PATH" ]; then
            print_success "LanceDB is accessible"
        else
            print_error "LanceDB is not accessible (check permissions)"
            INTEGRITY_ERRORS=$((INTEGRITY_ERRORS + 1))
        fi
    fi
    
    if [ $INTEGRITY_ERRORS -eq 0 ]; then
        print_success "All integrity checks passed"
    else
        print_error "$INTEGRITY_ERRORS integrity check(s) failed"
        print_warning "Restore may be incomplete or corrupted"
    fi
else
    print_info "Step 4: Skipping integrity verification (--no-verify)"
fi

echo ""

###############################################################################
# Summary
###############################################################################

print_header "Restore Complete"
echo ""

if [ $INTEGRITY_ERRORS -eq 0 ] || [ "$VERIFY_INTEGRITY" = false ]; then
    print_success "Database restored successfully!"
else
    print_warning "Restore completed with warnings"
fi

echo ""

print_info "Restored Data:"
if [ "$RESTORE_DB" = true ]; then
    DB_SIZE=$(du -h "$DB_PATH" 2>/dev/null | cut -f1 || echo "N/A")
    echo "  • SQLite Database: $DB_SIZE"
fi
if [ "$RESTORE_LANCEDB" = true ]; then
    LANCEDB_SIZE=$(du -sh "$LANCEDB_PATH" 2>/dev/null | cut -f1 || echo "N/A")
    echo "  • LanceDB Data:    $LANCEDB_SIZE"
fi

echo ""

print_info "Previous Data Backup:"
echo "  • $CURRENT_BACKUP_DIR"

echo ""

print_info "Next Steps:"
echo "  • Start services: ./scripts/start.sh"
echo "  • Run health check: ./scripts/health-check.sh"
echo "  • Verify data: Check dashboard at http://localhost:3000"
