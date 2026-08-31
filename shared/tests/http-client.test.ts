import { describe, it, expect } from "vitest";
import {
  isPrivateIpv4,
  isPrivateIpv6,
  parseIpv6,
  pinnedWebSocketOptions,
} from "../src/lib/http-client.js";

describe("isPrivateIpv4", () => {
  describe("private ranges → true", () => {
    it("10.0.0.0/8", () => {
      expect(isPrivateIpv4("10.0.0.1")).toBe(true);
      expect(isPrivateIpv4("10.255.255.255")).toBe(true);
    });
    it("172.16.0.0/12", () => {
      expect(isPrivateIpv4("172.16.0.1")).toBe(true);
      expect(isPrivateIpv4("172.31.255.255")).toBe(true);
    });
    it("192.168.0.0/16", () => {
      expect(isPrivateIpv4("192.168.0.1")).toBe(true);
      expect(isPrivateIpv4("192.168.255.255")).toBe(true);
    });
    it("127.0.0.0/8 loopback", () => {
      expect(isPrivateIpv4("127.0.0.1")).toBe(true);
      expect(isPrivateIpv4("127.255.255.255")).toBe(true);
    });
    it("169.254.0.0/16 link-local", () => {
      expect(isPrivateIpv4("169.254.0.1")).toBe(true);
      expect(isPrivateIpv4("169.254.169.254")).toBe(true);
    });
    it("100.64.0.0/10 CGNAT", () => {
      expect(isPrivateIpv4("100.64.0.1")).toBe(true);
      expect(isPrivateIpv4("100.127.255.255")).toBe(true);
    });
    it('0.0.0.0/8 "this network"', () => {
      expect(isPrivateIpv4("0.0.0.0")).toBe(true);
      expect(isPrivateIpv4("0.255.255.255")).toBe(true);
    });
    it("224.0.0.0/4 multicast", () => {
      expect(isPrivateIpv4("224.0.0.1")).toBe(true);
      expect(isPrivateIpv4("239.255.255.255")).toBe(true);
    });
    it("240.0.0.0/4 reserved", () => {
      expect(isPrivateIpv4("240.0.0.1")).toBe(true);
      expect(isPrivateIpv4("255.255.255.255")).toBe(true);
    });
  });

  describe("public IPs → false", () => {
    it("common public IPs", () => {
      expect(isPrivateIpv4("8.8.8.8")).toBe(false);
      expect(isPrivateIpv4("1.1.1.1")).toBe(false);
      expect(isPrivateIpv4("93.184.216.34")).toBe(false);
    });
    it("boundary: just outside 10.x range", () => {
      expect(isPrivateIpv4("11.0.0.0")).toBe(false);
    });
    it("boundary: just outside 172.16–31 range", () => {
      expect(isPrivateIpv4("172.32.0.0")).toBe(false);
    });
    it("boundary: just outside 192.168 range", () => {
      expect(isPrivateIpv4("192.169.0.0")).toBe(false);
    });
    it("boundary: just outside CGNAT range", () => {
      expect(isPrivateIpv4("100.128.0.0")).toBe(false);
    });
  });

  describe("malformed input → false", () => {
    it("empty string", () => {
      expect(isPrivateIpv4("")).toBe(false);
    });
    it("too few octets", () => {
      expect(isPrivateIpv4("10.0.0")).toBe(false);
    });
    it("too many octets", () => {
      expect(isPrivateIpv4("10.0.0.0.1")).toBe(false);
    });
    it("leading zeros (non-canonical)", () => {
      expect(isPrivateIpv4("010.0.0.1")).toBe(false);
    });
    it("negative octet", () => {
      expect(isPrivateIpv4("10.-1.0.1")).toBe(false);
    });
    it("octet > 255", () => {
      expect(isPrivateIpv4("10.0.0.256")).toBe(false);
    });
  });
});

