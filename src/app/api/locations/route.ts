/**
 * GET /api/locations?type=states|counties|countries&state=TX
 *
 * Serve location data from the data/ folder.
 */

import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs/promises';
import * as path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');

let statesCache: Array<{ code: string; name: string }> | null = null;
let countiesCache: Array<{ county: string; state: string; stateCode: string }> | null = null;
let countriesCache: string[] | null = null;

async function loadStates() {
  if (!statesCache) {
    const raw = await fs.readFile(path.join(DATA_DIR, 'us-states.json'), 'utf-8');
    statesCache = JSON.parse(raw);
  }
  return statesCache!;
}

async function loadCounties() {
  if (!countiesCache) {
    const raw = await fs.readFile(path.join(DATA_DIR, 'us-counties.json'), 'utf-8');
    countiesCache = JSON.parse(raw);
  }
  return countiesCache!;
}

async function loadCountries() {
  if (!countriesCache) {
    const raw = await fs.readFile(path.join(DATA_DIR, 'countries.json'), 'utf-8');
    countriesCache = JSON.parse(raw);
  }
  return countriesCache!;
}

export async function GET(request: NextRequest) {
  try {
    const type = request.nextUrl.searchParams.get('type') || 'states';
    const stateFilter = request.nextUrl.searchParams.get('state');

    switch (type) {
      case 'states': {
        const states = await loadStates();
        return NextResponse.json(states.map(s => s.name));
      }
      case 'counties': {
        const counties = await loadCounties();
        if (stateFilter) {
          const filtered = counties
            .filter(c => c.stateCode === stateFilter || c.state.toLowerCase() === stateFilter.toLowerCase())
            .map(c => c.county);
          return NextResponse.json(filtered);
        }
        return NextResponse.json(counties.map(c => `${c.county}, ${c.stateCode}`));
      }
      case 'countries': {
        const countries = await loadCountries();
        return NextResponse.json(countries);
      }
      default:
        return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load location data' },
      { status: 500 }
    );
  }
}
