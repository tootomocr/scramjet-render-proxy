// SOCKS5 egress tunnel for wisp upstream dials.
//
// wisp-js/server dials upstream TCP with `new net.Socket()` + `.connect({host, port})`
// and offers no upstream-proxy option. This module patches `net.Socket.prototype.connect`
// so those dials are transparently forwarded through a SOCKS5 proxy (wireproxy).
//
// Design notes:
// - Patching the prototype (not the class) works regardless of how wisp-js imports
//   `node:net` (`export * as net`), because it is the same prototype object.
// - The premature TCP `connect` event (proxy established, handshake not done yet) is
//   suppressed by shadowing the instance `emit` during the handshake, so wisp-js only
//   sees `connect` once the tunnel is ready.
// - Unix-socket connects, loopback/private ranges and the proxy endpoint itself always
//   go direct (no recursion).
// - No third-party dependency: SOCKS5 CONNECT (no-auth / username-password) is tiny.

import net from "node:net";

const SOCKS_VERSION = 0x05;
const DEFAULT_TIMEOUT_MS = 15_000;

let installed = false;
let activeConfig = null;

function ipv4ToInt(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function stripMapped(ip) {
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) return lower.slice("::ffff:".length);
  return lower;
}

function parseBypassList(raw) {
  const out = [];
  for (const item of (raw || "").split(",")) {
    const s = item.trim().toLowerCase();
    if (!s) continue;
    if (s === "localhost") {
      out.push({ type: "name", value: "localhost" });
      continue;
    }
    const slash = s.indexOf("/");
    if (slash === -1) {
      const v4 = ipv4ToInt(stripMapped(s.replace(/^\[|\]$/g, "")));
      if (v4 !== null) out.push({ type: "ip", value: v4 });
      else out.push({ type: "name", value: s.replace(/^\[|\]$/g, "") });
      continue;
    }
    const base = ipv4ToInt(stripMapped(s.slice(0, slash)));
    const bits = Number(s.slice(slash + 1));
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    out.push({ type: "cidr", base, mask });
  }
  return out;
}

function hostMatchesBypass(host, list) {
  const h = stripMapped(String(host).toLowerCase().replace(/^\[|\]$/g, ""));
  for (const rule of list) {
    if (rule.type === "name" && h === rule.value) return true;
    const v4 = ipv4ToInt(h);
    if (v4 === null) continue;
    if (rule.type === "ip" && v4 === rule.value) return true;
    if (rule.type === "cidr" && (v4 & rule.mask) === (rule.base & rule.mask)) return true;
  }
  // ::1 in its native form
  if (h === "::1") return true;
  return false;
}

export function parseUpstreamSocks(raw) {
  const u = new URL(raw);
  if (u.protocol !== "socks5:" && u.protocol !== "socks5h:") {
    throw new Error(`unsupported proxy protocol ${u.protocol} (expected socks5://)`);
  }
  const port = u.port ? Number(u.port) : 1080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid proxy port");
  return {
    host: u.hostname,
    port,
    username: u.username ? decodeURIComponent(u.username) : "",
    password: u.password ? decodeURIComponent(u.password) : "",
  };
}

function normalizeConnectArgs(args) {
  let cb = null;
  const rest = [...args];
  if (rest.length > 0 && typeof rest[rest.length - 1] === "function") cb = rest.pop();
  let first = rest[0];
  // net.createConnection() calls socket.connect([options, cb]) (array form).
  if (Array.isArray(first)) {
    if (typeof first[1] === "function") cb = first[1];
    first = first[0];
  }
  if (typeof first === "string") return { path: first, cb }; // unix socket
  if (typeof first === "number") {
    return { port: first, host: typeof rest[1] === "string" ? rest[1] : "localhost", cb };
  }
  if (first && typeof first === "object") {
    return {
      port: first.port,
      host: first.host ?? first.hostname ?? first.address ?? "localhost",
      cb,
    };
  }
  return null;
}

function buildGreeting(withAuth) {
  return withAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
}

function buildAuthRequest(username, password) {
  const u = Buffer.from(username, "utf8");
  const p = Buffer.from(password, "utf8");
  if (u.length > 255 || p.length > 255) throw new Error("socks5 credentials too long");
  return Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]);
}

