import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import test from "node:test";
import { proxyLocalUpgrade } from "../manager/local-websocket.ts";
const stream=()=>new Duplex({read(){},write(_chunk,_encoding,done){done();}});
test("browser close before upstream 101 cancels pending and late proxy legs",async()=> {
  const browser=stream(),connection=stream(),pending=new EventEmitter() as any;
  pending.end=()=>{};pending.destroy=()=>{pending.cancelled=true;};let opened=0,closed=0;
  proxyLocalUpgrade({url:"http://127.0.0.1:1/s/test/ws",headers:{},browser,head:Buffer.alloc(0),valid:()=>true,
    onOpen:()=>{opened++;},onClose:()=>{closed++;}},()=>pending);
  browser.destroy();await new Promise(resolve=>setImmediate(resolve));
  pending.emit("upgrade",{headers:{connection:"Upgrade",upgrade:"websocket"}},connection,Buffer.alloc(0));
  assert.equal(pending.cancelled,true);assert.equal(connection.destroyed,true);assert.equal(opened,0);assert.equal(closed,1);
});
test("revocation during pending upgrade never accepts the late connection",()=> {
  const browser=stream(),connection=stream(),pending=new EventEmitter() as any;pending.end=()=>{};pending.destroy=()=>{};
  let valid=true,opened=0;
  proxyLocalUpgrade({url:"http://127.0.0.1:1/",headers:{},browser,head:Buffer.alloc(0),valid:()=>valid,onOpen:()=>{opened++;},onClose:()=>{}},()=>pending);
  valid=false;pending.emit("upgrade",{headers:{}},connection,Buffer.alloc(0));assert.equal(opened,0);assert.equal(connection.destroyed,true);assert.equal(browser.destroyed,true);
});
test("a peer FIN before 101 cancels a half-open upgraded socket before close fires",()=> {
  const browser=stream(),pending=new EventEmitter() as any;pending.end=()=>{};pending.destroy=()=>{pending.cancelled=true;};
  proxyLocalUpgrade({url:"http://127.0.0.1:1/",headers:{},browser,head:Buffer.alloc(0),valid:()=>true,onOpen:()=>{},onClose:()=>{}},()=>pending);
  browser.emit("end");assert.equal(pending.cancelled,true);assert.equal(browser.destroyed,true);
});
