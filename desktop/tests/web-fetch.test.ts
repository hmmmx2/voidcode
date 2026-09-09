/**
 * The web-fetch guards.
 *
 * No network, no DNS: both are injected, which is what lets every branch be driven — including
 * the ones a real network would never produce on demand, like a name that resolves to the cloud
 * metadata address or a redirect into localhost.
 *
 * The threat model is worth restating, because it is not "a malicious web page". It is that an
 * agent acting on a model's output can be talked into naming a URL, and some URLs are not
 * documents: `169.254.169.254` hands out cloud credentials to anything that asks, a router's
 * admin panel takes unauthenticated POSTs, and a service bound to localhost generally assumes
 * anything reaching it is already trusted.
 *
 * An allowlist alone does not close that, because DNS is controlled by whoever owns the name.
 * The pinned connection is what does, and it has its own test below.
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  isAllowedHost,
  isPrivateAddress,
  checkUrl,
  FetchRefused,
  ALLOWED_DOMAINS,
} from "../src/main/net/allowlist.js";
import { fetchPage, type FetchDeps } from "../src/main/net/fetch.js";

describe("the allowlist", () => {
  it("accepts a listed domain and its subdomains", () => {
    expect(isAllowedHost("developer.mozilla.org")).toBe(true);
    expect(isAllowedHost("raw.githubusercontent.com")).toBe(true);
    expect(isAllowedHost("api.github.com")).toBe(true);
  });

  it("refuses a domain that merely ENDS WITH an allowed one", () => {
    // `evil-github.com` ends with "github.com" as a string. The dot is what makes the
    // boundary real, and an `endsWith` check without it lets this through.
    expect(isAllowedHost("evil-github.com")).toBe(false);
    expect(isAllowedHost("notpython.org")).toBe(false);
  });

  it("refuses a domain that merely CONTAINS an allowed one", () => {
    // The other direction: an `includes()` check lets this through. Both lookalikes are
    // trivially registrable.
    expect(isAllowedHost("github.com.evil.net")).toBe(false);
    expect(isAllowedHost("docs.python.org.attacker.io")).toBe(false);
  });

  it("is case- and trailing-dot-insensitive, since DNS is", () => {
    expect(isAllowedHost("GitHub.COM")).toBe(true);
    expect(isAllowedHost("github.com.")).toBe(true);
  });

  it("refuses anything not on the list", () => {
    expect(isAllowedHost("example.com")).toBe(false);
    expect(isAllowedHost("localhost")).toBe(false);
  });

  it("is short, because every entry is somewhere a model can be sent", () => {
    // Not a style check. The list is the blast radius, and it should be reviewable at a glance.
    expect(ALLOWED_DOMAINS.length).toBeLessThan(30);
  });
});

describe("private and reserved addresses", () => {
  it("refuses the cloud metadata endpoint", () => {
    // The one that matters most: on an unconfigured instance this hands out credentials to
    // anything that asks.
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
  });

  it("refuses every private IPv4 range", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "0.0.0.0",
      "100.64.0.1", // CGNAT — a carrier's internal space
      "224.0.0.1", // multicast
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("refuses EVERY IPv4-mapped IPv6 address, public ones included", () => {
    // These reach an IPv4 destination while passing a naive family or string check, which is
    // what makes them a bypass. The public form is refused too — an earlier version parsed the
    // embedded address and applied the v4 rules, but that branch only decided whether a public
    // mapped address was allowed, so deleting it made the check stricter and no test could
    // tell. Found by mutating it and watching nothing fail. Refusing the whole form is simpler
    // and testable, and `dns.lookup` does not produce these in practice.
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::FFFF:169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true);
  });

  it("refuses IPv6 loopback, unique-local and link-local", () => {
    for (const address of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    expect(isPrivateAddress("140.82.121.4")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });

  it("refuses something that is not an address at all", () => {
    // Refuse rather than guess: a resolver returning nonsense should not become a connection.
    expect(isPrivateAddress("not-an-address")).toBe(true);
    expect(isPrivateAddress("999.1.1.1")).toBe(true);
  });
});

describe("what can be decided from the URL alone", () => {
  it("refuses anything that is not https", () => {
    // `file:` reads the disk, `data:` lets a model hand itself content and call it a source,
    // and plain http is interceptable on any shared network.
    for (const url of [
      "http://github.com/x",
      "file:///etc/passwd",
      "data:text/html,<b>hi</b>",
      "ftp://github.com/x",
    ]) {
      expect(() => checkUrl(url), url).toThrow(FetchRefused);
    }
  });

  it("refuses credentials in the URL", () => {
    // `https://github.com@evil.com/` reads as one site and reaches another — the oldest trick
    // in the list, and one an allowlist check on `hostname` alone would already catch. This
    // refuses it by name so the failure says what was wrong.
    expect(() => checkUrl("https://user:pass@github.com/x")).toThrow(/credentials/);
  });

  it("refuses a host that is not allowed", () => {
    expect(() => checkUrl("https://evil.com/x")).toThrow(/not an allowed source/);
  });

  it("accepts a plain allowed URL", () => {
    expect(checkUrl("https://docs.python.org/3/library/json.html").hostname).toBe(
      "docs.python.org"
    );
  });
});

/** A fake `https.request` that answers with whatever the test scripts. */
function fakeRequest(
  responses: Array<{ status: number; headers?: Record<string, string>; body?: string }>
) {
  const calls: Array<{ hostname: string; lookupAddress: string | undefined }> = [];
  let index = 0;

  const request = vi.fn((options: Record<string, unknown>, callback: (r: unknown) => void) => {
    // The address the connection would actually go to — which is the whole point of the pin.
    let lookupAddress: string | undefined;
    const lookup = options.lookup as
      | ((h: string, o: unknown, cb: (e: null, a: string, f: number) => void) => void)
      | undefined;
    lookup?.("ignored", {}, (_error, address) => {
      lookupAddress = address;
    });
    calls.push({ hostname: String(options.hostname), lookupAddress });

    const scripted = responses[Math.min(index++, responses.length - 1)] ?? { status: 200 };
    const response = new EventEmitter() as EventEmitter & {
      statusCode: number;
      headers: Record<string, string>;
      destroy: () => void;
    };
    response.statusCode = scripted.status;
    response.headers = scripted.headers ?? { "content-type": "text/html" };
    response.destroy = () => response.emit("close");

    queueMicrotask(() => {
      callback(response);
      queueMicrotask(() => {
        if (scripted.body !== undefined) response.emit("data", Buffer.from(scripted.body));
        response.emit("end");
      });
    });

    const emitter = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    emitter.end = () => {};
    emitter.destroy = () => {};
    return emitter;
  });

  return { request: request as unknown as FetchDeps["request"], calls };
}

