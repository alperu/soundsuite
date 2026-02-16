#!/bin/bash

###############################################################################
# Sound Suite - Database Backup Script
# 
# This script creates a backup of both SQLite and LanceDB data:
# 1. Creates timestamped backup directory
# 2. Backs up SQLite database
# 3. Backs up LanceDB vector data
# 4. Creates manifest with metadata
# 
# Usage:
#   ./scripts/db/db-backup.sh                    # Full backup (SQLite + LanceDB)
#   ./scripts/db/db-backup.sh --db-only          # SQLite only
#   ./scripts/db/db-backup.sh --lancedb-only     # LanceDB only
#   ./scripts/db/db-backup.sh --output /path     # Custom output directory
# 
# Requirements: 20.4
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

BACKUP_DB=true
BACKUP_LANCEDB=true
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --db-only)
            BACKUP_LANCEDB=false
            shift
            ;;
        --lancedb-only)
            BACKUP_DB=false
            shift
            ;;
        --output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        *)
            print_error "Unknown argument: $1"
            echo ""
            print_info "Usage:"
            echo "  ./scripts/db/db-backup.sh                    # Full backup"
            echo "  ./scripts/db/db-backup.sh --db-only          # SQLite only"
            echo "  ./scripts/db/db-backup.sh --lancedb-only     # LanceDB only"
            echo "  ./scripts/db/db-backup.sh --output /path     # Custom output directory"
            exit 1
            ;;
    esac
done

###############################################################################
# Main Script
###############################################################################

print_header "Sound Suite - Database Backup"
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

# Set output directory
if [ -z "$OUTPUT_DIR" ]; then
    OUTPUT_DIR="$PROJECT_ROOT/data/backups"
fi

print_info "Configuration:"
echo "  • Database:  $DB_PATH"
echo "  • LanceDB:   $LANCEDB_PATH"
echo "  • Output:    $OUTPUT_DIR"
echo ""

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Create timestamped backup directory
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="$OUTPUT_DIR/backup-$TIMESTAMP"
mkdir -p "$BACKUP_DIR"

print_info "Creating backup in: $BACKUP_DIR"
echo ""

###############################################################################
# Backup SQLite Database
###############################################################################

DB_SIZE=0

if [ "$BACKUP_DB" = true ]; then
    print_info "Step 1: Backing up SQLite database..."
    
    if [ -f "$DB_PATH" ]; then
        cp "$DB_PATH" "$BACKUP_DIR/sound-suite.db"
        DB_SIZE=$(stat -f%z "$BACKUP_DIR/sound-suite.db" 2>/dev/null || stat -c%s "$BACKUP_DIR/sound-suite.db" 2>/dev/null || echo "0")
        DB_SIZE_HUMAN=$(du -h "$BACKUP_DIR/sound-suite.db" | cut -f1)
        print_success "Database backed up: $DB_SIZE_HUMAN"
    else
        print_warning "Database file not found at $DB_PATH"
        print_info "Creating empty placeholder"
        touch "$BACKUP_DIR/sound-suite.db"
    fi
else
    print_info "Step 1: Skipping SQLite backup (--lancedb-only)"
fi

echo ""

###############################################################################
# Backup LanceDB
###############################################################################

LANCEDB_SIZE=0

if [ "$BACKUP_LANCEDB" = true ]; then
    print_info "Step 2: Backing up LanceDB data..."
    
    if [ -d "$LANCEDB_PATH" ]; then
        # Copy entire LanceDB directory
        cp -r "$LANCEDB_PATH" "$BACKUP_DIR/lancedb"
        
        # Calculate size
        LANCEDB_SIZE=$(du -sb "$BACKUP_DIR/lancedb" 2>/dev/null | cut -f1 || echo "0")
        LANCEDB_SIZE_HUMAN=$(du -sh "$BACKUP_DIR/lancedb" | cut -f1)
        
        # Count tables
        TABLE_COUNT=$(find "$BACKUP_DIR/lancedb" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
        
        print_success "LanceDB backed up: $LANCEDB_SIZE_HUMAN ($TABLE_COUNT tables)"
    else
        print_warning "LanceDB directory not found at $LANCEDB_PATH"
        print_info "Creating empty placeholder"
        mkdir -p "$BACKUP_DIR/lancedb"
    fi
else
    print_info "Step 2: Skipping LanceDB backup (--db-only)"
fi

echo ""

###############################################################################
# Create Manifest
###############################################################################

print_info "Step 3: Creating backup manifest..."

MANIFEST_FILE="$BACKUP_DIR/manifest.json"

cat > "$MANIFEST_FILE" << EOF
{
  "version": "1.0.0",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "databasePath": "$DB_PATH",
  "lancedbPath": "$LANCEDB_PATH",
  "databaseSize": $DB_SIZE,
  "lancedbSize": $LANCEDB_SIZE,
  "backupType": "$([ "$BACKUP_DB" = true ] && [ "$BACKUP_LANCEDB" = true ] && echo "full" || ([ "$BACKUP_DB" = true ] && echo "database-only" || echo "lancedb-only"))"
}
EOF

print_success "Manifest created: $MANIFEST_FILE"
echo ""

###############################################################################
# Summary
###############################################################################

print_header "Backup Complete"
echo ""

print_success "Backup created successfully!"
echo ""

print_info "Backup Location:"
echo "  • $BACKUP_DIR"
echo ""

print_info "Backup Contents:"
if [ "$BACKUP_DB" = true ]; then
    echo "  • SQLite Database: $DB_SIZE_HUMAN"
fi
if [ "$BACKUP_LANCEDB" = true ]; then
    echo "  • LanceDB Data:    $LANCEDB_SIZE_HUMAN"
fi
echo "  • Manifest:        manifest.json"
echo ""

# Calculate total backup size
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
print_info "Total Backup Size: $TOTAL_SIZE"
echo ""

print_info "To restore this backup:"
echo "  ./scripts/db/db-restore.sh --backup $BACKUP_DIR"
echo ""

# List all backups
print_info "Available Backups:"
BACKUP_COUNT=$(find "$OUTPUT_DIR" -maxdepth 1 -type d -name "backup-*" 2>/dev/null | wc -l)
echo "  • Total backups: $BACKUP_COUNT"

if [ "$BACKUP_COUNT" -gt 0 ]; then
    echo "  • Latest backups:"
    find "$OUTPUT_DIR" -maxdepth 1 -type d -name "backup-*" 2>/dev/null | sort -r | head -5 | while read -r backup; do
        BACKUP_NAME=$(basename "$backup")
        BACKUP_SIZE=$(du -sh "$backup" | cut -f1)
        echo "    - $BACKUP_NAME ($BACKUP_SIZE)"
    done
fi
