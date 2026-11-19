// The sealed package must explicitly opt into upstream replacements.
// Missing metadata stays on managed updates; this is not a host setting.
const metadata = require("../../package.json") as {
  paseoDistribution?: { name?: string; updates?: "manual" | "upstream" };
};

export const desktopUpdatesEnabled = metadata.paseoDistribution?.updates === "upstream";
