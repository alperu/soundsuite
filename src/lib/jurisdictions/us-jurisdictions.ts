/**
 * US Jurisdictions catalogue.
 *
 * Scope: 1 federal + 50 states + DC + 5 inhabited territories +
 * the Texas counties where the user's caseload sits + a handful
 * of major counties in other states for completeness.
 *
 * Code conventions:
 *   - 'US'                — the federal jurisdiction
 *   - 'US-XX'             — state / DC / territory using USPS 2-letter codes
 *                           (e.g. 'US-TX', 'US-DC', 'US-PR')
 *   - 'US-XX-COUNTYNAME'  — county within a state, uppercase county slug
 *                           (e.g. 'US-TX-TRAVIS', 'US-CA-LOSANGELES')
 *
 * FIPS codes are 2-digit state codes and 3-digit county codes
 * (state FIPS is concatenated for counties).
 *
 * Sources:
 *  - USPS state abbreviations: https://about.usps.com/who/profile/state-abbreviations.htm
 *  - Census Bureau FIPS codes: https://www.census.gov/library/reference/code-lists/ansi.html
 *  - Texas county list (254 counties): https://www.texas.gov/living-in-texas/texas-counties/
 */

export interface JurisdictionEntry {
  /** Stable code, used as the `code` column on the Prisma Jurisdiction row. */
  code: string;
  /** Human display name (e.g. "Texas", "Travis County, Texas"). */
  displayName: string;
  /** Containment tier. */
  level: "federal" | "state" | "territory" | "county" | "municipal" | "tribal";
  /** Parent jurisdiction code (omitted for the federal root). */
  parentCode?: string;
  /** Census/ANSI FIPS code (2 digits state, 5 digits county). */
  fipsCode?: string;
}

