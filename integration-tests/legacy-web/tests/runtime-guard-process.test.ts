import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const guardPath = new URL("../extensions/runtime-stdin-guard.mjs", import.meta.url).pathname;
for (const flag of [undefined, false, true]) {
  for (const idle of [true, false]) {
    test(`Web dispatcher taints before async command and ACK: flag=${flag}, idle=${idle}`, () => {
      // Execute the actual nested dispatcher; only SDK/context boundaries are
      // synthetic here. Real SDK/WS/prepare coverage lives in the TUI fixture.
      const source = `
        import assert from 'node:assert/strict';
        import {readFileSync} from 'node:fs';
        import vm from 'node:vm';
        import ts from 'typescript';
        import {taintRuntimeInput} from './extensions/runtime-control.ts';
        const file=ts.createSourceFile('mirror-server.ts',readFileSync('./extensions/mirror-server.ts','utf8'),ts.ScriptTarget.Latest,true);
        let declaration;
        function visit(node) {
          if(ts.isFunctionDeclaration(node)&&node.name?.text==='handleRequest') declaration=node;
          ts.forEachChild(node,visit);
        }
        visit(file); assert.ok(declaration);
        const guard=globalThis[Symbol.for('pi.runtime.stdin-guard.v1')];
        let release, finished=false, safeAtDispatch, dispatched;
        const held=new Promise(resolve=>release=resolve);
        const responses=[];
        const context=vm.createContext({
          latestCtx:{isIdle:()=>${idle}}, runtimeStopping:false, runtimeControl:undefined,
          revisionAttempt:false, revisionDispatchUnknown:false, activeBrowserMutations:0,
          sessionReplacementPending:false, internalCommands:new Set(), taintRuntimeInput,
          sendTo:(_ws,response)=>responses.push(response),
          pi:{
            getCommands:()=>[{name:'guard-hold'}],
            sendUserMessage:(message,options)=>{
              assert.equal(message,'/guard-hold'); assert.equal(options.expandPromptTemplates,true);
              safeAtDispatch=guard.safe();
              dispatched=(async()=>{await held;finished=true;})();
            }
          }
        });
        const js=ts.transpileModule(declaration.getText(file),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
        vm.runInContext(js,context);
        await context.handleRequest({}, {id:'test',method:'prompt',params:${JSON.stringify({ message: "/guard-hold", executePiCommand: flag })}});
        try {
          assert.equal(responses.length,1); assert.equal(responses[0].ok,true);
          assert.equal(context.activeBrowserMutations,0); assert.equal(finished,false);
          assert.equal(safeAtDispatch,false,'guard must be tainted before the SDK sees the command');
          assert.equal(guard.safe(),false,'ACK cannot make the command restart-safe');
        } finally { release(); await dispatched; }
        assert.equal(guard.safe(),false,'completion cannot reset uncertainty');
      `;
      const result = spawnSync(
        process.execPath,
        ["--import", guardPath, "--import", "./tests/register-ts.mjs", "--input-type=module", "-e", source],
        { encoding: "utf8", timeout: 10000 },
      );
      assert.equal(result.status, 0, result.stderr);
    });
  }
}
for (const scenario of [
  "absent",
  "incompatible",
  "displaced",
  "tainted",
  "unknown-sdk",
  "oversized",
  "lease",
  "stale-close",
  "shutdown",
] as const) {
  test(`runtime IPC guard fails closed: ${scenario}`, () => {
    const source = `
      import assert from 'node:assert/strict';
      import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
      import net from 'node:net'; import path from 'node:path'; import {tmpdir} from 'node:os';
      import {startRuntimeControl} from './extensions/runtime-control.ts';
      const scenario=${JSON.stringify(scenario)};
      const key=Symbol.for('pi.runtime.stdin-guard.v1');
      if(scenario==='incompatible') Object.defineProperty(globalThis,key,{value:Object.freeze({version:99}),configurable:false,writable:false});
      const guard=globalThis[key];
      if(scenario==='displaced') process.stdin.emit=()=>true;
      if(scenario==='tainted') guard.taint();
      const directory=mkdtempSync(path.join(tmpdir(),'runtime-guard-child-'));
      const file=path.join(directory,'saved.jsonl'); writeFileSync(file,'saved');
      const token='a'.repeat(64), operation='b'.repeat(32);
      let value={run_id:'c'.repeat(32),runtime_id:'r',session_id:'s',leaf_id:null,session_file:file,cwd:directory,version:scenario==='unknown-sdk'?'nightly-unversioned':'1.1.0',idle:true,pending:false,busy:false,provider:'faux',model:'faux',thinking:'off'};
      if(scenario==='oversized') value.cwd='/'+'x'.repeat(20000);
      const socket=path.join(directory,'adapter.sock');
      const adapter=await startRuntimeControl({PI_RUNTIME_RUN_ID:value.run_id,PI_RUNTIME_CHILD_TOKEN:token,PI_RUNTIME_EXTENSION_SOCKET:socket},()=>value);
      const call=(action,extra={})=>new Promise((resolve,reject)=>{const peer=net.createConnection(socket,()=>peer.end(JSON.stringify({action,token,...extra})+'\\n'));let data='';peer.on('data',c=>data+=c);peer.on('end',()=>resolve(JSON.parse(data)));peer.on('error',reject);});
      const prepare={operation_id:operation,expected:{runtime_id:'r',session_id:'s',leaf_id:null}};
      try {
        if(['lease','stale-close','shutdown'].includes(scenario)) {
          assert.equal((await call('prepare',prepare)).ok,true);
          let delivered=0; process.stdin.on('data',()=>delivered++);
          if(scenario==='lease') {
            process.stdin.emit('data','/model unsafe'); assert.equal(delivered,0);
            const original=Date.now; Date.now=()=>original()+150001;
            assert.equal(adapter.prepared,false); Date.now=original;
            assert.equal((await call('snapshot')).result.busy,true);
            process.stdin.emit('data','/quit'); assert.equal(delivered,1);
          } else if(scenario==='shutdown') {
            await adapter.close(true); process.stdin.emit('data','/quit'); assert.equal(delivered,0);
          } else {
            await call('cancel',{operation_id:operation}); await adapter.close();
            const successor=await startRuntimeControl({PI_RUNTIME_RUN_ID:value.run_id,PI_RUNTIME_CHILD_TOKEN:token,PI_RUNTIME_EXTENSION_SOCKET:socket},()=>value);
            assert.equal((await call('prepare',{...prepare,operation_id:'d'.repeat(32)})).ok,true);
            await adapter.close(); process.stdin.emit('data','/name unsafe'); assert.equal(delivered,0);
            await successor.close(); assert.equal(guard.safe(),false);
          }
        } else {
          const snapshot=await call('snapshot');
          if(scenario==='oversized') assert.equal(snapshot.ok,false);
          else assert.equal(snapshot.result.busy,true);
          assert.equal((await call('prepare',prepare)).ok,false);
          assert.equal(adapter.prepared,false);
        }
      } finally {await adapter.close();rmSync(directory,{recursive:true,force:true});}
    `;
    const result = spawnSync(
      process.execPath,
      [
        ...(["absent", "incompatible"].includes(scenario) ? [] : ["--import", guardPath]),
        "--import",
        "./tests/register-ts.mjs",
        "--input-type=module",
        "-e",
        source,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
  });
}
