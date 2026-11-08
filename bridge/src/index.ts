// Entry point: config -> iMessage connection (live Spectrum or mock) -> bridge (owner commands) + poller (notices)
// -> local health server. Every network call goes out from here; nothing listens on a public interface.
import { Bridge } from "./bridge.ts";
import { loadConfig } from "./config.ts";
import { describeError, log, setLogLevel } from "./log.ts";
import { MockMessenger, SupervisedMessenger, type Messenger } from "./messenger.ts";
import { Poller } from "./poller.ts";
import { buildServer } from "./server.ts";

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  let messenger: Messenger;
  let mock: MockMessenger | undefined;
  if (config.mode === "mock") {
    mock = new MockMessenger(config.ownerPhone);
    messenger = mock;
  } else {
    // Loaded lazily so mock runs and tests never touch the SDK or the network.
    const { spectrumConnect } = await import("./spectrum.ts");
    messenger = new SupervisedMessenger({
      connect: spectrumConnect({ projectId: config.projectId!, projectSecret: config.projectSecret! }),
      ownerPhone: config.ownerPhone,
    });
  }

  const bridge = new Bridge({ config, messenger });
  messenger.start((m) => bridge.handleInbound(m));
  const poller = new Poller({ config, messenger, version: config.version });
  poller.start();
  const health = () => {
    const h = bridge.health();
    return { status: h.status, body: { ...h.body, version: config.version, poll: poller.status() } };
  };
  const server = buildServer({ bridge, secret: config.bridgeSecret, mock, health });
  server.listen(config.port, config.healthHost, () =>
    log.info("bridge started", { health: `${config.healthHost}:${config.port}`, mode: config.mode, worker: config.workerUrl, version: config.version }),
  );

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info("shutting down", { signal });
    server.close();
    await poller.stop().catch(() => {});
    await messenger.stop().catch((err) => log.warn("messenger stop failed", { error: describeError(err) }));
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("bridge failed to start", { error: describeError(err) });
  process.exit(1);
});
