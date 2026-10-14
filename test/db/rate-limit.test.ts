import { describe, expect, it } from "vitest";

import { addressOf } from "../../app/lib/security/rate-limit.server";

const from = (ip: string | null) =>
  new Request("https://aion.ly/api/vote", { headers: ip ? { "CF-Connecting-IP": ip } : {} });

describe("addressOf", () => {
  it("keys IPv4 by the address, and IPv6 by its /64", () => {
    expect(addressOf(from("203.0.113.7"))).toBe("203.0.113.7");
    expect(addressOf(from("2001:db8:85a3:42::8a2e:370:7334"))).toBe("2001:db8:85a3:42::/64");
    expect(addressOf(from("2001:DB8::1"))).toBe("2001:db8:0:0::/64");
    expect(addressOf(from("2001:db8::1"))).toBe(addressOf(from("2001:db8:0:0:ffff::2")));
  });

  it("reads IPv4 written as IPv6 as IPv4", () => {
    expect(addressOf(from("::ffff:198.51.100.4"))).toBe("198.51.100.4");
  });

  it("does not limit the local machine or requests without an address", () => {
    expect(addressOf(from("127.0.0.1"))).toBeNull();
    expect(addressOf(from("::1"))).toBeNull();
    expect(addressOf(from(null))).toBeNull();
  });
});
