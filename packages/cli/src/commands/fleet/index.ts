import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { MainHostSetInputSchema, type MainHostState } from "@getpaseo/protocol/fleet/main-host";
import {
  withOutput,
  type CommandOptions,
  type OutputSchema,
  type SingleResult,
} from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";

const schema: OutputSchema<MainHostState> = {
  idField: () => "main-host",
  columns: [],
  renderHuman: (result) => {
    if (result.type !== "single") return "";
    const { choice, held } = result.data;
    if (!choice) return "No main host yet.";
    return [
      `Main host: ${choice.mainHost ?? "Unset"} (generation ${choice.generation})`,
      `Set by ${choice.setBy.clientType} session ${choice.setBy.clientId} on ${choice.setBy.serverId} at ${choice.setAt}`,
      held
        ? "Held on this daemon. Tim can Deliver or Undo this exact change in the app."
        : "Delivered.",
    ].join("\n");
  },
};

export function createFleetCommand(): Command {
  const fleet = new Command("fleet").description("Read and choose the general Main host");
  const main = fleet.command("main");
  addJsonAndDaemonHostOptions(main.command("get")).action(
    withOutput(
      async (options: CommandOptions, _command: Command): Promise<SingleResult<MainHostState>> => {
        const client = await connectToDaemon({ target: options.daemonTarget });
        try {
          return { type: "single", data: (await client.getMainHost()).state, schema };
        } finally {
          await client.close();
        }
      },
    ),
  );
  addJsonAndDaemonHostOptions(
    main
      .command("set")
      .requiredOption("--main-host <server-id>", "Existing saved host identity")
      .requiredOption("--expected-generation <generation>", "Observed generation; 0 means unset")
      .option("--request-id <id>", "Reuse the same ID when retrying an uncertain result"),
  ).action(
    withOutput(
      async (options: CommandOptions, _command: Command): Promise<SingleResult<MainHostState>> => {
        const input = MainHostSetInputSchema.parse({
          mainHost: options.mainHost,
          expectedGeneration: Number(options.expectedGeneration),
          requestId: options.requestId ?? randomUUID(),
        });
        const client = await connectToDaemon({ target: options.daemonTarget });
        try {
          const payload = await client.setMainHost(input);
          return { type: "single", data: payload.state, schema };
        } finally {
          await client.close();
        }
      },
    ),
  );
  return fleet;
}
