import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildDocsOpenApi, resolveDocsApiUpstream } from "./contract";

describe("docs API upstream configuration", () => {
  test("requires an explicit upstream URL", () => {
    assert.deepEqual(resolveDocsApiUpstream({ DOCS_API_UPSTREAM_URL: undefined }), {
      ok: false,
      code: "MISSING",
      message: "DOCS_API_UPSTREAM_URL is not configured",
    });
  });

  test("normalizes whitespace and one trailing slash", () => {
    assert.deepEqual(
      resolveDocsApiUpstream({
        DOCS_API_UPSTREAM_URL: "  https://docs.example.test/api/docs///  ",
      }),
      {
        ok: true,
        url: "https://docs.example.test/api/docs",
      },
    );
  });

  test("rejects unsafe or ambiguous upstream values", () => {
    assert.equal(resolveDocsApiUpstream({ DOCS_API_UPSTREAM_URL: "file:///tmp/docs" }).ok, false);
    assert.equal(
      resolveDocsApiUpstream({
        DOCS_API_UPSTREAM_URL: "https://docs.example.test?q=wrong",
      }).ok,
      false,
    );
  });
});

describe("docs API OpenAPI contract", () => {
  test("publishes stable, unique operation IDs with success responses", () => {
    const schema = buildDocsOpenApi("https://joelclaw.com", "0.2.0");
    const operations = Object.values(schema.paths).map((path) => path.get);
    const operationIds = operations.map((operation) => operation.operationId);

    assert.deepEqual(schema.servers, [{ url: "https://joelclaw.com/api/docs" }]);
    assert.equal(operations.length, 8);
    assert.equal(new Set(operationIds).size, operationIds.length);
    assert.ok(operationIds.includes("search_docs"));
    assert.ok(operationIds.includes("get_chunk"));
    assert.ok(operationIds.includes("check_docs_health"));

    for (const operation of operations) {
      assert.ok(operation.responses["200"]);
    }
  });

  test("exposes booleans as booleans for generated clients", () => {
    const schema = buildDocsOpenApi("https://joelclaw.com", "0.2.0");
    const search = schema.paths["/search"].get;
    const chunk = schema.paths["/chunks/{id}"].get;

    assert.equal(
      search.parameters.find((parameter) => parameter.name === "semantic")?.schema.type,
      "boolean",
    );
    assert.equal(
      chunk.parameters.find((parameter) => parameter.name === "lite")?.schema.type,
      "boolean",
    );
  });
});
