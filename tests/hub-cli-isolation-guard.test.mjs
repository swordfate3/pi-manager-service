import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directCliFiles = [
  "tests/socket/hub-state-budget.test.ts",
  "tests/socket/hub-bounded-registry.test.ts",
];

function containsDirectCliPath(node) {
  let found = false;
  const visit = (child) => {
    if (ts.isStringLiteral(child) && child.text === "bin/pi-web-hub.mjs") found = true;
    if (!found) ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

test("every direct state-capable Hub CLI child supplies an isolated environment", () => {
  let directChildren = 0;
  for (const relative of directCliFiles) {
    const source = ts.createSourceFile(
      relative,
      readFileSync(path.join(root, relative), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ["spawn", "spawnSync"].includes(node.expression.text) &&
        node.arguments[1] &&
        containsDirectCliPath(node.arguments[1])
      ) {
        directChildren += 1;
        const options = node.arguments[2];
        assert.ok(ts.isObjectLiteralExpression(options), `${relative} direct CLI child requires explicit options`);
        const envProperty = options.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) &&
            ((ts.isIdentifier(property.name) && property.name.text === "env") ||
              (ts.isStringLiteral(property.name) && property.name.text === "env")),
        );
        assert.ok(ts.isPropertyAssignment(envProperty), `${relative} direct CLI child requires an explicit isolated env`);
        assert.ok(
          ts.isPropertyAccessExpression(envProperty.initializer) &&
            ts.isIdentifier(envProperty.initializer.expression) &&
            envProperty.initializer.expression.text === "f" &&
            envProperty.initializer.name.text === "cliEnvironment",
          `${relative} direct CLI child env must be the fixture's isolated f.cliEnvironment`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.equal(directChildren, 4, "guard must cover the four reviewed direct state-capable children");
});
