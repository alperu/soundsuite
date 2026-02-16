#!/bin/bash

###############################################################################
# Sound Suite - Database Migration Script
# 
# This script runs Prisma migrations to update the database schema.
# 
# Usage:
#   ./scripts/db/db-migrate.sh          # Apply pending migrations
#   ./scripts/db/db-migrate.sh status   # Check migration status
#   ./scripts/db/db-migrate.sh reset    # Reset database (WARNING: destructive)
# 
# Requirements: 20.4, 20.5
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
# Main Script
###############################################################################

print_header "Sound Suite - Database Migration"
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

# Get database path
DB_PATH="${DATABASE_URL#file:}"
DB_PATH="$PROJECT_ROOT/$DB_PATH"

# Parse command
COMMAND="${1:-apply}"

case "$COMMAND" in
    "status")
        print_info "Checking migration status..."
        echo ""
        cd "$PROJECT_ROOT"
        npx prisma migrate status
        ;;
    
    "reset")
        print_warning "═══════════════════════════════════════════════════════════"
        print_warning "  WARNING: This will DELETE ALL DATA in the database!"
        print_warning "═══════════════════════════════════════════════════════════"
        echo ""
        print_warning "Database path: $DB_PATH"
        echo ""
        read -p "Are you sure you want to reset the database? (yes/no): " CONFIRM
        
        if [ "$CONFIRM" != "yes" ]; then
            print_info "Reset cancelled"
            exit 0
        fi
        
        print_info "Resetting database..."
        cd "$PROJECT_ROOT"
        npx prisma migrate reset --force
        print_success "Database reset complete"
        ;;
    
    "apply"|"deploy")
        print_info "Checking for pending migrations..."
        cd "$PROJECT_ROOT"
        
        # Check if database exists
        if [ ! -f "$DB_PATH" ]; then
            print_warning "Database not found at $DB_PATH"
            print_info "Creating database and applying migrations..."
            npx prisma migrate deploy
            print_success "Database created and migrations applied"
        else
            print_success "Database found at $DB_PATH"
            
            # Check migration status
            if npx prisma migrate status 2>&1 | grep -q "pending"; then
                print_warning "Pending migrations detected"
                print_info "Applying migrations..."
                npx prisma migrate deploy
                print_success "Migrations applied successfully"
            else
                print_success "Database is up to date - no pending migrations"
            fi
        fi
        
        # Display database info
        echo ""
        print_info "Database Information:"
        if command -v sqlite3 &> /dev/null; then
            CASE_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM Case;" 2>/dev/null || echo "0")
            DOC_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM Document;" 2>/dev/null || echo "0")
            JOB_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM JobLog;" 2>/dev/null || echo "0")
            
            echo "  • Cases:     $CASE_COUNT"
            echo "  • Documents: $DOC_COUNT"
            echo "  • Job Logs:  $JOB_COUNT"
        else
            print_warning "sqlite3 not installed - cannot display record counts"
        fi
        
        DB_SIZE=$(du -h "$DB_PATH" 2>/dev/null | cut -f1)
        echo "  • Size:      $DB_SIZE"
        ;;
    
    *)
        print_error "Unknown command: $COMMAND"
        echo ""
        print_info "Usage:"
        echo "  ./scripts/db/db-migrate.sh          # Apply pending migrations"
        echo "  ./scripts/db/db-migrate.sh status   # Check migration status"
        echo "  ./scripts/db/db-migrate.sh reset    # Reset database (WARNING: destructive)"
        exit 1
        ;;
esac

echo ""
print_success "Migration operation complete"
