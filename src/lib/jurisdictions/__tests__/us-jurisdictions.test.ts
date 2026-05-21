import {
  US_JURISDICTIONS,
  US_JURISDICTION_COUNT,
  jurisdictionByCode,
  type JurisdictionEntry,
} from "../us-jurisdictions";

describe("US_JURISDICTIONS catalogue", () => {
  it("has all unique codes", () => {
    const codes = US_JURISDICTIONS.map((j) => j.code);
    const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
    expect(dupes).toEqual([]);
  });

  it("all non-federal parentCodes resolve to another entry", () => {
    const codes = new Set(US_JURISDICTIONS.map((j) => j.code));
    const orphans: string[] = [];
    for (const j of US_JURISDICTIONS) {
      if (j.parentCode && !codes.has(j.parentCode)) {
        orphans.push(`${j.code} -> ${j.parentCode}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  it("only the federal root lacks a parentCode", () => {
    const roots = US_JURISDICTIONS.filter((j) => !j.parentCode);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.code).toBe("US");
  });

  it("every state has level=state and parentCode=US", () => {
    const states = US_JURISDICTIONS.filter((j) => j.level === "state");
    // 50 states + DC (DC is leveled as state for parity)
    expect(states.length).toBeGreaterThanOrEqual(51);
    for (const s of states) {
      expect(s.parentCode).toBe("US");
      expect(s.code.startsWith("US-")).toBe(true);
    }
  });

  it("has at least 56 jurisdictions (50 states + DC + 5 territories + federal)", () => {
    expect(US_JURISDICTION_COUNT).toBeGreaterThanOrEqual(56);
  });

  it("has all 5 inhabited territories", () => {
    const expected = ["US-PR", "US-GU", "US-VI", "US-AS", "US-MP"];
    for (const code of expected) {
      const entry = jurisdictionByCode(code);
      expect(entry).toBeDefined();
      expect(entry?.level).toBe("territory");
    }
  });

  it("Texas counties chain up to US-TX which chains up to US", () => {
    const travis = jurisdictionByCode("US-TX-TRAVIS") as JurisdictionEntry;
    expect(travis.level).toBe("county");
    expect(travis.parentCode).toBe("US-TX");
    const tx = jurisdictionByCode("US-TX") as JurisdictionEntry;
    expect(tx.parentCode).toBe("US");
  });

  it("jurisdictionByCode returns undefined for unknown codes", () => {
    expect(jurisdictionByCode("ZZ-ZZ")).toBeUndefined();
  });

  it("FIPS codes are well-formed (2-digit state, 5-digit county)", () => {
    for (const j of US_JURISDICTIONS) {
      if (!j.fipsCode) continue;
      if (j.level === "state" || j.level === "territory") {
        expect(j.fipsCode).toMatch(/^\d{2}$/);
      }
      if (j.level === "county") {
        expect(j.fipsCode).toMatch(/^\d{5}$/);
      }
    }
  });
});
