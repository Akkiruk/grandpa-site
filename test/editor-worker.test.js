import test, { mock } from "node:test";
import assert from "node:assert/strict";

import {
  __setClerkClientFactory,
  applyOperations,
  askOpenRouter,
  describeOperations,
  extractJson,
  handleApi,
  isAllowedPath,
  validateFiles,
} from "../_worker.js";

const files = {
  "index.html": "<!doctype html><html><head><title>Home</title></head><body><h1>Hello</h1></body></html>",
  "styles.css": "body { color: black; }",
  "script.js": "console.log('ready');",
};

function fakeClerkClient({ userId = "user_test", secretKey = "sk_test" } = {}) {
  return env => {
    if (env.secretKey !== secretKey || !userId) {
      return { authenticateRequest: async () => ({ toAuth: () => ({ userId: null }) }) };
    }
    return { authenticateRequest: async () => ({ toAuth: () => ({ userId }) }) };
  };
}

function signedInEnv(overrides = {}) {
  __setClerkClientFactory(fakeClerkClient());
  return { CLERK_SECRET_KEY: "sk_test", CLERK_PUBLISHABLE_KEY: "pk_test", ...overrides };
}

test.afterEach(() => {
  __setClerkClientFactory(null);
  mock.restoreAll();
});

test("matches and edits a file that still has CRLF line endings", () => {
  // Real-world scenario that caused every multi-line edit to fail: a file
  // stored with Windows CRLF endings, and an AI response (always plain LF,
  // regardless of model) trying to find/replace multi-line text in it.
  const crlfFiles = {
    ...files,
    "index.html": "<!doctype html><html>\r\n<head><title>Home</title></head>\r\n<body>\r\n<h1>Hello</h1>\r\n</body>\r\n</html>",
  };
  const result = applyOperations(crlfFiles, [
    { path: "index.html", find: "<body>\n<h1>Hello</h1>\n</body>", replace: "<body>\n<h1>Welcome</h1>\n</body>" },
  ]);
  assert.match(result["index.html"], /Welcome/);
  assert.doesNotMatch(result["index.html"], /\r\n/);
});

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

test("rejects protected paths and ambiguous replacements", () => {
  assert.equal(isAllowedPath("_worker.js"), false);
  assert.equal(isAllowedPath("ADMIN.html"), false);
  assert.throws(() => applyOperations(files, [{ path: "_worker.js", content: "no" }]), /protected file/);
  assert.throws(
    () => applyOperations({ ...files, "styles.css": "red red" }, [{ path: "styles.css", find: "red", replace: "blue" }]),
    /ambiguous/
  );
});

