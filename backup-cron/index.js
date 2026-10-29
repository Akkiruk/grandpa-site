import { runAutoBackup } from "../_worker.js";

// Cloudflare Pages can't run scheduled jobs, so the nightly backup is its own
// tiny Worker sharing the editor's KV namespace. See wrangler.toml here.
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runAutoBackup(env, new Date(event.scheduledTime)).then(
        result => console.log("nightly backup:", JSON.stringify(result)),
        error => console.error("nightly backup failed:", error.message, error.stack)
      )
    );
  },
};
