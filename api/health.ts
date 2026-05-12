// Vercel function — GET /health.
// Unauthenticated liveness probe for external monitors. All real logic
// lives in lib/handlers/health.ts.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleHealth } from "../lib/handlers/health";

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  const result = handleHealth();
  res.status(result.status).json(result.body);
}
