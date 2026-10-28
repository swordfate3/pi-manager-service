import { request, type OutgoingHttpHeaders, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

interface UpgradeOptions {
  url:string;headers:OutgoingHttpHeaders;browser:Duplex;head:Buffer;
  valid():boolean;onOpen():void;onClose():void;
  responseHeaders?(headers:IncomingMessage["headers"]):OutgoingHttpHeaders;
}
/** Own both legs, including the interval before a backend returns its 101. */
export function proxyLocalUpgrade(options:UpgradeOptions,open:typeof request=request) {
  const {browser,head}=options;
  let pending:ReturnType<typeof request>|undefined,connection:Duplex|undefined,closed=false;
  let deadline:ReturnType<typeof setTimeout>|undefined;
  const cleanup=()=> {
    if(closed) return;closed=true;clearTimeout(deadline);options.onClose();
    pending?.destroy();connection?.destroy();browser.destroy();
  };
  browser.once("close",cleanup);browser.once("end",cleanup);browser.once("error",cleanup);
  if(browser.destroyed) {cleanup();return;}
  try {
    pending=open(options.url,{headers:options.headers});
    deadline=setTimeout(cleanup,10000);deadline.unref();
    pending.on("upgrade",(response,upstream,extra)=> {
      clearTimeout(deadline);
      try {
        if(closed || browser.destroyed || !options.valid()) {upstream.destroy();cleanup();return;}
        connection=upstream;options.onOpen();
        upstream.once("close",cleanup);upstream.once("error",cleanup);
        const headers=options.responseHeaders ? options.responseHeaders(response.headers) : response.headers;
        browser.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(headers).map(([key,value])=>`${key}: ${value}`).join("\r\n")}\r\n\r\n`);
        if(extra.length) browser.write(extra);if(head.length) upstream.write(head);
        browser.pipe(upstream).pipe(browser);
      } catch {upstream.destroy();cleanup();}
    });
    pending.on("response",response=> {
      clearTimeout(deadline);response.resume();
      if(!closed && !browser.destroyed) browser.end(`HTTP/1.1 ${response.statusCode ?? 502} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
    pending.once("error",cleanup);pending.end();
  } catch {cleanup();}
}
