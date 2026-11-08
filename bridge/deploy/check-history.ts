// Read-only check of the owner's iMessage conversation on the Photon line: lists the latest messages *we* sent
// (text, time, sent/delivered) and only counts and times of the owner's messages (their text is not printed).
// Sends nothing. Use it to confirm the bridge's test message went out without SSH access to the box.
//
//   bun --env-file=<file with SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, OWNER_PHONE> deploy/check-history.ts [hours=6]
import { createGrpcClient } from "@photon-ai/advanced-imessage/grpc";
import { cloud } from "@spectrum-ts/core";

const { SPECTRUM_PROJECT_ID: id, SPECTRUM_PROJECT_SECRET: secret, OWNER_PHONE: owner } = process.env;
if (!id || !secret || !owner) throw new Error("SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET and OWNER_PHONE are required");
const hours = Number(process.argv[2] ?? 6);

const tokens = await cloud.issueImessageTokens(id, secret);
if (tokens.type !== "shared") throw new Error("This check handles shared (Free/Pro) lines; dedicated lines need their own address");
const client = createGrpcClient({
  address: process.env.SPECTRUM_IMESSAGE_ADDRESS ?? "imessage.spectrum.photon.codes:443",
  tls: true,
  token: tokens.token,
});

const page = await client.messages.listInChat(`any;-;${owner}`, { after: new Date(Date.now() - hours * 3600_000), pageSize: 50 });
const rows = [...page.messages].sort((a, b) => a.dateCreated.getTime() - b.dateCreated.getTime());
let fromOwner = 0;
for (const m of rows) {
  const at = m.dateCreated.toISOString();
  if (m.isFromMe) {
    const text = String((m.content as { text?: unknown }).text ?? `<${m.itemType}>`).replace(/\s+/g, " ").slice(0, 80);
    console.log(`${at}  sent  ${m.isDelivered ? "delivered" : m.isSent ? "sent" : "not sent"}  ${JSON.stringify(text)}`);
  } else {
    fromOwner++;
    console.log(`${at}  owner ${m.reaction ? "tapback" : "message"} (content not shown)`);
  }
}
console.log(`${rows.length} messages in the last ${hours}h (${fromOwner} from the owner)`);
process.exit(0);
