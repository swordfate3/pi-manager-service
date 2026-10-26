import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("service is distributed as separate runnable authority entries without replacing Hub CLI", () => {
  const pkg=JSON.parse(readFileSync("package.json","utf8"));
  assert.equal(pkg.bin["pi-manager"],"dist/hub/pi-web-hub.mjs");
  for(const name of ["service","public","admin","executor"]) assert.equal(pkg.bin["pi-manager-"+name],`dist/manager/pi-manager-${name}.mjs`);
  const home=mkdtempSync(path.join(tmpdir(),"manager-dist-home-"));
  try {
    const result=spawnSync(process.execPath,["dist/manager/pi-manager-service.mjs","--help"],{encoding:"utf8",env:{PATH:process.env.PATH,HOME:home}});
    assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/trusted-local development/);
    const testResult=spawnSync(process.execPath,["--import","./tests/register-ts.mjs","--test","tests/manager-entry.test.ts"],{encoding:"utf8",env:{PATH:process.env.PATH,HOME:home,PI_MANAGER_TEST_ENTRY:path.resolve("dist/manager/pi-manager-service.mjs")},timeout:20000});
    assert.equal(testResult.status,0,testResult.stdout+testResult.stderr);
  }finally{rmSync(home,{recursive:true,force:true});}
});
