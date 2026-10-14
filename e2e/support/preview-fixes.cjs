// Loaded into the browser tests' preview server only (see playwright.config.ts),
// to steady two faults in the local link between Miniflare and the Workers
// runtime. Neither exists on Cloudflare, where there is no such link.

// 1. Node 24.21 gave sockets setTypeOfService, and undici (inside Miniflare)
// calls it for every request. macOS refuses it for some local sockets with
// EINVAL, which fails the request or, thrown outside any handler, stops the
// server. The type of service means nothing on a local connection.
const net = require("node:net");

const setTypeOfService = net.Socket.prototype.setTypeOfService;
if (setTypeOfService) {
  net.Socket.prototype.setTypeOfService = function (...args) {
    try {
      return setTypeOfService.apply(this, args);
    } catch (error) {
      if (error && error.code === "EINVAL") return this;
      throw error;
    }
  };
}

// 2. Miniflare reuses kept-alive connections to the runtime, and now and then
// sends on one the runtime has just closed: the request fails with
// ECONNRESET before the Worker sees it, and a page loses a script and never
// hydrates. A read cannot change anything, so GET and HEAD are tried once
// more on a fresh connection. Writes are never repeated.
const undici = require("undici");

const fetch = undici.fetch;
const resetBeforeAnswer = (failure) => {
  for (let cause = failure && failure.cause; cause; cause = cause.cause) {
    if (cause.code === "ECONNRESET" || cause.code === "UND_ERR_SOCKET") return true;
  }
  return false;
};
undici.fetch = async (input, init) => {
  const method = (input && input.method) || (init && init.method) || "GET";
  const reads = method === "GET" || method === "HEAD";
  try {
    return await fetch(input, init);
  } catch (failure) {
    if (!reads || !resetBeforeAnswer(failure)) throw failure;
    return fetch(input, init);
  }
};
