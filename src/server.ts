import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = {
  FLOPPY_MEDIA: R2Bucket;
  INSTAGRAM_PUBLISH_TOKEN: string;
};

const INSTAGRAM_ID = "17841402148601055";

function createServer(env: Env) {
  const server = new McpServer({
    name: "FLOPPY Story Control",
    version: "1.0.0"
  });

  // ============================================================
  // TOOL 1: UPLOAD STORY ARTWORK TO R2
  // ============================================================

  server.registerTool(
    "upload_story_media",
    {
      description:
        "Upload an image supplied as base64 to FLOPPY media storage so it can be used for an Instagram Story.",

      inputSchema: {
        image_base64: z
          .string()
          .describe("Base64 encoded image data"),

        content_type: z
          .enum(["image/jpeg", "image/png", "image/webp"])
          .default("image/jpeg")
      }
    },

    async ({ image_base64, content_type }) => {
      try {
        const cleanBase64 = image_base64.includes(",")
          ? image_base64.split(",").pop()!
          : image_base64;

        const binary = atob(cleanBase64);

        const bytes = new Uint8Array(binary.length);

        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }

        if (!bytes.byteLength) {
          throw new Error("Image is empty.");
        }

        const ext =
          content_type === "image/png"
            ? "png"
            : content_type === "image/webp"
            ? "webp"
            : "jpg";

        const key =
          "stories/" +
          Date.now() +
          "-" +
          crypto.randomUUID() +
          "." +
          ext;

        await env.FLOPPY_MEDIA.put(key, bytes, {
          httpMetadata: {
            contentType: content_type
          }
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                key,
                content_type
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

  // ============================================================
  // TOOL 2: PUBLISH STORED IMAGE TO INSTAGRAM STORY
  // ============================================================

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

        const form = new FormData();

        form.set("media_type", "STORIES");
        form.set("image_url", image_url);

        const create = await fetch(
          `https://graph.instagram.com/v26.0/${INSTAGRAM_ID}/media`,
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${env.INSTAGRAM_PUBLISH_TOKEN}`
            },
            body: form
          }
        );

        const created: any = await create.json();

        if (!create.ok || !created?.id) {
          throw new Error(
            "Container creation failed: " +
              JSON.stringify(created)
          );
        }

        const containerId = created.id;

        const publishForm = new FormData();

        publishForm.set("creation_id", containerId);

        const publish = await fetch(
          `https://graph.instagram.com/v26.0/${INSTAGRAM_ID}/media_publish`,
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${env.INSTAGRAM_PUBLISH_TOKEN}`
            },
            body: publishForm
          }
        );

        const published: any = await publish.json();

        if (!publish.ok || !published?.id) {
          throw new Error(
            "Story publishing failed: " +
              JSON.stringify(published)
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
