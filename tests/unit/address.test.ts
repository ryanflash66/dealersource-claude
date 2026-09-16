import { describe, expect, it } from "vitest";
import { looksLikeStreetAddress, normalizeAddressKey, parseAddress } from "../../src/core/address.js";

describe("address normalisation (dedupe key)", () => {
  it("merges the three golden PITT-0001 spellings into one key", () => {
    const keys = new Set(
      ["2400 S Memorial Dr, Greenville, NC 27834", "2400 South Memorial Drive, Greenville NC 27834", "2400 S. Memorial Dr Greenville, NC 27834"].map(normalizeAddressKey),
    );
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("2400 s memorial dr greenville nc 27834");
  });

  it("drops unit designators and expands street types", () => {
    expect(normalizeAddressKey("1204 Dickinson Avenue Suite 4, Greenville, North Carolina 27834")).toBe("1204 dickinson ave greenville nc 27834");
    expect(normalizeAddressKey("1204 Dickinson Ave #4, Greenville, NC 27834")).toBe("1204 dickinson ave greenville nc 27834");
  });

  it("keeps distinct addresses distinct", () => {
    expect(normalizeAddressKey("2400 S Memorial Dr, Greenville, NC")).not.toBe(normalizeAddressKey("2410 S Memorial Dr, Greenville, NC"));
  });

  it("parses number, city and zip; rejects addresses without a street number", () => {
    expect(parseAddress("3100 E 10th St, Greenville, NC 27858")).toEqual({ number: "3100", city: "Greenville", zip: "27858" });
    expect(looksLikeStreetAddress("Hwy 11 lot near Bethel, NC")).toBe(false);
    expect(looksLikeStreetAddress("700 W 5th St, Ayden, NC 28513")).toBe(true);
  });
});
