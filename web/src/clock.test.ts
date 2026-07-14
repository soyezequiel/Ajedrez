import { describe, expect, it } from "vitest";
import { clockAriaLabel, clockUrgency, formatClockMs, lowTimeThresholdMs } from "./clock.js";

describe("feedback del reloj", () => {
  it("adapta el aviso a ritmos cortos y lo limita a un minuto", () => {
    expect(lowTimeThresholdMs(60_000)).toBe(12_000);
    expect(lowTimeThresholdMs(5 * 60_000)).toBe(60_000);
    expect(lowTimeThresholdMs(30 * 60_000)).toBe(60_000);
  });

  it("distingue tiempo normal, poco tiempo y los últimos diez segundos", () => {
    const initial = 5 * 60_000;
    expect(clockUrgency(61_000, initial)).toBe(0);
    expect(clockUrgency(60_000, initial)).toBe(1);
    expect(clockUrgency(10_000, initial)).toBe(2);
  });

  it("redondea el reloj hacia arriba y genera una etiqueta accesible", () => {
    expect(formatClockMs(60_001)).toBe("1:01");
    expect(clockAriaLabel(9_500, 2)).toContain("Tiempo crítico");
  });
});
