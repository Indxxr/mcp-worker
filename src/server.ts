import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
  FLOPPY_MEDIA: R2Bucket;
  INSTAGRAM_PUBLISH_TOKEN: string;
};

const INSTAGRAM_ID = "17841402148601055";
const INSTAGRAM_GRAPH_VERSION = "v26.0";

async function importStoryMedia(image_url: string, env: Env) {
  if (!image_url.startsWith("https://")) {
    throw new Error("Image URL must use HTTPS.");
  }

  const response = await fetch(image_url);

  if (!response.ok) {
    throw new Error(`Image download failed: HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  const detectedType = contentType.split(";")[0].trim().toLowerCase();

  if (!allowedTypes.includes(detectedType)) {
    throw new Error(`Unsupported image type: ${detectedType || "unknown"}`);
  }

  const data = await response.arrayBuffer();

  if (!data.byteLength) {
    throw new Error("Downloaded image is empty.");
  }

  if (data.byteLength > 15 * 1024 * 1024) {
    throw new Error("Image is too large.");
  }

  const ext =
    detectedType === "image/png"
      ? "png"
      : detectedType === "image/webp"
      ? "webp"
      : "jpg";

  const key =
    "stories/" +
    Date.now() +
    "-" +
    crypto.randomUUID() +
    "." +
    ext;

  await env.FLOPPY_MEDIA.put(key, data, {
    httpMetadata: {
      contentType: detectedType
    }
  });

  const public_url =
    `https://pub-7e189893d4e1431eba4753bad97663ce.r2.dev/${key}`;

  return {
    ok: true,
    key,
    public_url,
    content_type: detectedType,
    size: data.byteLength
  };
}

async function waitForInstagramContainer(
  containerId: string,
  token: string,
  maxAttempts = 30,
  intervalMs = 2000
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const status = await fetch(
      `https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${containerId}?fields=status_code,status`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    const data: any = await status.json();

    if (!status.ok) {
      throw new Error(
        "Container status check failed: " + JSON.stringify(data)
      );
    }

    const statusCode = data?.status_code || data?.status;

    if (statusCode === "FINISHED") {
      return data;
    }

    if (statusCode === "ERROR" || statusCode === "EXPIRED") {
      throw new Error(
        "Container not publishable: " + JSON.stringify(data)
      );
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw new Error("Timed out waiting for Instagram media container.");
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "FLOPPY Story Control",
    version: "1.2.0"
  });

  const importToolConfig = {
    description:
      "Download an image from a public HTTPS URL, store it in FLOPPY media storage, and return a public URL for Instagram Story publishing.",
    inputSchema: {
      image_url: z
        .string()
        .url()
        .describe("Public HTTPS URL of the image")
    }
  };

  const importToolHandler = async ({ image_url }: { image_url: string }) => {
    try {
      const result = await importStoryMedia(image_url, env);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: String(error)
            })
          }
        ],
        isError: true
      };
    }
  };

  server.registerTool(
    "import_story_media",
    importToolConfig,
    importToolHandler
  );

  // Keep the previous tool name so existing ChatGPT/MCP clients do not break.
  server.registerTool(
    "upload_story_media",
    {
      ...importToolConfig,
      description:
        "Compatibility alias for import_story_media. Download an image from a public HTTPS URL and store it for Instagram Story publishing."
    },
    importToolHandler
  );

  server.registerTool(
    "publish_instagram_story",
    {
      description:
        "Publish a previously uploaded FLOPPY image to the INDXXR Instagram Story.",
      inputSchema: {
        image_url: z
          .string()
          .url()
          .describe(
            "Public HTTPS URL of the image that Meta can download."
          )
      }
    },
    async ({ image_url }) => {
      try {
        if (!image_url.startsWith("https://")) {
          throw new Error("Story image must use HTTPS.");
        }

        if (!env.INSTAGRAM_PUBLISH_TOKEN) {
          throw new Error("INSTAGRAM_PUBLISH_TOKEN is not configured.");
        }

        const form = new FormData();
        form.set("media_type", "STORIES");
        form.set("image_url", image_url);

        const create = await fetch(
          `https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${INSTAGRAM_ID}/media`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.INSTAGRAM_PUBLISH_TOKEN}`
            },
            body: form
          }
        );

        const created: any = await create.json();

        if (!create.ok || !created?.id) {
          throw new Error(
            "Container creation failed: " + JSON.stringify(created)
          );
        }

        const containerId = created.id;

        await waitForInstagramContainer(
          containerId,
          env.INSTAGRAM_PUBLISH_TOKEN
        );

        const publishForm = new FormData();
        publishForm.set("creation_id", containerId);

        const publish = await fetch(
          `https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${INSTAGRAM_ID}/media_publish`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.INSTAGRAM_PUBLISH_TOKEN}`
            },
            body: publishForm
          }
        );

        const published: any = await publish.json();

        if (!publish.ok || !published?.id) {
          throw new Error(
            "Story publishing failed: " + JSON.stringify(published)
          );
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                instagram: "indxxr",
                media_id: published.id,
                container_id: containerId
              })
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: String(error)
              })
            }
          ],
          isError: true
        };
      }
    }
  );

  return server;
}

export default {
  fetch(request, env, ctx) {
    return createMcpHandler(() =>
      createServer(env as Env)
    )(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