function buildConnectRequest(host, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid destination port");
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  const v4 = ipv4ToInt(stripMapped(String(host)));
  if (v4 !== null) {
    const ipBuf = Buffer.alloc(4);
    ipBuf.writeUInt32BE(v4);
    return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), ipBuf, portBuf]);
  }
  if (net.isIP(host) === 6) {
    const parts = String(host).replace(/^\[|\]$/g, "").split(":");
    // Expand :: shorthand (simple approach via parsing with a dummy URL is overkill;
    // Node guarantees canonical form only sometimes, so do a manual expansion).
    const head = [];
    const tail = [];
    const dbl = parts.indexOf("");
    let mid;
    if (dbl !== -1) {
      const left = parts.slice(0, dbl).filter((x) => x !== "");
      const right = parts.slice(dbl).filter((x) => x !== "");
      const missing = 8 - left.length - right.length;
      mid = new Array(Math.max(0, missing)).fill("0");
      head.push(...left, ...mid, ...right);
    } else {
      head.push(...parts);
    }
    if (head.length !== 8) throw new Error("invalid IPv6 destination");
    const ipBuf = Buffer.alloc(16);
    head.forEach((h, i) => ipBuf.writeUInt16BE(parseInt(h || "0", 16), i * 2));
    return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x04]), ipBuf, portBuf]);
  }
  const nameBuf = Buffer.from(String(host), "utf8");
  if (nameBuf.length === 0 || nameBuf.length > 255) throw new Error("invalid destination hostname");
  return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, nameBuf.length]), nameBuf, portBuf]);
}

const REP_ERRORS = {
  0x01: "general failure",
  0x02: "connection not allowed",
  0x03: "network unreachable",
  0x04: "host unreachable",
  0x05: "connection refused",
  0x06: "TTL expired",
  0x07: "command not supported",
  0x08: "address type not supported",
};

