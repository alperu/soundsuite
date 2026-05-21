/**
 * US Courts catalogue.
 *
 * Scope:
 *   - 1 Supreme Court of the United States
 *   - 13 US Courts of Appeals (1st–11th Circuits + DC Circuit + Federal Circuit)
 *   - 94 US District Courts (the canonical federal trial-court list)
 *   - Specialty federal: Court of International Trade, Court of Federal Claims,
 *     Tax Court, Court of Appeals for the Armed Forces, Court of Appeals for
 *     Veterans Claims, US Bankruptcy Courts (one per district — represented
 *     via the parent District Court entry's `bankruptcy` sibling where notable).
 *   - 50 State Supreme Courts (highest court) + Texas Court of Criminal Appeals
 *     (Texas has a split high court).
 *   - 14 Texas Courts of Appeals
 *   - Texas trial courts in Travis County + a sample from other big-population
 *     Texas counties (the user's caseload is Texas family/appellate)
 *   - Top-10 state intermediate appellate courts by case volume (CA, NY, FL,
 *     IL, OH, PA, MI, NJ, NC, GA)
 *
 * Code conventions:
 *   - 'US-SC'              Supreme Court of the United States
 *   - 'US-CA-N'            United States Court of Appeals for the Nth Circuit
 *                          (N = 1..11, 'DC', 'FED')
 *   - 'US-XXNN' or 'US-XXX' Federal District Courts — short reporter-style code
 *                          (e.g. 'US-TXSD' = Southern District of Texas,
 *                           'US-CAND' = Northern District of California,
 *                           'US-DC'   = District of Columbia District Court)
 *   - 'XX-SC'              State supreme court (e.g. 'TX-SC' = Supreme Court of Texas)
 *   - 'XX-APP-N'           State intermediate appellate, Nth court/district
 *   - 'TX-DC-NNN'          Texas district court, NNNth numbered (statewide unique)
 *
 * Sources:
 *  - US Courts directory: https://www.uscourts.gov/about-federal-courts/court-website-links
 *  - Federal District list: https://www.uscourts.gov/about-federal-courts/federal-courts-public/court-website-links/court-website-links
 *  - Texas Judicial Branch: https://www.txcourts.gov/all-courts/
 *  - Texas District Courts directory: https://www.txcourts.gov/all-courts/district-courts/
 *  - National Center for State Courts: https://www.ncsc.org/
 *  - Wikipedia "State supreme court" / "State courts of the United States" for cross-checks
 */

export interface CourtEntry {
  /** Stable, short, reporter-style code (used as the Court row's external key). */
  code: string;
  /** Full official name. */
  name: string;
  /** Short / reporter abbreviation, e.g. "5th Cir.", "S.D. Tex.", "SCOTUS". */
  shortName?: string;
  /** Code of the parent jurisdiction in US_JURISDICTIONS. */
  jurisdictionCode: string;
  /** Function in the judicial hierarchy. */
  courtType:
    | "supreme"
    | "appellate"
    | "trial"
    | "bankruptcy"
    | "specialty"
    | "tribal";
  /** Mailing address if well-known. */
  address?: string;
  /** Official website. */
  website?: string;
  /** Circuit/district label (e.g. "3rd Court of Appeals", "Western District"). */
  district?: string;
}