test("the AI editor can never touch the editor, auth, or deployment surface itself", () => {
  // Any path with a slash fails the allowlist regex outright, so nothing
  // inside admin/ is reachable no matter the filename.
  const forbiddenPaths = [
    "admin/index.html",
    "admin/app.js",
    "admin/admin.css",
    "admin.html",
    "Admin.HTML",
    "_worker.js",
    "wrangler.toml",
    "package.json",
    "package-lock.json",
    ".env",
    "_headers",
    "failed/index.html",
    "test/editor-worker.test.js",
    "../admin/index.html",
    "..%2Fadmin%2Findex.html",
  ];
  for (const path of forbiddenPaths) {
    assert.equal(isAllowedPath(path), false, `expected ${path} to be blocked`);
    assert.throws(
      () => applyOperations(files, [{ path, content: "<!doctype html><html><head><title>x</title></head><body></body></html>" }]),
      /protected file/,
      `expected a content operation on ${path} to be rejected`
    );
  }
  // The same allowlist is re-checked at publish time, independent of the
  // chat-time check, so a draft can't smuggle a bad path through either.
  for (const path of forbiddenPaths) {
    assert.throws(() => validateFiles({ ...files, [path]: "anything" }), /Invalid site file/);
  }
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

test("describes accepted changes for the editor receipt", () => {
  const operations = [
    { path: "index.html", find: "Hello", replace: "Welcome" },
    { path: "styles.css", find: "black", replace: "navy" },
  ];
  const result = applyOperations(files, operations);
  assert.deepEqual(describeOperations(files, result, operations), {
    files: ["index.html", "styles.css"],
    operationCount: 2,
    previewPath: "index.html",
  });
});

test("undo restores stacked drafts and then returns to the live site", async () => {
  const values = new Map();
  const kv = {
    async get(key, type) {
      const value = values.get(key);
      return type === "json" && value !== undefined ? JSON.parse(value) : value ?? null;
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
  let aiCall = 0;
  mock.method(globalThis, "fetch", async () => {
    aiCall += 1;
    const content = aiCall === 1
      ? { message: "Changed greeting.", operations: [{ path: "index.html", find: "Hello", replace: "Welcome" }] }
      : { message: "Changed it again.", operations: [{ path: "index.html", find: "Welcome", replace: "Howdy" }] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
      headers: { "content-type": "application/json" },
    });
  });
  const env = {
    ...signedInEnv(),
    OPENROUTER_API_KEY: "test-key",
    SITE_CONTENT: kv,
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname.slice(1);
        if (path === "styles.css") return new Response("body { color: black; }");
        if (path === "script.js") return new Response("console.log('ready');");
        const title = path === "index.html" ? "Home" : path;
        const body = path === "index.html" ? "Hello" : path;
        return new Response(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);
      },
    },
  };
  const call = async (path, method, body) => {
    const request = new Request(`https://example.com/api/editor/${path}`, {
      method,
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return handleApi(request, env, new URL(request.url));
  };

  assert.equal((await call("chat", "POST", { message: "Change hello" })).status, 200);
  assert.equal((await call("chat", "POST", { message: "Change it again" })).status, 200);
  assert.match((await kv.get("draft:current", "json")).files["index.html"], /Howdy/);

  const firstUndo = await (await call("undo", "POST", {})).json();
  assert.equal(firstUndo.draft.canUndo, true);
  assert.match((await kv.get("draft:current", "json")).files["index.html"], /Welcome/);

  const secondUndo = await (await call("undo", "POST", {})).json();
  assert.equal(secondUndo.draft, null);
  assert.equal(await kv.get("draft:current", "json"), null);
});

test("blocks authenticated cross-site mutations", async () => {
  const request = new Request("https://example.com/api/editor/publish", {
    method: "POST",
    headers: { origin: "https://attacker.example" },
    body: "{}",
  });
  const response = await handleApi(request, signedInEnv(), new URL(request.url));
  assert.equal(response.status, 403);
});

test("blocks mutations with no Origin or Referer header", async () => {
  const request = new Request("https://example.com/api/editor/publish", {
    method: "POST",
    body: "{}",
  });
  const response = await handleApi(request, signedInEnv(), new URL(request.url));
  assert.equal(response.status, 403);
});

test("rejects requests without a valid Clerk session", async () => {
  __setClerkClientFactory(fakeClerkClient({ userId: null }));
  const request = new Request("https://example.com/api/editor/status", {
    headers: { origin: "https://example.com" },
  });
  const env = { CLERK_SECRET_KEY: "sk_test", CLERK_PUBLISHABLE_KEY: "pk_test" };
  const response = await handleApi(request, env, new URL(request.url));
  assert.equal(response.status, 401);
});

test("rejects a draft write when another request changed the draft first", async () => {
  let draftGetCalls = 0;
  const store = new Map();
  mock.method(globalThis, "fetch", async () => {
    const content = { message: "Changed greeting.", operations: [{ path: "index.html", find: "Hello", replace: "Welcome" }] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
      headers: { "content-type": "application/json" },
    });
  });
  const env = {
    ...signedInEnv(),
    OPENROUTER_API_KEY: "test-key",
    SITE_CONTENT: {
      async get(key, type) {
        if (key === "draft:current") {
          draftGetCalls += 1;
          // The first two reads (the chat handler's own check, then getDraft's
          // fallback read) see no draft. The third read - inside the guarded
          // write - simulates a concurrent request having created one.
          return draftGetCalls <= 2 ? null : "concurrent-write";
        }
        const value = store.get(key);
        return type === "json" && value !== undefined ? JSON.parse(value) : value ?? null;
      },
      async put(key, value) { store.set(key, value); },
      async delete(key) { store.delete(key); },
    },
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname.slice(1);
        if (path === "styles.css") return new Response("body { color: black; }");
        if (path === "script.js") return new Response("console.log('ready');");
        return new Response("<!doctype html><html><head><title>Home</title></head><body>Hello</body></html>");
      },
    },
  };
  const request = new Request("https://example.com/api/editor/chat", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.com" },
    body: JSON.stringify({ message: "Change hello" }),
  });
  const response = await handleApi(request, env, new URL(request.url));
  assert.equal(response.status, 409);
});

test("uses the configured OpenRouter coding model without exposing the key", async () => {
  let request;
  const result = await askOpenRouter(
    { OPENROUTER_API_KEY: "test-key" },
    [{ role: "user", content: "Update services" }],
    async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ message: "Done", operations: [] }) } }],
      }), { headers: { "content-type": "application/json" } });
    }
  );

  const body = JSON.parse(request.options.body);
  assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(request.options.headers.authorization, "Bearer test-key");
  assert.equal(body.model, "openai/gpt-5.1");
  assert.equal(body.response_format.type, "json_object");
  assert.equal(result.message, "Done");
});

test("retries malformed OpenRouter output with the chosen model", async () => {
  const requests = [];
  const result = await askOpenRouter(
    { OPENROUTER_API_KEY: "test-key", OPENROUTER_MODEL: "some-org/some-test-model" },
    [{ role: "user", content: "Update services" }],
    async (url, options) => {
      requests.push(JSON.parse(options.body));
      const content = requests.length === 1
        ? "I updated it."
        : JSON.stringify({ message: "Done", operations: [{ path: "services.html", find: "old", replace: "new" }] });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        headers: { "content-type": "application/json" },
      });
    }
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, "some-org/some-test-model");
  assert.equal(requests[1].model, "some-org/some-test-model");
  assert.match(requests[1].messages.at(-1).content, /Return only the required JSON object/);
  assert.equal(result.message, "Done");
});