export function installSocksTunnel({ url, bypass = "", timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (installed) return activeConfig;
  const proxy = parseUpstreamSocks(url);
  const bypassList = parseBypassList(bypass);
  const proxyHostNorm = stripMapped(proxy.host.toLowerCase().replace(/^\[|\]$/g, ""));

  const origConnect = net.Socket.prototype.connect;

  function isProxySelf(host, port) {
    return stripMapped(String(host).toLowerCase().replace(/^\[|\]$/g, "")) === proxyHostNorm && Number(port) === proxy.port;
  }

  function shouldTunnel(host, port) {
    if (host == null) return false;
    if (isProxySelf(host, port)) return false; // never recurse into ourselves
    if (hostMatchesBypass(host, bypassList)) return false;
    return true;
  }

  // eslint-disable-next-line no-extend-native
  net.Socket.prototype.connect = function patchedConnect(...args) {
    const target = normalizeConnectArgs(args);
    if (!target || target.path || !shouldTunnel(target.host, target.port)) {
      return origConnect.apply(this, args);
    }

    const sock = this;
    const destHost = String(target.host);
    const destPort = Number(target.port);
    const userCb = target.cb;
    const withAuth = proxy.username.length > 0;
    const origEmit = sock.emit.bind(sock);

    const state = {
      handshaking: true,
      phase: "greet",
      buf: Buffer.alloc(0),
      timer: null,
      finished: false,
    };

    const fail = (err) => {
      if (state.finished) return;
      state.finished = true;
      if (state.timer) clearTimeout(state.timer);
      delete sock.emit; // restore prototype emit so error/close flow normally
      sock.destroy(err);
      if (typeof userCb === "function") queueMicrotask(() => userCb(err));
    };

    const succeed = (leftover) => {
      if (state.finished) return;
      state.finished = true;
      if (state.timer) clearTimeout(state.timer);
      delete sock.emit; // restore prototype emit
      if (leftover && leftover.length > 0) origEmit("data", leftover);
      if (typeof userCb === "function") {
        try {
          userCb();
        } catch {
          // user callback errors must not break the socket
        }
      }
      origEmit("connect");
    };

    const stepOnce = () => {
      try {
        if (state.phase === "greet" && state.buf.length >= 2) {
          const [ver, method] = [state.buf[0], state.buf[1]];
          if (ver !== SOCKS_VERSION) throw new Error(`bad socks5 version ${ver}`);
          state.buf = state.buf.subarray(2);
          if (method === 0x00) {
            state.phase = "request";
            sock.write(buildConnectRequest(destHost, destPort));
          } else if (method === 0x02) {
            if (!withAuth) throw new Error("proxy demands auth but no credentials configured");
            state.phase = "auth";
            sock.write(buildAuthRequest(proxy.username, proxy.password));
          } else {
            throw new Error(`socks5 auth method rejected (0x${method.toString(16)})`);
          }
        }
        if (state.phase === "auth" && state.buf.length >= 2) {
          const [ver, status] = [state.buf[0], state.buf[1]];
          if (ver !== 0x01 || status !== 0x00) throw new Error("socks5 authentication failed");
          state.buf = state.buf.subarray(2);
          state.phase = "request";
          sock.write(buildConnectRequest(destHost, destPort));
        }
        if (state.phase === "request" && state.buf.length >= 4) {
          const [ver, rep, , atyp] = [state.buf[0], state.buf[1], state.buf[2], state.buf[3]];
          if (ver !== SOCKS_VERSION) throw new Error(`bad socks5 version ${ver}`);
          let need = 4;
          if (atyp === 0x01) need = 4 + 4 + 2;
          else if (atyp === 0x04) need = 4 + 16 + 2;
          else if (atyp === 0x03) {
            if (state.buf.length < 5) return;
            need = 4 + 1 + state.buf[4] + 2;
          } else throw new Error(`bad socks5 atyp 0x${atyp.toString(16)}`);
          if (state.buf.length < need) return;
          if (rep !== 0x00) throw new Error(`socks5 connect failed: ${REP_ERRORS[rep] || `rep 0x${rep.toString(16)}`}`);
          const leftover = state.buf.subarray(need);
          state.buf = Buffer.alloc(0);
          succeed(leftover.length > 0 ? Buffer.from(leftover) : null);
        }
      } catch (err) {
        fail(err);
      }
    };

    // Shadow emit on THIS instance only, until the handshake completes.
    sock.emit = function shadowEmit(ev, ...evArgs) {
      if (ev === "connect") {
        // TCP to the proxy is up: start the SOCKS handshake.
        // NOTE: net.Socket defers its first readStart until 'connect' is
        // observed (Socket#_read waits via once('connect')). Since we
        // withhold 'connect' until the handshake finishes, start the read
        // side explicitly here or the handshake reply would never arrive
        // (read(0)/resume() alone are not enough: a pre-connect read is
        // already flagged in-flight, so they become no-ops).
        try {
          sock.write(buildGreeting(withAuth));
        } catch (err) {
          fail(err);
          return false;
        }
        try {
          const h = sock._handle;
          if (h && !h.reading && typeof h.readStart === "function") {
            h.reading = true;
            const err = h.readStart();
            if (err) throw new Error(`readStart failed: ${err}`);
          }
        } catch (err) {
          fail(err);
        }
        return false;
      }
      if (ev === "data") {
        state.buf = Buffer.concat([state.buf, evArgs[0]]);
        // Run until no progress (replies may arrive coalesced).
        for (;;) {
          if (state.finished) break;
          const before = `${state.phase}:${state.buf.length}`;
          stepOnce();
          if (state.finished || `${state.phase}:${state.buf.length}` === before) break;
        }
        return true;
      }
      if (ev === "error" || ev === "close") {
        if (!state.finished) {
          state.finished = true;
          if (state.timer) clearTimeout(state.timer);
          delete sock.emit;
          return origEmit(ev, ...evArgs);
        }
        return origEmit(ev, ...evArgs);
      }
      return origEmit(ev, ...evArgs);
    };

    state.timer = setTimeout(() => fail(new Error("socks5 handshake timeout")), timeoutMs);
    state.timer.unref?.();

    origConnect.call(sock, { host: proxy.host, port: proxy.port });
    return sock;
  };

  installed = true;
  activeConfig = {
    enabled: true,
    host: proxy.host,
    port: proxy.port,
    hasAuth: proxy.username.length > 0,
    timeoutMs,
  };
  return activeConfig;
}

export function getTunnelStatus() {
  if (!activeConfig) return { enabled: false };
  return { enabled: true, ...activeConfig };
}
