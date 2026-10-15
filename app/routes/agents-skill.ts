import skill from "../../plugins/aionly/skills/aionly/SKILL.md?raw";

import { zipFiles } from "~/lib/agents/zip";

/**
 * The aion.ly skill as a zip, for apps that take skills as an upload, such
 * as Claude on the web and desktop. Made from the plugin's own copy.
 */
export function loader() {
  return new Response(zipFiles([{ path: "aionly/SKILL.md", text: skill }]), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="aionly-skill.zip"',
      "Cache-Control": "public, max-age=3600",
    },
  });
}
