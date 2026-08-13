import { app } from "./app";
import { env } from "./config/env";
import { startOutboxWorker } from "./jobs/outboxWorker";

app.listen(env.port, () => {
  console.log(`Server listening on port ${env.port}`);
  startOutboxWorker();
});
