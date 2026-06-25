import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();

buildServer(config)
  .then((app) =>
    app.listen({ port: config.port, host: config.host }).then((address) => {
      app.log.info(`LIEN /api listening on ${address} (cluster=${config.cluster})`);
    }),
  )
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
