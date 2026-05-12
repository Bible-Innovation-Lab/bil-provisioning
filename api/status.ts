// Vercel function — GET /status?app_id=<id>.
// Thin glue layer: builds production deps from env, calls handleStatus,
// writes the response. All real logic lives in lib/handlers/status.ts.

import { kv } from "@vercel/kv";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadServiceConfig } from "../lib/env.js";
import { handleStatus } from "../lib/handlers/status.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const config = loadServiceConfig();

  const result = await handleStatus(
    {
      authorization: req.headers.authorization ?? null,
      query: req.query as { app_id?: string | string[] | undefined },
    },
    {
      kv,
      config: {
        org: config.org,
        adminTeamSlug: config.adminTeamSlug,
        subdomainRoot: config.subdomainRoot,
      },
    }
  );

  res.status(result.status).json(result.body);
}
