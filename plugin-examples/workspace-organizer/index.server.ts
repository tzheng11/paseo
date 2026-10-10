import type { PluginServerContext } from "@getpaseo/plugin/server";
import { organization } from "./shared/organization";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(organization);
  return () => {};
}
