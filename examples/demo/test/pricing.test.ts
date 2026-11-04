import { describe, expect, it } from "vitest";
import { addVat, applyDiscount } from "../src/pricing.js";

describe("pricing", () => {
  it("no descuenta por debajo del umbral", () => {
    expect(applyDiscount(99)).toBe(99);
  });

  it("descuenta el 10 % desde 100", () => {
    expect(applyDiscount(100)).toBe(90);
  });

  it("suma el 21 % de IVA", () => {
    expect(addVat(100)).toBeCloseTo(121);
  });
});