describe("parseIpv6", () => {
  it("parses full explicit address", () => {
    expect(parseIpv6("2001:0db8:0000:0000:0000:0000:0000:0001")).toEqual([
      0x2001, 0x0db8, 0, 0, 0, 0, 0, 1,
    ]);
  });
  it("parses :: compression (loopback)", () => {
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });
  it("parses :: (unspecified)", () => {
    expect(parseIpv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
  it("parses compression in the middle", () => {
    expect(parseIpv6("fe80::1")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });
  it("parses IPv4-embedded suffix", () => {
    expect(parseIpv6("::ffff:10.0.0.1")).toEqual([
      0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001,
    ]);
  });
  it("strips zone ID", () => {
    expect(parseIpv6("fe80::1%eth0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });
  it("rejects double :: compression", () => {
    expect(parseIpv6("fe80::1::2")).toBeNull();
  });
  it("rejects too many groups", () => {
    expect(parseIpv6("1:2:3:4:5:6:7:8:9")).toBeNull();
  });
  it("rejects empty string", () => {
    expect(parseIpv6("")).toBeNull();
  });
  it("parses short hex groups", () => {
    expect(parseIpv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("isPrivateIpv6", () => {
  describe("private ranges → true", () => {
    it("::1 loopback", () => {
      expect(isPrivateIpv6("::1")).toBe(true);
    });
    it(":: unspecified", () => {
      expect(isPrivateIpv6("::")).toBe(true);
    });
    it("fe80::/10 link-local", () => {
      expect(isPrivateIpv6("fe80::1")).toBe(true);
      expect(isPrivateIpv6("febf::ffff")).toBe(true);
    });
    it("fc00::/7 unique local", () => {
      expect(isPrivateIpv6("fc00::1")).toBe(true);
      expect(isPrivateIpv6("fdff::1")).toBe(true);
    });
    it("ff00::/8 multicast", () => {
      expect(isPrivateIpv6("ff02::1")).toBe(true);
    });
    it("::ffff:127.0.0.1 IPv4-mapped loopback", () => {
      expect(isPrivateIpv6("::ffff:127.0.0.1")).toBe(true);
    });
    it("::ffff:10.0.0.1 IPv4-mapped private", () => {
      expect(isPrivateIpv6("::ffff:10.0.0.1")).toBe(true);
    });
    it("::ffff:192.168.1.1 IPv4-mapped private", () => {
      expect(isPrivateIpv6("::ffff:192.168.1.1")).toBe(true);
    });
  });

  describe("public ranges → false", () => {
    it("2001:db8::1 (documentation, but not in private list)", () => {
      expect(isPrivateIpv6("2001:db8::1")).toBe(false);
    });
    it("2606:4700::1 (Cloudflare)", () => {
      expect(isPrivateIpv6("2606:4700::1")).toBe(false);
    });
    it("::ffff:8.8.8.8 IPv4-mapped public", () => {
      expect(isPrivateIpv6("::ffff:8.8.8.8")).toBe(false);
    });
  });
});

describe("pinnedWebSocketOptions — platform-relay exemption (C1)", () => {
  it("rejects a private-IP host by default", async () => {
    await expect(pinnedWebSocketOptions("ws://127.0.0.1:7777")).rejects.toThrow(
      /private IP/,
    );
  });

  it("permits a private-IP host when it is in allowHosts", async () => {
    const opts = await pinnedWebSocketOptions("ws://127.0.0.1:7777", {
      allowHosts: ["127.0.0.1"],
    });
    // The pin is still enforced: the lookup forces the cleared address.
    const address = await new Promise<string>((resolve, reject) => {
      opts.lookup("127.0.0.1", {}, (err: Error | null, addr: string) =>
        err ? reject(err) : resolve(addr),
      );
    });
    expect(address).toBe("127.0.0.1");
  });

  it("does not exempt a host that isn't an exact allowHosts match", async () => {
    await expect(
      pinnedWebSocketOptions("ws://127.0.0.1:7777", { allowHosts: ["strfry"] }),
    ).rejects.toThrow(/private IP/);
  });
});
