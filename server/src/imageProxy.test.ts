import { describe, expect, it } from "vitest";
import { isPrivateIp } from "./imageProxy.js";

describe("proxy de avatares", () => {
  it("bloquea direcciones internas y loopback", () => {
    for (const ip of ["127.0.0.1", "10.0.0.4", "172.16.1.2", "192.168.1.1", "169.254.1.1", "::1", "fd00::1"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  it("permite direcciones públicas", () => {
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
  });
});
