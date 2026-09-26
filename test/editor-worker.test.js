import test, { mock } from "node:test";
import assert from "node:assert/strict";

import worker, {
  __setClerkClientFactory,
  applyOperations,
  askOpenRouter,
  describeOperations,
  detectImageType,
  extractJson,
  handleApi,
  inlinePreviewAssets,
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

test("inlines preview CSS and JS instead of leaving them as separate requests", async () => {
  const html = '<html><head><link rel="stylesheet" href="styles.css" /></head><body><script src="script.js"></script></body></html>';
  const result = await inlinePreviewAssets(html, { "styles.css": "body{color:red}", "script.js": "console.log(1)" });
  assert.equal(
    result,
    '<html><head><style>body{color:red}</style></head><body><script>console.log(1)</script></body></html>'
  );
});

test("inlines an uploaded photo as a data URI instead of a same-origin request", async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const env = {
    SITE_CONTENT: {
      async getWithMetadata(key, type) {
        assert.equal(key, "upload:abc123.png");
        assert.equal(type, "arrayBuffer");
        return { value: bytes, metadata: { contentType: "image/png" } };
      },
    },
  };
  const html = '<img src="/uploads/abc123.png" alt="A photo">';
  const result = await inlinePreviewAssets(html, {}, env);
  assert.doesNotMatch(result, /\/uploads\//);
  assert.match(result, /^<img src="data:image\/png;base64,/);
});

test("inlines a pre-existing local image (assets/...) from deployed assets, not just uploads", async () => {
  // This is the actual real-world bug: the site's own images were added
  // directly to the repo before the AI editor existed, referenced with a
  // relative path like src="assets/generated/home-hero.png" - never
  // touching /uploads/ at all. These hit the exact same sandboxed-iframe
  // CSP problem as uploaded photos and styles.css did.
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
  const env = {
    ASSETS: {
      async fetch(request) {
        assert.equal(new URL(request.url).pathname, "/assets/generated/home-hero.png");
        return new Response(bytes, { headers: { "content-type": "image/jpeg" } });
      },
    },
  };
  const html = '<img src="assets/generated/home-hero.png" alt="Hero">';
  const result = await inlinePreviewAssets(html, {}, env, "https://example.com/preview/index.html");
  assert.doesNotMatch(result, /assets\/generated/);
  assert.match(result, /^<img src="data:image\/jpeg;base64,/);
});

test("preview serves HTML with styles.css and script.js inlined, not linked", async () => {
  const env = {
    ...signedInEnv(),
    SITE_CONTENT: {
      async get(key) {
        if (key === "draft:current") {
          return {
            id: "d1",
            files: { ...files, "index.html": files["index.html"].replace("</head>", '<link rel="stylesheet" href="styles.css" /></head>') },
          };
        }
        return null;
      },
    },
  };
  const request = new Request("https://example.com/preview/index.html", {
    headers: { origin: "https://example.com" },
  });
  const response = await worker.fetch(request, env);
  const body = await response.text();
  assert.doesNotMatch(body, /<link[^>]*styles\.css/);
  assert.match(body, /<style>body \{ color: black; \}<\/style>/);
});

test("detects real image types from content, not the declared name", () => {
  assert.equal(detectImageType(new Uint8Array([0xff, 0xd8, 0xff, 0, 0])), "image/jpeg");
  assert.equal(
    detectImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])),
    "image/png"
  );
  const webp = new Uint8Array(16);
  webp.set([0x52, 0x49, 0x46, 0x46], 0);
  webp.set([0x57, 0x45, 0x42, 0x50], 8);
  assert.equal(detectImageType(webp), "image/webp");
  assert.equal(
    detectImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0])),
    "image/gif"
  );
  assert.equal(detectImageType(new Uint8Array([0x00, 0x01, 0x02, 0x03])), null);
});

function kvNamespace() {
  const store = new Map();
  const meta = new Map();
  return {
    async get(key, type) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async getWithMetadata(key, type) {
      const value = store.get(key);
      if (value === undefined) return { value: null, metadata: null };
      return { value: type === "json" ? JSON.parse(value) : value, metadata: meta.get(key) || null };
    },
    async put(key, value, options) {
      store.set(key, value);
      if (options?.metadata) meta.set(key, options.metadata);
    },
    async delete(key) {
      store.delete(key);
      meta.delete(key);
    },
  };
}

test("uploads a photo and serves it back with the sniffed content type", async () => {
  const env = { ...signedInEnv(), SITE_CONTENT: kvNamespace() };
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const formData = new FormData();
  formData.append("photo", new Blob([pngBytes], { type: "image/png" }), "photo.png");
  const uploadRequest = new Request("https://example.com/api/editor/upload", {
    method: "POST",
    headers: { origin: "https://example.com" },
    body: formData,
  });
  const uploadResponse = await handleApi(uploadRequest, env, new URL(uploadRequest.url));
  assert.equal(uploadResponse.status, 200);
  const { url } = await uploadResponse.json();
  assert.match(url, /^\/uploads\/[a-z0-9-]+\.png$/);

  const getRequest = new Request(`https://example.com${url}`);
  const getResponse = await worker.fetch(getRequest, env);
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.headers.get("content-type"), "image/png");
  const bytesBack = new Uint8Array(await getResponse.arrayBuffer());
  assert.deepEqual(Array.from(bytesBack), Array.from(pngBytes));
});

test("rejects an upload that isn't actually an image", async () => {
  const env = { ...signedInEnv(), SITE_CONTENT: kvNamespace() };
  const formData = new FormData();
  formData.append("photo", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }), "fake.png");
  const request = new Request("https://example.com/api/editor/upload", {
    method: "POST",
    headers: { origin: "https://example.com" },
    body: formData,
  });
  const response = await handleApi(request, env, new URL(request.url));
  assert.equal(response.status, 400);
});

test("ignores an imageUrl that isn't one of this app's own uploads", async () => {
  const requests = [];
  mock.method(globalThis, "fetch", async (requestUrl, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ message: "Done", operations: [] }) } }],
    }), { headers: { "content-type": "application/json" } });
  });
  const env = {
    ...signedInEnv(),
    OPENROUTER_API_KEY: "test-key",
    SITE_CONTENT: kvNamespace(),
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
    body: JSON.stringify({ message: "hi", imageUrl: "https://attacker.example/payload.jpg" }),
  });
  await handleApi(request, env, new URL(request.url));
  const userMessage = requests[0].messages.find(m => m.role === "user");
  assert.equal(typeof userMessage.content, "string");
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
  assert.throws(
    () => validateFiles({ ...files, "styles.css": "body { color: black; } .nav { display: flex;" }),
    /syntax error/
  );
  assert.throws(
    () => validateFiles({ ...files, "styles.css": "body { color: black; } /* oops, never closed" }),
    /unclosed comment/
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
