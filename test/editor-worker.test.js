import test from "node:test";
import assert from "node:assert/strict";

import { applyOperations, askWorkersAI, extractJson, isAllowedPath, validateFiles } from "../_worker.js";

const files = {
  "index.html": "<!doctype html><html><head><title>Home</title></head><body><h1>Hello</h1></body></html>",
  "styles.css": "body { color: black; }",
  "script.js": "console.log('ready');",
};

test("applies an exact guarded edit", () => {
  const result = applyOperations(files, [
    { path: "index.html", find: "<h1>Hello</h1>", replace: "<h1>Welcome</h1>" },
  ]);
  assert.match(result["index.html"], /Welcome/);
  assert.match(files["index.html"], /Hello/);
});

test("rejects edits that do not change any file", () => {
  assert.throws(() => applyOperations(files, []), /did not produce a visible change/);
  assert.throws(
    () => applyOperations(files, [{ path: "index.html", find: "<h1>Hello</h1>", replace: "<h1>Hello</h1>" }]),
    /did not produce a visible change/
  );
});

test("allows a complete new public page", () => {
  const result = applyOperations(files, [
    {
      path: "faq.html",
      content: "<!doctype html><html><head><title>FAQ</title></head><body><h1>FAQ</h1></body></html>",
    },
  ]);
  assert.ok(result["faq.html"]);
});

test("accepts string and structured AI JSON responses", () => {
  const response = { message: "Done", operations: [] };
  assert.deepEqual(extractJson(JSON.stringify(response)), response);
  assert.equal(extractJson(response), response);
});

test("retries when Workers AI returns prose instead of JSON", async () => {
  const calls = [];
  const env = {
    AI: {
      async run(model, options) {
        calls.push({ model, options });
        return calls.length === 1
          ? { response: "Changed the services page." }
          : { response: { message: "Done", operations: [{ path: "services.html", find: "old", replace: "new" }] } };
      },
    },
  };

  const result = await askWorkersAI(env, [{ role: "user", content: "Update services" }]);
  assert.equal(calls.length, 2);
  assert.equal(result.operations[0].path, "services.html");
  assert.match(calls[1].options.messages.at(-1).content, /Return only the required JSON object/);
});

test("rejects protected paths and ambiguous replacements", () => {
  assert.equal(isAllowedPath("_worker.js"), false);
  assert.equal(isAllowedPath("ADMIN.html"), false);
  assert.throws(() => applyOperations(files, [{ path: "_worker.js", content: "no" }]), /protected file/);
  assert.throws(
    () => applyOperations({ ...files, "styles.css": "red red" }, [{ path: "styles.css", find: "red", replace: "blue" }]),
    /ambiguous/
  );
});

test("rejects unsafe or structurally broken output", () => {
  assert.throws(
    () => validateFiles({ ...files, "index.html": "<html><body><a href=\"javascript:alert(1)\">x</a></body></html>" }),
    /unsafe reference/
  );
  assert.throws(
    () => validateFiles({ ...files, "index.html": "<html><body>Missing title</body></html>" }),
    /required page structure/
  );
});