const publicDns: FetchDeps["resolve"] = async () => [{ address: "140.82.121.4", family: 4 }];

describe("resolution", () => {
  it("refuses when the name resolves to a private address", () => {
    // The allowlist says github.com; DNS says 127.0.0.1. The allowlist alone is not a control.
    const deps: FetchDeps = {
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      request: fakeRequest([{ status: 200 }]).request,
    };
    return expect(fetchPage("https://github.com/x", deps)).rejects.toThrow(/private address/);
  });

  it("refuses when ANY address is private, not just the first", () => {
    // A name can resolve to a public address and a private one. Checking `addresses[0]` and
    // connecting to whichever the OS prefers has checked nothing.
    const deps: FetchDeps = {
      resolve: async () => [
        { address: "140.82.121.4", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
      request: fakeRequest([{ status: 200 }]).request,
    };
    return expect(fetchPage("https://github.com/x", deps)).rejects.toThrow(/169\.254\.169\.254/);
  });

  it("refuses a name that resolves to nothing", () => {
    const deps: FetchDeps = {
      resolve: async () => [],
      request: fakeRequest([{ status: 200 }]).request,
    };
    return expect(fetchPage("https://github.com/x", deps)).rejects.toThrow(/resolved to nothing/);
  });
});

describe("the pinned connection", () => {
  it("connects to the address it vetted, not to the name again", async () => {
    /**
     * THE TEST THAT MATTERS MOST IN THIS FILE.
     *
     * Vetting addresses and then handing the hostname to an HTTP client is a control that
     * controls nothing: the client resolves it again, and whoever owns the name answers
     * differently the second time. That is DNS rebinding, and this asserts the connection is
     * pinned to the vetted address rather than re-resolved.
     */
    const fake = fakeRequest([{ status: 200, body: "<p>ok</p>" }]);
    await fetchPage("https://github.com/x", { resolve: publicDns, request: fake.request });

    expect(fake.calls[0]?.lookupAddress).toBe("140.82.121.4");
  });

  it("keeps the real hostname for TLS", async () => {
    // Pinning the address must not weaken certificate validation — the certificate still has
    // to be valid for the name.
    const fake = fakeRequest([{ status: 200, body: "ok" }]);
    await fetchPage("https://github.com/x", { resolve: publicDns, request: fake.request });

    expect(fake.calls[0]?.hostname).toBe("github.com");
  });
});

describe("redirects", () => {
  it("re-checks the allowlist on every hop", async () => {
    // `follow` in the client would skip every check on hops 2..n. A redirect from an allowed
    // host to an arbitrary one is trivial for whoever runs the allowed host.
    const fake = fakeRequest([
      { status: 302, headers: { location: "https://evil.com/x" } },
      { status: 200, body: "should never be reached" },
    ]);

    await expect(
      fetchPage("https://github.com/a", { resolve: publicDns, request: fake.request })
    ).rejects.toThrow(/not an allowed source/);
  });

  it("re-resolves and re-vets on every hop", async () => {
    // The attack this whole file exists to stop: an allowed host redirecting into the metadata
    // endpoint. The second hop is allowlisted, so only the address check catches it.
    let call = 0;
    const deps: FetchDeps = {
      resolve: async () =>
        ++call === 1
          ? [{ address: "140.82.121.4", family: 4 }]
          : [{ address: "169.254.169.254", family: 4 }],
      request: fakeRequest([
        { status: 302, headers: { location: "https://raw.githubusercontent.com/x" } },
        { status: 200, body: "secrets" },
      ]).request,
    };

    await expect(fetchPage("https://github.com/a", deps)).rejects.toThrow(/private address/);
  });

  it("refuses a redirect loop rather than following it forever", async () => {
    const fake = fakeRequest([{ status: 302, headers: { location: "https://github.com/loop" } }]);

    await expect(
      fetchPage("https://github.com/a", { resolve: publicDns, request: fake.request })
    ).rejects.toThrow(/redirects/);
  });

  it("resolves a relative Location against the current URL", async () => {
    const fake = fakeRequest([
      { status: 302, headers: { location: "/moved" } },
      { status: 200, body: "<p>arrived</p>" },
    ]);

    const page = await fetchPage("https://github.com/a/b", {
      resolve: publicDns,
      request: fake.request,
    });
    expect(page.finalUrl).toBe("https://github.com/moved");
  });
});

describe("what comes back", () => {
  it("refuses a content type that is not a document", async () => {
    const fake = fakeRequest([{ status: 200, headers: { "content-type": "application/zip" } }]);

    await expect(
      fetchPage("https://github.com/x.zip", { resolve: publicDns, request: fake.request })
    ).rejects.toThrow(/Refusing application\/zip/);
  });

  it("refuses a declared length over the cap before reading a byte", async () => {
    const fake = fakeRequest([
      {
        status: 200,
        headers: { "content-type": "text/html", "content-length": String(50 * 1024 * 1024) },
      },
    ]);

    await expect(
      fetchPage("https://github.com/big", { resolve: publicDns, request: fake.request })
    ).rejects.toThrow(/exceeds/);
  });

  it("reports an error status rather than returning an empty page", async () => {
    const fake = fakeRequest([{ status: 404 }]);

    await expect(
      fetchPage("https://github.com/missing", { resolve: publicDns, request: fake.request })
    ).rejects.toThrow(/returned 404/);
  });

  it("returns the extracted text and where it came from", async () => {
    const fake = fakeRequest([
      { status: 200, body: "<html><title>Docs</title><body><p>Hello</p></body></html>" },
    ]);

    const page = await fetchPage("https://docs.python.org/3/", {
      resolve: publicDns,
      request: fake.request,
    });

    expect(page.title).toBe("Docs");
    expect(page.text).toContain("Hello");
    expect(page.finalUrl).toBe("https://docs.python.org/3/");
    expect(page.truncated).toBe(false);
  });
});
