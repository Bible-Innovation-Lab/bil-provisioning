// Vercel function — POST /provision.
// Thin glue layer: builds production deps from env, calls handleProvision,
// writes the response. All real logic lives in lib/handlers/provision.ts.

import { kv } from "@vercel/kv";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadServiceConfig } from "../lib/env.js";
import { handleProvision } from "../lib/handlers/provision.js";
import { createVercelClient } from "../lib/vercel-client.js";

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

  const result = await handleProvision(
    {
      authorization: req.headers.authorization ?? null,
      body: req.body,
    },
    {
      kv,
      vercel,
      // Debug flag: when set, the rollback skips deleteProject so failed
      // deployment build logs stay inspectable. Must be manually unset
      // when debugging is done — orphan projects accumulate otherwise.
      debugKeepFailed: process.env.PROVISION_DEBUG_KEEP_FAILED === "1",
      config: {
        org: config.org,
        adminTeamSlug: config.adminTeamSlug,
        subdomainRoot: config.subdomainRoot,
        posthogKey: config.posthogKey,
        posthogHost: config.posthogHost,
        youversionApiKey: config.youversionApiKey,
      },
    }
  );

  res.status(result.status).json(result.body);
}