export const US_JURISDICTIONS: readonly JurisdictionEntry[] = [
  // ── Federal ─────────────────────────────────────────────────────────────
  { code: "US", displayName: "United States", level: "federal" },

  // ── 50 States (USPS + FIPS) ─────────────────────────────────────────────
  { code: "US-AL", displayName: "Alabama", level: "state", parentCode: "US", fipsCode: "01" },
  { code: "US-AK", displayName: "Alaska", level: "state", parentCode: "US", fipsCode: "02" },
  { code: "US-AZ", displayName: "Arizona", level: "state", parentCode: "US", fipsCode: "04" },
  { code: "US-AR", displayName: "Arkansas", level: "state", parentCode: "US", fipsCode: "05" },
  { code: "US-CA", displayName: "California", level: "state", parentCode: "US", fipsCode: "06" },
  { code: "US-CO", displayName: "Colorado", level: "state", parentCode: "US", fipsCode: "08" },
  { code: "US-CT", displayName: "Connecticut", level: "state", parentCode: "US", fipsCode: "09" },
  { code: "US-DE", displayName: "Delaware", level: "state", parentCode: "US", fipsCode: "10" },
  { code: "US-FL", displayName: "Florida", level: "state", parentCode: "US", fipsCode: "12" },
  { code: "US-GA", displayName: "Georgia", level: "state", parentCode: "US", fipsCode: "13" },
  { code: "US-HI", displayName: "Hawaii", level: "state", parentCode: "US", fipsCode: "15" },
  { code: "US-ID", displayName: "Idaho", level: "state", parentCode: "US", fipsCode: "16" },
  { code: "US-IL", displayName: "Illinois", level: "state", parentCode: "US", fipsCode: "17" },
  { code: "US-IN", displayName: "Indiana", level: "state", parentCode: "US", fipsCode: "18" },
  { code: "US-IA", displayName: "Iowa", level: "state", parentCode: "US", fipsCode: "19" },
  { code: "US-KS", displayName: "Kansas", level: "state", parentCode: "US", fipsCode: "20" },
  { code: "US-KY", displayName: "Kentucky", level: "state", parentCode: "US", fipsCode: "21" },
  { code: "US-LA", displayName: "Louisiana", level: "state", parentCode: "US", fipsCode: "22" },
  { code: "US-ME", displayName: "Maine", level: "state", parentCode: "US", fipsCode: "23" },
  { code: "US-MD", displayName: "Maryland", level: "state", parentCode: "US", fipsCode: "24" },
  { code: "US-MA", displayName: "Massachusetts", level: "state", parentCode: "US", fipsCode: "25" },
  { code: "US-MI", displayName: "Michigan", level: "state", parentCode: "US", fipsCode: "26" },
  { code: "US-MN", displayName: "Minnesota", level: "state", parentCode: "US", fipsCode: "27" },
  { code: "US-MS", displayName: "Mississippi", level: "state", parentCode: "US", fipsCode: "28" },
  { code: "US-MO", displayName: "Missouri", level: "state", parentCode: "US", fipsCode: "29" },
  { code: "US-MT", displayName: "Montana", level: "state", parentCode: "US", fipsCode: "30" },
  { code: "US-NE", displayName: "Nebraska", level: "state", parentCode: "US", fipsCode: "31" },
  { code: "US-NV", displayName: "Nevada", level: "state", parentCode: "US", fipsCode: "32" },
  { code: "US-NH", displayName: "New Hampshire", level: "state", parentCode: "US", fipsCode: "33" },
  { code: "US-NJ", displayName: "New Jersey", level: "state", parentCode: "US", fipsCode: "34" },
  { code: "US-NM", displayName: "New Mexico", level: "state", parentCode: "US", fipsCode: "35" },
  { code: "US-NY", displayName: "New York", level: "state", parentCode: "US", fipsCode: "36" },
  { code: "US-NC", displayName: "North Carolina", level: "state", parentCode: "US", fipsCode: "37" },
  { code: "US-ND", displayName: "North Dakota", level: "state", parentCode: "US", fipsCode: "38" },
  { code: "US-OH", displayName: "Ohio", level: "state", parentCode: "US", fipsCode: "39" },
  { code: "US-OK", displayName: "Oklahoma", level: "state", parentCode: "US", fipsCode: "40" },
  { code: "US-OR", displayName: "Oregon", level: "state", parentCode: "US", fipsCode: "41" },
  { code: "US-PA", displayName: "Pennsylvania", level: "state", parentCode: "US", fipsCode: "42" },
  { code: "US-RI", displayName: "Rhode Island", level: "state", parentCode: "US", fipsCode: "44" },
  { code: "US-SC", displayName: "South Carolina", level: "state", parentCode: "US", fipsCode: "45" },
  { code: "US-SD", displayName: "South Dakota", level: "state", parentCode: "US", fipsCode: "46" },
  { code: "US-TN", displayName: "Tennessee", level: "state", parentCode: "US", fipsCode: "47" },
  { code: "US-TX", displayName: "Texas", level: "state", parentCode: "US", fipsCode: "48" },
  { code: "US-UT", displayName: "Utah", level: "state", parentCode: "US", fipsCode: "49" },
  { code: "US-VT", displayName: "Vermont", level: "state", parentCode: "US", fipsCode: "50" },
  { code: "US-VA", displayName: "Virginia", level: "state", parentCode: "US", fipsCode: "51" },
  { code: "US-WA", displayName: "Washington", level: "state", parentCode: "US", fipsCode: "53" },
  { code: "US-WV", displayName: "West Virginia", level: "state", parentCode: "US", fipsCode: "54" },
  { code: "US-WI", displayName: "Wisconsin", level: "state", parentCode: "US", fipsCode: "55" },
  { code: "US-WY", displayName: "Wyoming", level: "state", parentCode: "US", fipsCode: "56" },

  // ── District of Columbia ────────────────────────────────────────────────
  { code: "US-DC", displayName: "District of Columbia", level: "state", parentCode: "US", fipsCode: "11" },

  // ── Inhabited US Territories ────────────────────────────────────────────
  { code: "US-PR", displayName: "Puerto Rico", level: "territory", parentCode: "US", fipsCode: "72" },
  { code: "US-GU", displayName: "Guam", level: "territory", parentCode: "US", fipsCode: "66" },
  { code: "US-VI", displayName: "US Virgin Islands", level: "territory", parentCode: "US", fipsCode: "78" },
  { code: "US-AS", displayName: "American Samoa", level: "territory", parentCode: "US", fipsCode: "60" },
  { code: "US-MP", displayName: "Northern Mariana Islands", level: "territory", parentCode: "US", fipsCode: "69" },

  // ── Texas counties (deep coverage — user's caseload) ────────────────────
  // Travis is the primary venue. Surrounding I-35 corridor + major Texas metros.
  { code: "US-TX-TRAVIS", displayName: "Travis County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48453" },
  { code: "US-TX-WILLIAMSON", displayName: "Williamson County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48491" },
  { code: "US-TX-HAYS", displayName: "Hays County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48209" },
  { code: "US-TX-BASTROP", displayName: "Bastrop County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48021" },
  { code: "US-TX-CALDWELL", displayName: "Caldwell County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48055" },
  { code: "US-TX-BURNET", displayName: "Burnet County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48053" },
  { code: "US-TX-BLANCO", displayName: "Blanco County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48031" },
  { code: "US-TX-COMAL", displayName: "Comal County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48091" },
  { code: "US-TX-BEXAR", displayName: "Bexar County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48029" },
  { code: "US-TX-HARRIS", displayName: "Harris County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48201" },
  { code: "US-TX-FORTBEND", displayName: "Fort Bend County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48157" },
  { code: "US-TX-MONTGOMERY", displayName: "Montgomery County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48339" },
  { code: "US-TX-BRAZORIA", displayName: "Brazoria County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48039" },
  { code: "US-TX-GALVESTON", displayName: "Galveston County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48167" },
  { code: "US-TX-DALLAS", displayName: "Dallas County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48113" },
  { code: "US-TX-TARRANT", displayName: "Tarrant County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48439" },
  { code: "US-TX-COLLIN", displayName: "Collin County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48085" },
  { code: "US-TX-DENTON", displayName: "Denton County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48121" },
  { code: "US-TX-ROCKWALL", displayName: "Rockwall County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48397" },
  { code: "US-TX-ELLIS", displayName: "Ellis County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48139" },
  { code: "US-TX-JOHNSON", displayName: "Johnson County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48251" },
  { code: "US-TX-PARKER", displayName: "Parker County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48367" },
  { code: "US-TX-ELPASO", displayName: "El Paso County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48141" },
  { code: "US-TX-LUBBOCK", displayName: "Lubbock County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48303" },
  { code: "US-TX-NUECES", displayName: "Nueces County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48355" },
  { code: "US-TX-HIDALGO", displayName: "Hidalgo County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48215" },
  { code: "US-TX-CAMERON", displayName: "Cameron County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48061" },
  { code: "US-TX-WEBB", displayName: "Webb County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48479" },
  { code: "US-TX-MCLENNAN", displayName: "McLennan County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48309" },
  { code: "US-TX-BELL", displayName: "Bell County, Texas", level: "county", parentCode: "US-TX", fipsCode: "48027" },

  // ── Major counties in other states (shallow coverage) ───────────────────
  { code: "US-CA-LOSANGELES", displayName: "Los Angeles County, California", level: "county", parentCode: "US-CA", fipsCode: "06037" },
  { code: "US-CA-SANFRANCISCO", displayName: "San Francisco County, California", level: "county", parentCode: "US-CA", fipsCode: "06075" },
  { code: "US-CA-SANDIEGO", displayName: "San Diego County, California", level: "county", parentCode: "US-CA", fipsCode: "06073" },
  { code: "US-CA-ORANGE", displayName: "Orange County, California", level: "county", parentCode: "US-CA", fipsCode: "06059" },
  { code: "US-CA-SANTACLARA", displayName: "Santa Clara County, California", level: "county", parentCode: "US-CA", fipsCode: "06085" },
  { code: "US-NY-NEWYORK", displayName: "New York County, New York", level: "county", parentCode: "US-NY", fipsCode: "36061" },
  { code: "US-NY-KINGS", displayName: "Kings County (Brooklyn), New York", level: "county", parentCode: "US-NY", fipsCode: "36047" },
  { code: "US-NY-QUEENS", displayName: "Queens County, New York", level: "county", parentCode: "US-NY", fipsCode: "36081" },
  { code: "US-IL-COOK", displayName: "Cook County, Illinois", level: "county", parentCode: "US-IL", fipsCode: "17031" },
  { code: "US-FL-MIAMIDADE", displayName: "Miami-Dade County, Florida", level: "county", parentCode: "US-FL", fipsCode: "12086" },
  { code: "US-FL-BROWARD", displayName: "Broward County, Florida", level: "county", parentCode: "US-FL", fipsCode: "12011" },
  { code: "US-FL-ORANGE", displayName: "Orange County, Florida", level: "county", parentCode: "US-FL", fipsCode: "12095" },
  { code: "US-GA-FULTON", displayName: "Fulton County, Georgia", level: "county", parentCode: "US-GA", fipsCode: "13121" },
  { code: "US-AZ-MARICOPA", displayName: "Maricopa County, Arizona", level: "county", parentCode: "US-AZ", fipsCode: "04013" },
  { code: "US-WA-KING", displayName: "King County, Washington", level: "county", parentCode: "US-WA", fipsCode: "53033" },
  { code: "US-MA-SUFFOLK", displayName: "Suffolk County, Massachusetts", level: "county", parentCode: "US-MA", fipsCode: "25025" },
  { code: "US-PA-PHILADELPHIA", displayName: "Philadelphia County, Pennsylvania", level: "county", parentCode: "US-PA", fipsCode: "42101" },
  { code: "US-CO-DENVER", displayName: "Denver County, Colorado", level: "county", parentCode: "US-CO", fipsCode: "08031" },
  { code: "US-NV-CLARK", displayName: "Clark County, Nevada", level: "county", parentCode: "US-NV", fipsCode: "32003" },
  { code: "US-MI-WAYNE", displayName: "Wayne County, Michigan", level: "county", parentCode: "US-MI", fipsCode: "26163" },
] as const;

/** Number of US jurisdictions in the catalogue. */
export const US_JURISDICTION_COUNT = US_JURISDICTIONS.length;

/** Quick lookup by code. Built lazily; safe for repeated reads. */
let _byCode: Map<string, JurisdictionEntry> | null = null;
export function jurisdictionByCode(code: string): JurisdictionEntry | undefined {
  if (!_byCode) {
    _byCode = new Map(US_JURISDICTIONS.map((j) => [j.code, j]));
  }
  return _byCode.get(code);
}
