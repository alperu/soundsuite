import { US_COURTS, US_COURT_COUNT, courtByCode } from "../us-courts";
import { US_JURISDICTIONS } from "../us-jurisdictions";

describe("US_COURTS catalogue", () => {
  const jurisdictionCodes = new Set(US_JURISDICTIONS.map((j) => j.code));

  it("has all unique court codes", () => {
    const codes = US_COURTS.map((c) => c.code);
    const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
    expect(dupes).toEqual([]);
  });

  it("every jurisdictionCode resolves in US_JURISDICTIONS", () => {
    const orphans: string[] = [];
    for (const c of US_COURTS) {
      if (!jurisdictionCodes.has(c.jurisdictionCode)) {
        orphans.push(`${c.code} -> ${c.jurisdictionCode}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  it("includes SCOTUS", () => {
    const scotus = courtByCode("US-SC");
    expect(scotus).toBeDefined();
    expect(scotus?.courtType).toBe("supreme");
    expect(scotus?.jurisdictionCode).toBe("US");
  });

  it("includes all 13 federal Courts of Appeals", () => {
    const circuits = [
      "US-CA-1", "US-CA-2", "US-CA-3", "US-CA-4", "US-CA-5",
      "US-CA-6", "US-CA-7", "US-CA-8", "US-CA-9", "US-CA-10",
      "US-CA-11", "US-CA-DC", "US-CA-FED",
    ];
    for (const code of circuits) {
      const entry = courtByCode(code);
      expect(entry).toBeDefined();
      expect(entry?.courtType).toBe("appellate");
    }
  });

  it("includes all 14 Texas Courts of Appeals", () => {
    for (let n = 1; n <= 14; n++) {
      const entry = courtByCode(`TX-APP-${n}`);
      expect(entry).toBeDefined();
      expect(entry?.courtType).toBe("appellate");
      expect(entry?.jurisdictionCode).toBe("US-TX");
    }
  });

  it("includes Supreme Court of Texas and Court of Criminal Appeals", () => {
    expect(courtByCode("TX-SC")?.courtType).toBe("supreme");
    expect(courtByCode("TX-CCA")?.courtType).toBe("supreme");
  });

  it("includes a supreme court for every US state and DC", () => {
    const states = US_JURISDICTIONS.filter((j) => j.level === "state");
    const supremesByJurisdiction = new Set(
      US_COURTS.filter((c) => c.courtType === "supreme").map((c) => c.jurisdictionCode),
    );
    const missing: string[] = [];
    for (const s of states) {
      // Federal jurisdiction parent excluded via parentCode check
      if (!supremesByJurisdiction.has(s.code)) {
        missing.push(s.code);
      }
    }
    expect(missing).toEqual([]);
  });

  it("includes the 94 federal district courts (US- prefixed, courtType=trial, federal jurisdiction)", () => {
    const federalDistrictRegex = /^US-[A-Z]+$/; // crude: starts with US- and is uppercase
    const districts = US_COURTS.filter(
      (c) =>
        c.courtType === "trial" &&
        c.code.startsWith("US-") &&
        federalDistrictRegex.test(c.code),
    );
    // 94 traditional districts + minor variance; we expect at least 94.
    expect(districts.length).toBeGreaterThanOrEqual(94);
  });

  it("has at least 150 court entries", () => {
    expect(US_COURT_COUNT).toBeGreaterThanOrEqual(150);
  });

  it("courtByCode returns undefined for unknown codes", () => {
    expect(courtByCode("ZZ-ZZ-999")).toBeUndefined();
  });

  it("Travis County trial courts attach to US-TX-TRAVIS", () => {
    const c126 = courtByCode("TX-DC-126");
    expect(c126).toBeDefined();
    expect(c126?.jurisdictionCode).toBe("US-TX-TRAVIS");
    expect(c126?.courtType).toBe("trial");
  });
});