export const US_COURTS: readonly CourtEntry[] = [
  // ═══════════════════════════════════════════════════════════════════════
  // FEDERAL COURTS
  // ═══════════════════════════════════════════════════════════════════════

  // ── Supreme Court of the United States ────────────────────────────────
  {
    code: "US-SC",
    name: "Supreme Court of the United States",
    shortName: "SCOTUS",
    jurisdictionCode: "US",
    courtType: "supreme",
    address: "1 First Street, NE, Washington, DC 20543",
    website: "https://www.supremecourt.gov",
  },

  // ── 13 US Courts of Appeals ───────────────────────────────────────────
  { code: "US-CA-1", name: "United States Court of Appeals for the First Circuit", shortName: "1st Cir.", jurisdictionCode: "US", courtType: "appellate", district: "1st Circuit", website: "https://www.ca1.uscourts.gov" },
  { code: "US-CA-2", name: "United States Court of Appeals for the Second Circuit", shortName: "2d Cir.", jurisdictionCode: "US", courtType: "appellate", district: "2nd Circuit", website: "https://www.ca2.uscourts.gov" },
  { code: "US-CA-3", name: "United States Court of Appeals for the Third Circuit", shortName: "3d Cir.", jurisdictionCode: "US", courtType: "appellate", district: "3rd Circuit", website: "https://www.ca3.uscourts.gov" },
  { code: "US-CA-4", name: "United States Court of Appeals for the Fourth Circuit", shortName: "4th Cir.", jurisdictionCode: "US", courtType: "appellate", district: "4th Circuit", website: "https://www.ca4.uscourts.gov" },
  { code: "US-CA-5", name: "United States Court of Appeals for the Fifth Circuit", shortName: "5th Cir.", jurisdictionCode: "US", courtType: "appellate", district: "5th Circuit", website: "https://www.ca5.uscourts.gov" },
  { code: "US-CA-6", name: "United States Court of Appeals for the Sixth Circuit", shortName: "6th Cir.", jurisdictionCode: "US", courtType: "appellate", district: "6th Circuit", website: "https://www.ca6.uscourts.gov" },
  { code: "US-CA-7", name: "United States Court of Appeals for the Seventh Circuit", shortName: "7th Cir.", jurisdictionCode: "US", courtType: "appellate", district: "7th Circuit", website: "https://www.ca7.uscourts.gov" },
  { code: "US-CA-8", name: "United States Court of Appeals for the Eighth Circuit", shortName: "8th Cir.", jurisdictionCode: "US", courtType: "appellate", district: "8th Circuit", website: "https://www.ca8.uscourts.gov" },
  { code: "US-CA-9", name: "United States Court of Appeals for the Ninth Circuit", shortName: "9th Cir.", jurisdictionCode: "US", courtType: "appellate", district: "9th Circuit", website: "https://www.ca9.uscourts.gov" },
  { code: "US-CA-10", name: "United States Court of Appeals for the Tenth Circuit", shortName: "10th Cir.", jurisdictionCode: "US", courtType: "appellate", district: "10th Circuit", website: "https://www.ca10.uscourts.gov" },
  { code: "US-CA-11", name: "United States Court of Appeals for the Eleventh Circuit", shortName: "11th Cir.", jurisdictionCode: "US", courtType: "appellate", district: "11th Circuit", website: "https://www.ca11.uscourts.gov" },
  { code: "US-CA-DC", name: "United States Court of Appeals for the District of Columbia Circuit", shortName: "D.C. Cir.", jurisdictionCode: "US", courtType: "appellate", district: "DC Circuit", website: "https://www.cadc.uscourts.gov" },
  { code: "US-CA-FED", name: "United States Court of Appeals for the Federal Circuit", shortName: "Fed. Cir.", jurisdictionCode: "US", courtType: "appellate", district: "Federal Circuit", website: "https://cafc.uscourts.gov" },

  // ── 94 US District Courts ─────────────────────────────────────────────
  // Listed in state-alphabetical order. Each entry's jurisdictionCode is
  // the state the district sits in. Naming follows the official USCourts.gov
  // list and standard Bluebook reporter abbreviations.

  // Alabama (3)
  { code: "US-ALN", name: "United States District Court for the Northern District of Alabama", shortName: "N.D. Ala.", jurisdictionCode: "US-AL", courtType: "trial", district: "Northern District" },
  { code: "US-ALM", name: "United States District Court for the Middle District of Alabama", shortName: "M.D. Ala.", jurisdictionCode: "US-AL", courtType: "trial", district: "Middle District" },
  { code: "US-ALS", name: "United States District Court for the Southern District of Alabama", shortName: "S.D. Ala.", jurisdictionCode: "US-AL", courtType: "trial", district: "Southern District" },
  // Alaska (1)
  { code: "US-AK", name: "United States District Court for the District of Alaska", shortName: "D. Alaska", jurisdictionCode: "US-AK", courtType: "trial", district: "District of Alaska" },
  // Arizona (1)
  { code: "US-AZD", name: "United States District Court for the District of Arizona", shortName: "D. Ariz.", jurisdictionCode: "US-AZ", courtType: "trial", district: "District of Arizona" },
  // Arkansas (2)
  { code: "US-ARE", name: "United States District Court for the Eastern District of Arkansas", shortName: "E.D. Ark.", jurisdictionCode: "US-AR", courtType: "trial", district: "Eastern District" },
  { code: "US-ARW", name: "United States District Court for the Western District of Arkansas", shortName: "W.D. Ark.", jurisdictionCode: "US-AR", courtType: "trial", district: "Western District" },
  // California (4)
  { code: "US-CAN", name: "United States District Court for the Northern District of California", shortName: "N.D. Cal.", jurisdictionCode: "US-CA", courtType: "trial", district: "Northern District" },
  { code: "US-CAE", name: "United States District Court for the Eastern District of California", shortName: "E.D. Cal.", jurisdictionCode: "US-CA", courtType: "trial", district: "Eastern District" },
  { code: "US-CAC", name: "United States District Court for the Central District of California", shortName: "C.D. Cal.", jurisdictionCode: "US-CA", courtType: "trial", district: "Central District" },
  { code: "US-CAS", name: "United States District Court for the Southern District of California", shortName: "S.D. Cal.", jurisdictionCode: "US-CA", courtType: "trial", district: "Southern District" },
  // Colorado (1)
  { code: "US-COD", name: "United States District Court for the District of Colorado", shortName: "D. Colo.", jurisdictionCode: "US-CO", courtType: "trial", district: "District of Colorado" },
  // Connecticut (1)
  { code: "US-CTD", name: "United States District Court for the District of Connecticut", shortName: "D. Conn.", jurisdictionCode: "US-CT", courtType: "trial", district: "District of Connecticut" },
  // Delaware (1)
  { code: "US-DED", name: "United States District Court for the District of Delaware", shortName: "D. Del.", jurisdictionCode: "US-DE", courtType: "trial", district: "District of Delaware" },
  // District of Columbia (1)
  { code: "US-DCD", name: "United States District Court for the District of Columbia", shortName: "D.D.C.", jurisdictionCode: "US-DC", courtType: "trial", district: "District of Columbia" },
  // Florida (3)
  { code: "US-FLN", name: "United States District Court for the Northern District of Florida", shortName: "N.D. Fla.", jurisdictionCode: "US-FL", courtType: "trial", district: "Northern District" },
  { code: "US-FLM", name: "United States District Court for the Middle District of Florida", shortName: "M.D. Fla.", jurisdictionCode: "US-FL", courtType: "trial", district: "Middle District" },
  { code: "US-FLS", name: "United States District Court for the Southern District of Florida", shortName: "S.D. Fla.", jurisdictionCode: "US-FL", courtType: "trial", district: "Southern District" },
  // Georgia (3)
  { code: "US-GAN", name: "United States District Court for the Northern District of Georgia", shortName: "N.D. Ga.", jurisdictionCode: "US-GA", courtType: "trial", district: "Northern District" },
  { code: "US-GAM", name: "United States District Court for the Middle District of Georgia", shortName: "M.D. Ga.", jurisdictionCode: "US-GA", courtType: "trial", district: "Middle District" },
  { code: "US-GAS", name: "United States District Court for the Southern District of Georgia", shortName: "S.D. Ga.", jurisdictionCode: "US-GA", courtType: "trial", district: "Southern District" },
  // Hawaii (1)
  { code: "US-HID", name: "United States District Court for the District of Hawaii", shortName: "D. Haw.", jurisdictionCode: "US-HI", courtType: "trial", district: "District of Hawaii" },
  // Idaho (1)
  { code: "US-IDD", name: "United States District Court for the District of Idaho", shortName: "D. Idaho", jurisdictionCode: "US-ID", courtType: "trial", district: "District of Idaho" },
  // Illinois (3)
  { code: "US-ILN", name: "United States District Court for the Northern District of Illinois", shortName: "N.D. Ill.", jurisdictionCode: "US-IL", courtType: "trial", district: "Northern District" },
  { code: "US-ILC", name: "United States District Court for the Central District of Illinois", shortName: "C.D. Ill.", jurisdictionCode: "US-IL", courtType: "trial", district: "Central District" },
  { code: "US-ILS", name: "United States District Court for the Southern District of Illinois", shortName: "S.D. Ill.", jurisdictionCode: "US-IL", courtType: "trial", district: "Southern District" },
  // Indiana (2)
  { code: "US-INN", name: "United States District Court for the Northern District of Indiana", shortName: "N.D. Ind.", jurisdictionCode: "US-IN", courtType: "trial", district: "Northern District" },
  { code: "US-INS", name: "United States District Court for the Southern District of Indiana", shortName: "S.D. Ind.", jurisdictionCode: "US-IN", courtType: "trial", district: "Southern District" },
  // Iowa (2)
  { code: "US-IAN", name: "United States District Court for the Northern District of Iowa", shortName: "N.D. Iowa", jurisdictionCode: "US-IA", courtType: "trial", district: "Northern District" },
  { code: "US-IAS", name: "United States District Court for the Southern District of Iowa", shortName: "S.D. Iowa", jurisdictionCode: "US-IA", courtType: "trial", district: "Southern District" },
  // Kansas (1)
  { code: "US-KSD", name: "United States District Court for the District of Kansas", shortName: "D. Kan.", jurisdictionCode: "US-KS", courtType: "trial", district: "District of Kansas" },
  // Kentucky (2)
  { code: "US-KYE", name: "United States District Court for the Eastern District of Kentucky", shortName: "E.D. Ky.", jurisdictionCode: "US-KY", courtType: "trial", district: "Eastern District" },
  { code: "US-KYW", name: "United States District Court for the Western District of Kentucky", shortName: "W.D. Ky.", jurisdictionCode: "US-KY", courtType: "trial", district: "Western District" },
  // Louisiana (3)
  { code: "US-LAE", name: "United States District Court for the Eastern District of Louisiana", shortName: "E.D. La.", jurisdictionCode: "US-LA", courtType: "trial", district: "Eastern District" },
  { code: "US-LAM", name: "United States District Court for the Middle District of Louisiana", shortName: "M.D. La.", jurisdictionCode: "US-LA", courtType: "trial", district: "Middle District" },
  { code: "US-LAW", name: "United States District Court for the Western District of Louisiana", shortName: "W.D. La.", jurisdictionCode: "US-LA", courtType: "trial", district: "Western District" },
  // Maine (1)
  { code: "US-MED", name: "United States District Court for the District of Maine", shortName: "D. Me.", jurisdictionCode: "US-ME", courtType: "trial", district: "District of Maine" },
  // Maryland (1)
  { code: "US-MDD", name: "United States District Court for the District of Maryland", shortName: "D. Md.", jurisdictionCode: "US-MD", courtType: "trial", district: "District of Maryland" },
  // Massachusetts (1)
  { code: "US-MAD", name: "United States District Court for the District of Massachusetts", shortName: "D. Mass.", jurisdictionCode: "US-MA", courtType: "trial", district: "District of Massachusetts" },
  // Michigan (2)
  { code: "US-MIE", name: "United States District Court for the Eastern District of Michigan", shortName: "E.D. Mich.", jurisdictionCode: "US-MI", courtType: "trial", district: "Eastern District" },
  { code: "US-MIW", name: "United States District Court for the Western District of Michigan", shortName: "W.D. Mich.", jurisdictionCode: "US-MI", courtType: "trial", district: "Western District" },
  // Minnesota (1)
  { code: "US-MND", name: "United States District Court for the District of Minnesota", shortName: "D. Minn.", jurisdictionCode: "US-MN", courtType: "trial", district: "District of Minnesota" },
  // Mississippi (2)
  { code: "US-MSN", name: "United States District Court for the Northern District of Mississippi", shortName: "N.D. Miss.", jurisdictionCode: "US-MS", courtType: "trial", district: "Northern District" },
  { code: "US-MSS", name: "United States District Court for the Southern District of Mississippi", shortName: "S.D. Miss.", jurisdictionCode: "US-MS", courtType: "trial", district: "Southern District" },
  // Missouri (2)
  { code: "US-MOE", name: "United States District Court for the Eastern District of Missouri", shortName: "E.D. Mo.", jurisdictionCode: "US-MO", courtType: "trial", district: "Eastern District" },
  { code: "US-MOW", name: "United States District Court for the Western District of Missouri", shortName: "W.D. Mo.", jurisdictionCode: "US-MO", courtType: "trial", district: "Western District" },
  // Montana (1)
  { code: "US-MTD", name: "United States District Court for the District of Montana", shortName: "D. Mont.", jurisdictionCode: "US-MT", courtType: "trial", district: "District of Montana" },
  // Nebraska (1)
  { code: "US-NED", name: "United States District Court for the District of Nebraska", shortName: "D. Neb.", jurisdictionCode: "US-NE", courtType: "trial", district: "District of Nebraska" },
  // Nevada (1)
  { code: "US-NVD", name: "United States District Court for the District of Nevada", shortName: "D. Nev.", jurisdictionCode: "US-NV", courtType: "trial", district: "District of Nevada" },
  // New Hampshire (1)
  { code: "US-NHD", name: "United States District Court for the District of New Hampshire", shortName: "D.N.H.", jurisdictionCode: "US-NH", courtType: "trial", district: "District of New Hampshire" },
  // New Jersey (1)
  { code: "US-NJD", name: "United States District Court for the District of New Jersey", shortName: "D.N.J.", jurisdictionCode: "US-NJ", courtType: "trial", district: "District of New Jersey" },
  // New Mexico (1)
  { code: "US-NMD", name: "United States District Court for the District of New Mexico", shortName: "D.N.M.", jurisdictionCode: "US-NM", courtType: "trial", district: "District of New Mexico" },
  // New York (4)
  { code: "US-NYN", name: "United States District Court for the Northern District of New York", shortName: "N.D.N.Y.", jurisdictionCode: "US-NY", courtType: "trial", district: "Northern District" },
  { code: "US-NYE", name: "United States District Court for the Eastern District of New York", shortName: "E.D.N.Y.", jurisdictionCode: "US-NY", courtType: "trial", district: "Eastern District" },
  { code: "US-NYS", name: "United States District Court for the Southern District of New York", shortName: "S.D.N.Y.", jurisdictionCode: "US-NY", courtType: "trial", district: "Southern District" },
  { code: "US-NYW", name: "United States District Court for the Western District of New York", shortName: "W.D.N.Y.", jurisdictionCode: "US-NY", courtType: "trial", district: "Western District" },
  // North Carolina (3)
  { code: "US-NCE", name: "United States District Court for the Eastern District of North Carolina", shortName: "E.D.N.C.", jurisdictionCode: "US-NC", courtType: "trial", district: "Eastern District" },
  { code: "US-NCM", name: "United States District Court for the Middle District of North Carolina", shortName: "M.D.N.C.", jurisdictionCode: "US-NC", courtType: "trial", district: "Middle District" },
  { code: "US-NCW", name: "United States District Court for the Western District of North Carolina", shortName: "W.D.N.C.", jurisdictionCode: "US-NC", courtType: "trial", district: "Western District" },
  // North Dakota (1)
  { code: "US-NDD", name: "United States District Court for the District of North Dakota", shortName: "D.N.D.", jurisdictionCode: "US-ND", courtType: "trial", district: "District of North Dakota" },
  // Ohio (2)
  { code: "US-OHN", name: "United States District Court for the Northern District of Ohio", shortName: "N.D. Ohio", jurisdictionCode: "US-OH", courtType: "trial", district: "Northern District" },
  { code: "US-OHS", name: "United States District Court for the Southern District of Ohio", shortName: "S.D. Ohio", jurisdictionCode: "US-OH", courtType: "trial", district: "Southern District" },
  // Oklahoma (3)
  { code: "US-OKN", name: "United States District Court for the Northern District of Oklahoma", shortName: "N.D. Okla.", jurisdictionCode: "US-OK", courtType: "trial", district: "Northern District" },
  { code: "US-OKE", name: "United States District Court for the Eastern District of Oklahoma", shortName: "E.D. Okla.", jurisdictionCode: "US-OK", courtType: "trial", district: "Eastern District" },
  { code: "US-OKW", name: "United States District Court for the Western District of Oklahoma", shortName: "W.D. Okla.", jurisdictionCode: "US-OK", courtType: "trial", district: "Western District" },
  // Oregon (1)
  { code: "US-ORD", name: "United States District Court for the District of Oregon", shortName: "D. Or.", jurisdictionCode: "US-OR", courtType: "trial", district: "District of Oregon" },
  // Pennsylvania (3)
  { code: "US-PAE", name: "United States District Court for the Eastern District of Pennsylvania", shortName: "E.D. Pa.", jurisdictionCode: "US-PA", courtType: "trial", district: "Eastern District" },
  { code: "US-PAM", name: "United States District Court for the Middle District of Pennsylvania", shortName: "M.D. Pa.", jurisdictionCode: "US-PA", courtType: "trial", district: "Middle District" },
  { code: "US-PAW", name: "United States District Court for the Western District of Pennsylvania", shortName: "W.D. Pa.", jurisdictionCode: "US-PA", courtType: "trial", district: "Western District" },
  // Rhode Island (1)
  { code: "US-RID", name: "United States District Court for the District of Rhode Island", shortName: "D.R.I.", jurisdictionCode: "US-RI", courtType: "trial", district: "District of Rhode Island" },
  // South Carolina (1)
  { code: "US-SCD", name: "United States District Court for the District of South Carolina", shortName: "D.S.C.", jurisdictionCode: "US-SC", courtType: "trial", district: "District of South Carolina" },
  // South Dakota (1)
  { code: "US-SDD", name: "United States District Court for the District of South Dakota", shortName: "D.S.D.", jurisdictionCode: "US-SD", courtType: "trial", district: "District of South Dakota" },
  // Tennessee (3)
  { code: "US-TNE", name: "United States District Court for the Eastern District of Tennessee", shortName: "E.D. Tenn.", jurisdictionCode: "US-TN", courtType: "trial", district: "Eastern District" },
  { code: "US-TNM", name: "United States District Court for the Middle District of Tennessee", shortName: "M.D. Tenn.", jurisdictionCode: "US-TN", courtType: "trial", district: "Middle District" },
  { code: "US-TNW", name: "United States District Court for the Western District of Tennessee", shortName: "W.D. Tenn.", jurisdictionCode: "US-TN", courtType: "trial", district: "Western District" },
  // Texas (4)
  { code: "US-TXN", name: "United States District Court for the Northern District of Texas", shortName: "N.D. Tex.", jurisdictionCode: "US-TX", courtType: "trial", district: "Northern District" },
  { code: "US-TXE", name: "United States District Court for the Eastern District of Texas", shortName: "E.D. Tex.", jurisdictionCode: "US-TX", courtType: "trial", district: "Eastern District" },
  { code: "US-TXS", name: "United States District Court for the Southern District of Texas", shortName: "S.D. Tex.", jurisdictionCode: "US-TX", courtType: "trial", district: "Southern District" },
  { code: "US-TXW", name: "United States District Court for the Western District of Texas", shortName: "W.D. Tex.", jurisdictionCode: "US-TX", courtType: "trial", district: "Western District" },
  // Utah (1)
  { code: "US-UTD", name: "United States District Court for the District of Utah", shortName: "D. Utah", jurisdictionCode: "US-UT", courtType: "trial", district: "District of Utah" },
  // Vermont (1)
  { code: "US-VTD", name: "United States District Court for the District of Vermont", shortName: "D. Vt.", jurisdictionCode: "US-VT", courtType: "trial", district: "District of Vermont" },
  // Virginia (2)
  { code: "US-VAE", name: "United States District Court for the Eastern District of Virginia", shortName: "E.D. Va.", jurisdictionCode: "US-VA", courtType: "trial", district: "Eastern District" },
  { code: "US-VAW", name: "United States District Court for the Western District of Virginia", shortName: "W.D. Va.", jurisdictionCode: "US-VA", courtType: "trial", district: "Western District" },
  // Washington (2)
  { code: "US-WAE", name: "United States District Court for the Eastern District of Washington", shortName: "E.D. Wash.", jurisdictionCode: "US-WA", courtType: "trial", district: "Eastern District" },
  { code: "US-WAW", name: "United States District Court for the Western District of Washington", shortName: "W.D. Wash.", jurisdictionCode: "US-WA", courtType: "trial", district: "Western District" },
  // West Virginia (2)
  { code: "US-WVN", name: "United States District Court for the Northern District of West Virginia", shortName: "N.D.W. Va.", jurisdictionCode: "US-WV", courtType: "trial", district: "Northern District" },
  { code: "US-WVS", name: "United States District Court for the Southern District of West Virginia", shortName: "S.D.W. Va.", jurisdictionCode: "US-WV", courtType: "trial", district: "Southern District" },
  // Wisconsin (2)
  { code: "US-WIE", name: "United States District Court for the Eastern District of Wisconsin", shortName: "E.D. Wis.", jurisdictionCode: "US-WI", courtType: "trial", district: "Eastern District" },
  { code: "US-WIW", name: "United States District Court for the Western District of Wisconsin", shortName: "W.D. Wis.", jurisdictionCode: "US-WI", courtType: "trial", district: "Western District" },
  // Wyoming (1)
  { code: "US-WYD", name: "United States District Court for the District of Wyoming", shortName: "D. Wyo.", jurisdictionCode: "US-WY", courtType: "trial", district: "District of Wyoming" },
  // Puerto Rico (1)
  { code: "US-PRD", name: "United States District Court for the District of Puerto Rico", shortName: "D.P.R.", jurisdictionCode: "US-PR", courtType: "trial", district: "District of Puerto Rico" },
  // Territorial District Courts (Article IV — also part of the 94)
  { code: "US-GUD", name: "United States District Court for the District of Guam", shortName: "D. Guam", jurisdictionCode: "US-GU", courtType: "trial", district: "District of Guam" },
  { code: "US-VID", name: "United States District Court of the Virgin Islands", shortName: "D.V.I.", jurisdictionCode: "US-VI", courtType: "trial", district: "District of the Virgin Islands" },
  { code: "US-MPD", name: "United States District Court for the Northern Mariana Islands", shortName: "D.N. Mar. I.", jurisdictionCode: "US-MP", courtType: "trial", district: "District of the Northern Mariana Islands" },

  // ── Specialty federal courts ──────────────────────────────────────────
  { code: "US-CIT", name: "United States Court of International Trade", shortName: "Ct. Int'l Trade", jurisdictionCode: "US", courtType: "specialty", website: "https://www.cit.uscourts.gov" },
  { code: "US-CFC", name: "United States Court of Federal Claims", shortName: "Fed. Cl.", jurisdictionCode: "US", courtType: "specialty", website: "https://www.uscfc.uscourts.gov" },
  { code: "US-TC", name: "United States Tax Court", shortName: "T.C.", jurisdictionCode: "US", courtType: "specialty", website: "https://www.ustaxcourt.gov" },
  { code: "US-CAAF", name: "United States Court of Appeals for the Armed Forces", shortName: "C.A.A.F.", jurisdictionCode: "US", courtType: "specialty", website: "https://www.armfor.uscourts.gov" },
  { code: "US-CAVC", name: "United States Court of Appeals for Veterans Claims", shortName: "Vet. App.", jurisdictionCode: "US", courtType: "specialty", website: "https://www.uscourts.cavc.gov" },
  { code: "US-FISC", name: "United States Foreign Intelligence Surveillance Court", shortName: "FISC", jurisdictionCode: "US", courtType: "specialty" },
  { code: "US-JPML", name: "United States Judicial Panel on Multidistrict Litigation", shortName: "JPML", jurisdictionCode: "US", courtType: "specialty" },

  // ── Notable bankruptcy courts (one per Texas district as an example) ──
  { code: "US-TXNB", name: "United States Bankruptcy Court for the Northern District of Texas", shortName: "Bankr. N.D. Tex.", jurisdictionCode: "US-TX", courtType: "bankruptcy", district: "Northern District" },
  { code: "US-TXSB", name: "United States Bankruptcy Court for the Southern District of Texas", shortName: "Bankr. S.D. Tex.", jurisdictionCode: "US-TX", courtType: "bankruptcy", district: "Southern District" },
  { code: "US-TXEB", name: "United States Bankruptcy Court for the Eastern District of Texas", shortName: "Bankr. E.D. Tex.", jurisdictionCode: "US-TX", courtType: "bankruptcy", district: "Eastern District" },
  { code: "US-TXWB", name: "United States Bankruptcy Court for the Western District of Texas", shortName: "Bankr. W.D. Tex.", jurisdictionCode: "US-TX", courtType: "bankruptcy", district: "Western District" },
  { code: "US-DEB", name: "United States Bankruptcy Court for the District of Delaware", shortName: "Bankr. D. Del.", jurisdictionCode: "US-DE", courtType: "bankruptcy", district: "District of Delaware" },
  { code: "US-NYSB", name: "United States Bankruptcy Court for the Southern District of New York", shortName: "Bankr. S.D.N.Y.", jurisdictionCode: "US-NY", courtType: "bankruptcy", district: "Southern District" },

  // ═══════════════════════════════════════════════════════════════════════
  // STATE COURTS — Highest courts ("supreme") of all 50 states + DC
  // ═══════════════════════════════════════════════════════════════════════

  { code: "AL-SC", name: "Supreme Court of Alabama", jurisdictionCode: "US-AL", courtType: "supreme" },
  { code: "AK-SC", name: "Supreme Court of Alaska", jurisdictionCode: "US-AK", courtType: "supreme" },
  { code: "AZ-SC", name: "Arizona Supreme Court", jurisdictionCode: "US-AZ", courtType: "supreme" },
  { code: "AR-SC", name: "Supreme Court of Arkansas", jurisdictionCode: "US-AR", courtType: "supreme" },
  { code: "CA-SC", name: "Supreme Court of California", jurisdictionCode: "US-CA", courtType: "supreme" },
  { code: "CO-SC", name: "Colorado Supreme Court", jurisdictionCode: "US-CO", courtType: "supreme" },
  { code: "CT-SC", name: "Connecticut Supreme Court", jurisdictionCode: "US-CT", courtType: "supreme" },
  { code: "DE-SC", name: "Supreme Court of Delaware", jurisdictionCode: "US-DE", courtType: "supreme" },
  { code: "FL-SC", name: "Supreme Court of Florida", jurisdictionCode: "US-FL", courtType: "supreme" },
  { code: "GA-SC", name: "Supreme Court of Georgia", jurisdictionCode: "US-GA", courtType: "supreme" },
  { code: "HI-SC", name: "Supreme Court of Hawaii", jurisdictionCode: "US-HI", courtType: "supreme" },
  { code: "ID-SC", name: "Idaho Supreme Court", jurisdictionCode: "US-ID", courtType: "supreme" },
  { code: "IL-SC", name: "Supreme Court of Illinois", jurisdictionCode: "US-IL", courtType: "supreme" },
  { code: "IN-SC", name: "Indiana Supreme Court", jurisdictionCode: "US-IN", courtType: "supreme" },
  { code: "IA-SC", name: "Iowa Supreme Court", jurisdictionCode: "US-IA", courtType: "supreme" },
  { code: "KS-SC", name: "Kansas Supreme Court", jurisdictionCode: "US-KS", courtType: "supreme" },
  { code: "KY-SC", name: "Supreme Court of Kentucky", jurisdictionCode: "US-KY", courtType: "supreme" },
  { code: "LA-SC", name: "Supreme Court of Louisiana", jurisdictionCode: "US-LA", courtType: "supreme" },
  { code: "ME-SC", name: "Maine Supreme Judicial Court", jurisdictionCode: "US-ME", courtType: "supreme" },
  { code: "MD-SC", name: "Supreme Court of Maryland", jurisdictionCode: "US-MD", courtType: "supreme" },
  { code: "MA-SC", name: "Massachusetts Supreme Judicial Court", jurisdictionCode: "US-MA", courtType: "supreme" },
  { code: "MI-SC", name: "Michigan Supreme Court", jurisdictionCode: "US-MI", courtType: "supreme" },
  { code: "MN-SC", name: "Minnesota Supreme Court", jurisdictionCode: "US-MN", courtType: "supreme" },
  { code: "MS-SC", name: "Supreme Court of Mississippi", jurisdictionCode: "US-MS", courtType: "supreme" },
  { code: "MO-SC", name: "Supreme Court of Missouri", jurisdictionCode: "US-MO", courtType: "supreme" },
  { code: "MT-SC", name: "Montana Supreme Court", jurisdictionCode: "US-MT", courtType: "supreme" },
  { code: "NE-SC", name: "Nebraska Supreme Court", jurisdictionCode: "US-NE", courtType: "supreme" },
  { code: "NV-SC", name: "Supreme Court of Nevada", jurisdictionCode: "US-NV", courtType: "supreme" },
  { code: "NH-SC", name: "New Hampshire Supreme Court", jurisdictionCode: "US-NH", courtType: "supreme" },
  { code: "NJ-SC", name: "Supreme Court of New Jersey", jurisdictionCode: "US-NJ", courtType: "supreme" },
  { code: "NM-SC", name: "New Mexico Supreme Court", jurisdictionCode: "US-NM", courtType: "supreme" },
  { code: "NY-COA", name: "New York Court of Appeals", jurisdictionCode: "US-NY", courtType: "supreme" },
  { code: "NC-SC", name: "Supreme Court of North Carolina", jurisdictionCode: "US-NC", courtType: "supreme" },
  { code: "ND-SC", name: "North Dakota Supreme Court", jurisdictionCode: "US-ND", courtType: "supreme" },
  { code: "OH-SC", name: "Supreme Court of Ohio", jurisdictionCode: "US-OH", courtType: "supreme" },
  { code: "OK-SC", name: "Oklahoma Supreme Court", jurisdictionCode: "US-OK", courtType: "supreme" },
  { code: "OK-CCA", name: "Oklahoma Court of Criminal Appeals", jurisdictionCode: "US-OK", courtType: "supreme" },
  { code: "OR-SC", name: "Oregon Supreme Court", jurisdictionCode: "US-OR", courtType: "supreme" },
  { code: "PA-SC", name: "Supreme Court of Pennsylvania", jurisdictionCode: "US-PA", courtType: "supreme" },
  { code: "RI-SC", name: "Rhode Island Supreme Court", jurisdictionCode: "US-RI", courtType: "supreme" },
  { code: "SC-SC", name: "South Carolina Supreme Court", jurisdictionCode: "US-SC", courtType: "supreme" },
  { code: "SD-SC", name: "South Dakota Supreme Court", jurisdictionCode: "US-SD", courtType: "supreme" },
  { code: "TN-SC", name: "Supreme Court of Tennessee", jurisdictionCode: "US-TN", courtType: "supreme" },
  { code: "TX-SC", name: "Supreme Court of Texas", shortName: "Tex.", jurisdictionCode: "US-TX", courtType: "supreme", website: "https://www.txcourts.gov/supreme/" },
  { code: "TX-CCA", name: "Texas Court of Criminal Appeals", shortName: "Tex. Crim. App.", jurisdictionCode: "US-TX", courtType: "supreme", website: "https://www.txcourts.gov/cca/" },
  { code: "UT-SC", name: "Utah Supreme Court", jurisdictionCode: "US-UT", courtType: "supreme" },
  { code: "VT-SC", name: "Vermont Supreme Court", jurisdictionCode: "US-VT", courtType: "supreme" },
  { code: "VA-SC", name: "Supreme Court of Virginia", jurisdictionCode: "US-VA", courtType: "supreme" },
  { code: "WA-SC", name: "Washington Supreme Court", jurisdictionCode: "US-WA", courtType: "supreme" },
  { code: "WV-SC", name: "Supreme Court of Appeals of West Virginia", jurisdictionCode: "US-WV", courtType: "supreme" },
  { code: "WI-SC", name: "Wisconsin Supreme Court", jurisdictionCode: "US-WI", courtType: "supreme" },
  { code: "WY-SC", name: "Wyoming Supreme Court", jurisdictionCode: "US-WY", courtType: "supreme" },
  { code: "DC-COA", name: "District of Columbia Court of Appeals", jurisdictionCode: "US-DC", courtType: "supreme" },

  // ═══════════════════════════════════════════════════════════════════════
  // TEXAS — deep coverage (user's caseload is Texas family/appellate)
  // ═══════════════════════════════════════════════════════════════════════

  // ── 14 Texas Courts of Appeals (intermediate appellate, 1st–14th) ──────
  { code: "TX-APP-1", name: "First Court of Appeals of Texas", shortName: "Tex. App. (1st)", jurisdictionCode: "US-TX", courtType: "appellate", district: "1st", address: "Houston, TX" },
  { code: "TX-APP-2", name: "Second Court of Appeals of Texas", shortName: "Tex. App. (2d)", jurisdictionCode: "US-TX", courtType: "appellate", district: "2nd", address: "Fort Worth, TX" },
  { code: "TX-APP-3", name: "Third Court of Appeals of Texas", shortName: "Tex. App. (3d)", jurisdictionCode: "US-TX", courtType: "appellate", district: "3rd", address: "Austin, TX" },
  { code: "TX-APP-4", name: "Fourth Court of Appeals of Texas", shortName: "Tex. App. (4th)", jurisdictionCode: "US-TX", courtType: "appellate", district: "4th", address: "San Antonio, TX" },
  { code: "TX-APP-5", name: "Fifth Court of Appeals of Texas", shortName: "Tex. App. (5th)", jurisdictionCode: "US-TX", courtType: "appellate", district: "5th", address: "Dallas, TX" },
  { code: "TX-APP-6", name: "Sixth Court of Appeals of Texas", shortName: "Tex. App. (6th)", jurisdictionCode: "US-TX", courtType: "appellate", district: "6th", address: "Texarkana, TX" },
  { code: "TX-APP-7", name: "Seventh Court of Appeals of Texas", shortName: "Tex. App. (7th)", jurisdictionCode: "US-TX", courtType: "appellate", district: "7th", address: "Amarillo, TX" },
  { code: "TX-APP-8", name: "Eighth Court of Appeals of Texas", shortName: "Tex. App. (8th)", jurisdictionCode: "US-TX", courtType: "appellate", district: "8th", address: "El Paso, TX" },
  { code: "TX-APP-9", name: "Ninth Court of Appeals of Texas", shortName: "Tex. App. (9th)", jurisdictionCode: "US-TX", courtType: "appellate", district: "9th", address: "Beaumont, TX" },
  { code: "TX-APP-10", name: "Tenth Court of Appeals of Texas", shortName: "Tex. App. (10th)", jurisdictionCode: "US-TX", courtType: "appellate", district: "10th", address: "Waco, TX" },
  { code: "TX-APP-11", name: "Eleventh Court of Appeals of Texas", shortName: "Tex. App. (11th)", jurisdictionCode: "US-TX", courtType: "appellate", district: "11th", address: "Eastland, TX" },
  { code: "TX-APP-12", name: "Twelfth Court of Appeals of Texas", shortName: "Tex. App. (12th)", jurisdictionCode: "US-TX", courtType: "appellate", district: "12th", address: "Tyler, TX" },
  { code: "TX-APP-13", name: "Thirteenth Court of Appeals of Texas", shortName: "Tex. App. (13th)", jurisdictionCode: "US-TX", courtType: "appellate", district: "13th", address: "Corpus Christi-Edinburg, TX" },
  { code: "TX-APP-14", name: "Fourteenth Court of Appeals of Texas", shortName: "Tex. App. (14th)", jurisdictionCode: "US-TX", courtType: "appellate", district: "14th", address: "Houston, TX" },

  // ── Travis County trial courts ────────────────────────────────────────
  // Travis has District Courts in the 53rd, 98th, 126th, 200th, 201st, 250th,
  // 261st, 299th, 331st, 345th, 353rd, 419th, 427th, 455th, 459th, plus the
  // 53rd Civil, the 98th Civil, Family Court 408th (none — Travis uses
  // associate judges); we list the numbered District Courts that sit in Travis.
  { code: "TX-DC-53", name: "53rd District Court of Travis County", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "53rd" },
  { code: "TX-DC-98", name: "98th District Court of Travis County", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "98th" },
  { code: "TX-DC-126", name: "126th District Court of Travis County", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "126th" },
  { code: "TX-DC-200", name: "200th District Court of Travis County", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "200th" },
  { code: "TX-DC-201", name: "201st District Court of Travis County", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "201st" },
  { code: "TX-DC-250", name: "250th District Court of Travis County", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "250th" },
  { code: "TX-DC-261", name: "261st District Court of Travis County", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "261st" },
  { code: "TX-DC-299", name: "299th District Court of Travis County", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "299th" },
  { code: "TX-DC-331", name: "331st District Court of Travis County", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "331st" },
  { code: "TX-DC-345", name: "345th District Court of Travis County", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "345th" },
  { code: "TX-DC-353", name: "353rd District Court of Travis County", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "353rd" },
  { code: "TX-DC-419", name: "419th District Court of Travis County", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "419th" },
  { code: "TX-DC-427", name: "427th District Court of Travis County", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "427th" },
  { code: "TX-DC-455", name: "455th District Court of Travis County", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "455th" },
  { code: "TX-DC-459", name: "459th District Court of Travis County", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "459th" },
  // Travis County Courts at Law (statutory county courts — handle family, civil, criminal)
  { code: "TX-CCL-1-TRAVIS", name: "Travis County Court at Law No. 1", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "Court at Law No. 1" },
  { code: "TX-CCL-2-TRAVIS", name: "Travis County Court at Law No. 2", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "Court at Law No. 2" },
  { code: "TX-CCL-3-TRAVIS", name: "Travis County Court at Law No. 3", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "Court at Law No. 3" },
  { code: "TX-CCL-4-TRAVIS", name: "Travis County Court at Law No. 4", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "Court at Law No. 4" },
  { code: "TX-CCL-5-TRAVIS", name: "Travis County Court at Law No. 5", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "Court at Law No. 5" },
  { code: "TX-CCL-6-TRAVIS", name: "Travis County Court at Law No. 6", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "Court at Law No. 6" },
  { code: "TX-CCL-7-TRAVIS", name: "Travis County Court at Law No. 7", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "Court at Law No. 7" },
  { code: "TX-CCL-8-TRAVIS", name: "Travis County Court at Law No. 8", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "Court at Law No. 8" },
  // Travis County Probate Court
  { code: "TX-PROBATE-1-TRAVIS", name: "Travis County Probate Court No. 1", jurisdictionCode: "US-TX-TRAVIS", courtType: "trial", district: "Probate Court No. 1" },

  // ── Williamson County trial courts (sampling) ─────────────────────────
  { code: "TX-DC-26", name: "26th District Court of Williamson County", jurisdictionCode: "US-TX-WILLIAMSON", courtType: "trial", district: "26th" },
  { code: "TX-DC-277", name: "277th District Court of Williamson County", jurisdictionCode: "US-TX-WILLIAMSON", courtType: "trial", district: "277th" },
  { code: "TX-DC-368", name: "368th District Court of Williamson County", jurisdictionCode: "US-TX-WILLIAMSON", courtType: "trial", district: "368th" },
  { code: "TX-DC-395", name: "395th District Court of Williamson County", jurisdictionCode: "US-TX-WILLIAMSON", courtType: "trial", district: "395th" },
  { code: "TX-DC-425", name: "425th District Court of Williamson County", jurisdictionCode: "US-TX-WILLIAMSON", courtType: "trial", district: "425th" },

  // ── Hays County trial courts ──────────────────────────────────────────
  { code: "TX-DC-22", name: "22nd District Court of Hays County", jurisdictionCode: "US-TX-HAYS", courtType: "trial", district: "22nd" },
  { code: "TX-DC-207", name: "207th District Court of Hays County", jurisdictionCode: "US-TX-HAYS", courtType: "trial", district: "207th" },
  { code: "TX-DC-274", name: "274th District Court of Hays County", jurisdictionCode: "US-TX-HAYS", courtType: "trial", district: "274th" },
  { code: "TX-DC-428", name: "428th District Court of Hays County", jurisdictionCode: "US-TX-HAYS", courtType: "trial", district: "428th" },
  { code: "TX-DC-453", name: "453rd District Court of Hays County", jurisdictionCode: "US-TX-HAYS", courtType: "trial", district: "453rd" },

  // ── Harris County sample (Houston, very large) ────────────────────────
  { code: "TX-DC-11-HARRIS", name: "11th District Court of Harris County", jurisdictionCode: "US-TX-HARRIS", courtType: "trial", district: "11th" },
  { code: "TX-DC-55-HARRIS", name: "55th District Court of Harris County", jurisdictionCode: "US-TX-HARRIS", courtType: "trial", district: "55th" },
  { code: "TX-DC-61-HARRIS", name: "61st District Court of Harris County", jurisdictionCode: "US-TX-HARRIS", courtType: "trial", district: "61st" },
  { code: "TX-DC-152-HARRIS", name: "152nd District Court of Harris County", jurisdictionCode: "US-TX-HARRIS", courtType: "trial", district: "152nd" },
  { code: "TX-DC-189-HARRIS", name: "189th District Court of Harris County", jurisdictionCode: "US-TX-HARRIS", courtType: "trial", district: "189th" },
  { code: "TX-DC-308-HARRIS", name: "308th District Court (Family) of Harris County", jurisdictionCode: "US-TX-HARRIS", courtType: "trial", district: "308th" },
  { code: "TX-DC-309-HARRIS", name: "309th District Court (Family) of Harris County", jurisdictionCode: "US-TX-HARRIS", courtType: "trial", district: "309th" },
  { code: "TX-DC-310-HARRIS", name: "310th District Court (Family) of Harris County", jurisdictionCode: "US-TX-HARRIS", courtType: "trial", district: "310th" },
  { code: "TX-DC-311-HARRIS", name: "311th District Court (Family) of Harris County", jurisdictionCode: "US-TX-HARRIS", courtType: "trial", district: "311th" },

  // ── Dallas County sample ──────────────────────────────────────────────
  { code: "TX-DC-14-DALLAS", name: "14th District Court of Dallas County", jurisdictionCode: "US-TX-DALLAS", courtType: "trial", district: "14th" },
  { code: "TX-DC-44-DALLAS", name: "44th District Court of Dallas County", jurisdictionCode: "US-TX-DALLAS", courtType: "trial", district: "44th" },
  { code: "TX-DC-101-DALLAS", name: "101st District Court of Dallas County", jurisdictionCode: "US-TX-DALLAS", courtType: "trial", district: "101st" },
  { code: "TX-DC-160-DALLAS", name: "160th District Court of Dallas County", jurisdictionCode: "US-TX-DALLAS", courtType: "trial", district: "160th" },
  { code: "TX-DC-254-DALLAS", name: "254th District Court (Family) of Dallas County", jurisdictionCode: "US-TX-DALLAS", courtType: "trial", district: "254th" },
  { code: "TX-DC-256-DALLAS", name: "256th District Court (Family) of Dallas County", jurisdictionCode: "US-TX-DALLAS", courtType: "trial", district: "256th" },
  { code: "TX-DC-301-DALLAS", name: "301st District Court (Family) of Dallas County", jurisdictionCode: "US-TX-DALLAS", courtType: "trial", district: "301st" },
  { code: "TX-DC-330-DALLAS", name: "330th District Court (Family) of Dallas County", jurisdictionCode: "US-TX-DALLAS", courtType: "trial", district: "330th" },

  // ── Bexar County sample (San Antonio) ─────────────────────────────────
  { code: "TX-DC-37-BEXAR", name: "37th District Court of Bexar County", jurisdictionCode: "US-TX-BEXAR", courtType: "trial", district: "37th" },
  { code: "TX-DC-45-BEXAR", name: "45th District Court of Bexar County", jurisdictionCode: "US-TX-BEXAR", courtType: "trial", district: "45th" },
  { code: "TX-DC-57-BEXAR", name: "57th District Court of Bexar County", jurisdictionCode: "US-TX-BEXAR", courtType: "trial", district: "57th" },
  { code: "TX-DC-73-BEXAR", name: "73rd District Court of Bexar County", jurisdictionCode: "US-TX-BEXAR", courtType: "trial", district: "73rd" },
  { code: "TX-DC-150-BEXAR", name: "150th District Court of Bexar County", jurisdictionCode: "US-TX-BEXAR", courtType: "trial", district: "150th" },
  { code: "TX-DC-285-BEXAR", name: "285th District Court of Bexar County", jurisdictionCode: "US-TX-BEXAR", courtType: "trial", district: "285th" },

  // ── Tarrant County sample (Fort Worth) ────────────────────────────────
  { code: "TX-DC-17-TARRANT", name: "17th District Court of Tarrant County", jurisdictionCode: "US-TX-TARRANT", courtType: "trial", district: "17th" },
  { code: "TX-DC-48-TARRANT", name: "48th District Court of Tarrant County", jurisdictionCode: "US-TX-TARRANT", courtType: "trial", district: "48th" },
  { code: "TX-DC-67-TARRANT", name: "67th District Court of Tarrant County", jurisdictionCode: "US-TX-TARRANT", courtType: "trial", district: "67th" },
  { code: "TX-DC-141-TARRANT", name: "141st District Court of Tarrant County", jurisdictionCode: "US-TX-TARRANT", courtType: "trial", district: "141st" },
  { code: "TX-DC-231-TARRANT", name: "231st District Court (Family) of Tarrant County", jurisdictionCode: "US-TX-TARRANT", courtType: "trial", district: "231st" },
  { code: "TX-DC-322-TARRANT", name: "322nd District Court (Family) of Tarrant County", jurisdictionCode: "US-TX-TARRANT", courtType: "trial", district: "322nd" },

  // ═══════════════════════════════════════════════════════════════════════
  // OTHER STATES — top-10-by-volume intermediate appellate courts
  // ═══════════════════════════════════════════════════════════════════════

  // California — Courts of Appeal (6 districts)
  { code: "CA-APP-1", name: "California Court of Appeal, First District", jurisdictionCode: "US-CA", courtType: "appellate", district: "1st" },
  { code: "CA-APP-2", name: "California Court of Appeal, Second District", jurisdictionCode: "US-CA", courtType: "appellate", district: "2nd" },
  { code: "CA-APP-3", name: "California Court of Appeal, Third District", jurisdictionCode: "US-CA", courtType: "appellate", district: "3rd" },
  { code: "CA-APP-4", name: "California Court of Appeal, Fourth District", jurisdictionCode: "US-CA", courtType: "appellate", district: "4th" },
  { code: "CA-APP-5", name: "California Court of Appeal, Fifth District", jurisdictionCode: "US-CA", courtType: "appellate", district: "5th" },
  { code: "CA-APP-6", name: "California Court of Appeal, Sixth District", jurisdictionCode: "US-CA", courtType: "appellate", district: "6th" },
  // California — Superior Courts (sample of big counties)
  { code: "CA-SUP-LA", name: "Superior Court of California, County of Los Angeles", jurisdictionCode: "US-CA-LOSANGELES", courtType: "trial" },
  { code: "CA-SUP-SF", name: "Superior Court of California, County of San Francisco", jurisdictionCode: "US-CA-SANFRANCISCO", courtType: "trial" },
  { code: "CA-SUP-SD", name: "Superior Court of California, County of San Diego", jurisdictionCode: "US-CA-SANDIEGO", courtType: "trial" },
  { code: "CA-SUP-OC", name: "Superior Court of California, County of Orange", jurisdictionCode: "US-CA-ORANGE", courtType: "trial" },
  { code: "CA-SUP-SCL", name: "Superior Court of California, County of Santa Clara", jurisdictionCode: "US-CA-SANTACLARA", courtType: "trial" },

  // New York — Appellate Division (4 departments)
  { code: "NY-APP-1", name: "Appellate Division of the Supreme Court, First Department", jurisdictionCode: "US-NY", courtType: "appellate", district: "1st Dept." },
  { code: "NY-APP-2", name: "Appellate Division of the Supreme Court, Second Department", jurisdictionCode: "US-NY", courtType: "appellate", district: "2nd Dept." },
  { code: "NY-APP-3", name: "Appellate Division of the Supreme Court, Third Department", jurisdictionCode: "US-NY", courtType: "appellate", district: "3rd Dept." },
  { code: "NY-APP-4", name: "Appellate Division of the Supreme Court, Fourth Department", jurisdictionCode: "US-NY", courtType: "appellate", district: "4th Dept." },
  { code: "NY-SUP-NY", name: "New York Supreme Court, New York County", jurisdictionCode: "US-NY-NEWYORK", courtType: "trial" },
  { code: "NY-SUP-KINGS", name: "New York Supreme Court, Kings County", jurisdictionCode: "US-NY-KINGS", courtType: "trial" },
  { code: "NY-SUP-QUEENS", name: "New York Supreme Court, Queens County", jurisdictionCode: "US-NY-QUEENS", courtType: "trial" },

  // Florida — District Courts of Appeal (6 districts)
  { code: "FL-APP-1", name: "Florida First District Court of Appeal", jurisdictionCode: "US-FL", courtType: "appellate", district: "1st" },
  { code: "FL-APP-2", name: "Florida Second District Court of Appeal", jurisdictionCode: "US-FL", courtType: "appellate", district: "2nd" },
  { code: "FL-APP-3", name: "Florida Third District Court of Appeal", jurisdictionCode: "US-FL", courtType: "appellate", district: "3rd" },
  { code: "FL-APP-4", name: "Florida Fourth District Court of Appeal", jurisdictionCode: "US-FL", courtType: "appellate", district: "4th" },
  { code: "FL-APP-5", name: "Florida Fifth District Court of Appeal", jurisdictionCode: "US-FL", courtType: "appellate", district: "5th" },
  { code: "FL-APP-6", name: "Florida Sixth District Court of Appeal", jurisdictionCode: "US-FL", courtType: "appellate", district: "6th" },

  // Illinois — Appellate Court (5 districts)
  { code: "IL-APP-1", name: "Illinois Appellate Court, First District", jurisdictionCode: "US-IL", courtType: "appellate", district: "1st" },
  { code: "IL-APP-2", name: "Illinois Appellate Court, Second District", jurisdictionCode: "US-IL", courtType: "appellate", district: "2nd" },
  { code: "IL-APP-3", name: "Illinois Appellate Court, Third District", jurisdictionCode: "US-IL", courtType: "appellate", district: "3rd" },
  { code: "IL-APP-4", name: "Illinois Appellate Court, Fourth District", jurisdictionCode: "US-IL", courtType: "appellate", district: "4th" },
  { code: "IL-APP-5", name: "Illinois Appellate Court, Fifth District", jurisdictionCode: "US-IL", courtType: "appellate", district: "5th" },

  // Ohio — Courts of Appeals (12 districts)
  { code: "OH-APP-1", name: "Ohio Court of Appeals, First District", jurisdictionCode: "US-OH", courtType: "appellate", district: "1st" },
  { code: "OH-APP-2", name: "Ohio Court of Appeals, Second District", jurisdictionCode: "US-OH", courtType: "appellate", district: "2nd" },
  { code: "OH-APP-8", name: "Ohio Court of Appeals, Eighth District", jurisdictionCode: "US-OH", courtType: "appellate", district: "8th" },
  { code: "OH-APP-10", name: "Ohio Court of Appeals, Tenth District", jurisdictionCode: "US-OH", courtType: "appellate", district: "10th" },

  // Pennsylvania — Superior Court + Commonwealth Court
  { code: "PA-SUP", name: "Superior Court of Pennsylvania", jurisdictionCode: "US-PA", courtType: "appellate" },
  { code: "PA-CMW", name: "Commonwealth Court of Pennsylvania", jurisdictionCode: "US-PA", courtType: "appellate" },

  // Michigan — Court of Appeals
  { code: "MI-APP", name: "Michigan Court of Appeals", jurisdictionCode: "US-MI", courtType: "appellate" },

  // New Jersey — Superior Court Appellate Division
  { code: "NJ-APP", name: "Superior Court of New Jersey, Appellate Division", jurisdictionCode: "US-NJ", courtType: "appellate" },

  // North Carolina — Court of Appeals
  { code: "NC-APP", name: "North Carolina Court of Appeals", jurisdictionCode: "US-NC", courtType: "appellate" },

  // Georgia — Court of Appeals
  { code: "GA-APP", name: "Court of Appeals of Georgia", jurisdictionCode: "US-GA", courtType: "appellate" },

  // Arizona — Court of Appeals (2 divisions)
  { code: "AZ-APP-1", name: "Arizona Court of Appeals, Division One", jurisdictionCode: "US-AZ", courtType: "appellate", district: "Div. 1" },
  { code: "AZ-APP-2", name: "Arizona Court of Appeals, Division Two", jurisdictionCode: "US-AZ", courtType: "appellate", district: "Div. 2" },

  // Washington — Court of Appeals (3 divisions)
  { code: "WA-APP-1", name: "Washington Court of Appeals, Division I", jurisdictionCode: "US-WA", courtType: "appellate", district: "Div. I" },
  { code: "WA-APP-2", name: "Washington Court of Appeals, Division II", jurisdictionCode: "US-WA", courtType: "appellate", district: "Div. II" },
  { code: "WA-APP-3", name: "Washington Court of Appeals, Division III", jurisdictionCode: "US-WA", courtType: "appellate", district: "Div. III" },

  // Massachusetts — Appeals Court
  { code: "MA-APP", name: "Massachusetts Appeals Court", jurisdictionCode: "US-MA", courtType: "appellate" },

  // Colorado — Court of Appeals
  { code: "CO-APP", name: "Colorado Court of Appeals", jurisdictionCode: "US-CO", courtType: "appellate" },

  // ── Top sample of trial courts in other major counties ────────────────
  { code: "IL-CIR-COOK", name: "Circuit Court of Cook County, Illinois", jurisdictionCode: "US-IL-COOK", courtType: "trial" },
  { code: "FL-CIR-MIAMIDADE", name: "Eleventh Judicial Circuit of Florida (Miami-Dade County)", jurisdictionCode: "US-FL-MIAMIDADE", courtType: "trial", district: "11th Judicial Circuit" },
  { code: "FL-CIR-BROWARD", name: "Seventeenth Judicial Circuit of Florida (Broward County)", jurisdictionCode: "US-FL-BROWARD", courtType: "trial", district: "17th Judicial Circuit" },
  { code: "FL-CIR-ORANGE", name: "Ninth Judicial Circuit of Florida (Orange County)", jurisdictionCode: "US-FL-ORANGE", courtType: "trial", district: "9th Judicial Circuit" },
  { code: "GA-SUP-FULTON", name: "Superior Court of Fulton County, Georgia", jurisdictionCode: "US-GA-FULTON", courtType: "trial" },
  { code: "AZ-SUP-MARICOPA", name: "Superior Court of Arizona in Maricopa County", jurisdictionCode: "US-AZ-MARICOPA", courtType: "trial" },
  { code: "WA-SUP-KING", name: "King County Superior Court (Washington)", jurisdictionCode: "US-WA-KING", courtType: "trial" },
  { code: "MA-SUP-SUFFOLK", name: "Suffolk County Superior Court (Massachusetts)", jurisdictionCode: "US-MA-SUFFOLK", courtType: "trial" },
  { code: "PA-COMM-PHILA", name: "Court of Common Pleas of Philadelphia County", jurisdictionCode: "US-PA-PHILADELPHIA", courtType: "trial" },
  { code: "CO-DC-DENVER", name: "Second Judicial District Court of Colorado (Denver County)", jurisdictionCode: "US-CO-DENVER", courtType: "trial", district: "2nd Judicial District" },
  { code: "NV-DC-CLARK", name: "Eighth Judicial District Court of Nevada (Clark County)", jurisdictionCode: "US-NV-CLARK", courtType: "trial", district: "8th Judicial District" },
  { code: "MI-CIR-WAYNE", name: "Third Judicial Circuit of Michigan (Wayne County)", jurisdictionCode: "US-MI-WAYNE", courtType: "trial", district: "3rd Judicial Circuit" },
] as const;

/** Total court entries. */
export const US_COURT_COUNT = US_COURTS.length;

/** Quick lookup by code. */
let _byCode: Map<string, CourtEntry> | null = null;
export function courtByCode(code: string): CourtEntry | undefined {
  if (!_byCode) {
    _byCode = new Map(US_COURTS.map((c) => [c.code, c]));
  }
  return _byCode.get(code);
}
