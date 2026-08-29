export default {
  async scheduled(event, env, ctx) {
    const owner = "Ahmed-Basalib10";
    const repo = "myproject";
    const workflowFile = "update-prices.yml";
    const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GITHUB_PAT}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "price-cron-trigger-worker",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main" }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`GitHub dispatch failed: ${response.status} ${body}`);
      throw new Error(`Dispatch failed: ${response.status}`);
    }
    console.log(`Dispatched update-prices workflow successfully at ${new Date().toISOString()}`);
  },

  // Lets me trigger it manually via browser/curl to test without waiting for
  // the schedule — gated by a secret token so the public Worker URL alone
  // isn't enough to trigger it (API quota abuse / unnecessary rebuilds).
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const providedToken = url.searchParams.get("token");

    if (!providedToken || providedToken !== env.MANUAL_TRIGGER_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    await this.scheduled(null, env, ctx);
    return new Response("Triggered update-prices workflow manually.");
  },
};
