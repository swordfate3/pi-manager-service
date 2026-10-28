import path from "node:path";
import { build } from "vite";
const root=path.resolve(import.meta.dirname,"..");
// Deliberately separate bundles. Public entry must not pull privileged imports
// through shared chunks, lazy imports, or a combined command dispatcher.
for(const [index,role] of ["service","public","admin","executor","chat","local"].entries()) {
  await build({configFile:false,root,publicDir:false,build:{
    ssr:path.join(root,"bin",`pi-manager-${role}.mjs`),outDir:"dist/manager",emptyOutDir:index===0,target:"node22",minify:false,
    rolldownOptions:{external:[/^node:/],output:{format:"esm",entryFileNames:`pi-manager-${role}.mjs`,codeSplitting:false}},
  }});
}
