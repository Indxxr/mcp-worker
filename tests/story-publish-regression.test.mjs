import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const serverSource = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");

test("waits for Instagram media container to finish before publishing", () => {
  assert.match(serverSource, /async function waitForInstagramContainer\s*\(/);
  assert.match(serverSource, /fields=status_code,status/);

  const waitCall = serverSource.indexOf("await waitForInstagramContainer(");
  const publishCall = serverSource.indexOf("/media_publish");

  assert.notEqual(waitCall, -1, "expected a container readiness wait");
  assert.notEqual(publishCall, -1, "expected a media_publish call");
  assert.ok(
    waitCall < publishCall,
    "container readiness must be checked before media_publish"
  );
});

test("keeps the legacy story import tool name for connector compatibility", () => {
  assert.match(serverSource, /registerTool\(\s*"import_story_media"/);
  assert.match(serverSource, /registerTool\(\s*"upload_story_media"/);
});
