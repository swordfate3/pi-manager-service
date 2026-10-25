import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream";
import { constants, createBrotliCompress, createGzip } from "node:zlib";
import { HUB_LIMITS } from "./limits.ts";

let activeCompressors = 0;

function encoding(accept: string | undefined): "br" | "gzip" | undefined {
  if (!accept) return;
  const qualities = new Map<string, number>();
  for (const part of accept.split(",")) {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    const weight = parameters.find((value) => value.trim().startsWith("q="));
    const quality = weight === undefined ? 1 : Number(weight.trim().slice(2));
    qualities.set(name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0);
  }
  const quality = (name: string) => qualities.get(name) ?? qualities.get("*") ?? 0;
  if (quality("br") > 0 && quality("br") >= quality("gzip")) return "br";
  if (quality("gzip") > 0) return "gzip";
}

/** Compress only public build assets, never reflected session/API/download data. */
export function proxySessionResponse(
  request: IncomingMessage,
  response: ServerResponse,
  upstream: IncomingMessage,
  resource: string,
) {
  const headers = { ...upstream.headers };
  delete headers["set-cookie"];
  delete headers.connection;
  for (const key of Object.keys(headers)) if (key.startsWith("x-pi-hub-")) delete headers[key];
  headers["cache-control"] = "no-store";

  // Query strings, ranges and backend cache/privacy directives are deliberately
  // excluded. Generation proof is still checked before reaching this helper.
  const asset = /^\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(js|css)$/.exec(resource);
  const mime = upstream.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  const staticAsset =
    asset &&
    (request.method === "GET" || request.method === "HEAD") &&
    upstream.statusCode === 200 &&
    !request.headers.range &&
    !upstream.headers["cache-control"] &&
    !upstream.headers["content-range"] &&
    !upstream.headers["content-disposition"] &&
    !upstream.headers["content-encoding"] &&
    !upstream.headers["set-cookie"] &&
    (asset[1] === "css" ? mime === "text/css" : mime === "application/javascript" || mime === "text/javascript");
  let coding: "br" | "gzip" | undefined;
  if (staticAsset) {
    // Private, generation-scoped browser caching only; never a shared Hub/CDN cache.
    headers["cache-control"] = "private, max-age=86400, immutable";
    const vary = (headers.vary ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!vary.some((value) => value === "*" || value.toLowerCase() === "accept-encoding")) vary.push("Accept-Encoding");
    headers.vary = vary.join(", ");
    coding = encoding(request.headers["accept-encoding"]);
    if (request.method !== "HEAD" && activeCompressors >= HUB_LIMITS.httpCompression) coding = undefined;
    if (coding) {
      headers["content-encoding"] = coding;
      for (const name of ["content-length", "etag", "content-md5", "digest"]) delete headers[name];
    }
  }

  upstream.once("error", () => response.destroy());
  response.writeHead(upstream.statusCode ?? 502, headers);
  if (request.method === "HEAD") {
    upstream.resume();
    response.end();
  } else if (coding) {
    activeCompressors++;
    // Streaming keeps memory bounded and propagates backpressure/abort through
    // both sockets. Moderate levels avoid blocking a single-core Hub on Brotli.
    const compressor =
      coding === "br"
        ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
        : createGzip({ level: 6 });
    pipeline(upstream, compressor, response, (error) => {
      activeCompressors--;
      if (error) response.destroy();
    });
  } else {
    upstream.pipe(response);
  }
}
