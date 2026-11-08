// The live Connection: Photon Spectrum Stable over gRPC (cloud iMessage lines found from the project's
// credentials). Kept apart from messenger.ts so tests never load the SDK.
import { Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import type { Connect, Connection, InboundMessage } from "./messenger.ts";
import { toInbound, type RawMessage, type RawSpace } from "./spectrum-map.ts";

export function spectrumConnect(credentials: { projectId: string; projectSecret: string }): Connect {
  return async ({ onHeartbeat, signal }) => {
    const app = await Spectrum({
      projectId: credentials.projectId,
      projectSecret: credentials.projectSecret,
      providers: [imessage.config({ onHeartbeat: () => onHeartbeat() })],
      // No OpenTelemetry export: message metadata stays between Photon and us.
      telemetry: false,
      options: { logLevel: "warn" },
      signal,
    });
    const im = imessage(app);

    async function* messages(): AsyncGenerator<InboundMessage> {
      for await (const [space, message] of app.messages) {
        if (message.platform !== "imessage") continue;
        const inbound = toInbound(space as unknown as RawSpace, message as unknown as RawMessage);
        if (inbound) yield inbound;
      }
    }

    const connection: Connection = {
      messages: messages(),
      async openDm(phone) {
        const user = await im.user(phone);
        const space = await im.space.create(user);
        return {
          send: async (text: string) => {
            const sent = await space.send(text);
            return sent?.id === undefined ? undefined : String(sent.id);
          },
        };
      },
      stop: () => app.stop(),
    };
    return connection;
  };
}
