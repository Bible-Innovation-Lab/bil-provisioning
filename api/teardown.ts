// Vercel function — POST /teardown.
// Thin glue layer: builds production deps from env, calls handleTeardown,
// writes the response. All real logic lives in lib/handlers/teardown.ts.

import { kv } from "@vercel/kv";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadServiceConfig } from "../lib/env";
import { handleTeardown } from "../lib/handlers/teardown";
import { createVercelClient } from "../lib/vercel-client";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const config = loadServiceConfig();
  const vercel = createVercelClient({
    token: config.vercelApiToken,
    teamId: config.vercelTeamId,
  });

  const result = await handleTeardown(
    {
      authorization: req.headers.authorization ?? null,
      body: req.body,
    },
    {
      kv,
      vercel,
      config: {
        org: config.org,
        adminTeamSlug: config.adminTeamSlug,
        subdomainRoot: config.subdomainRoot,
      },
    }
  );

  res.status(result.status).json(result.body);
}
