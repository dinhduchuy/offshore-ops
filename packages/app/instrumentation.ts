/** Start the ops workflow runner when the server boots (also recovers interrupted tasks). */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getOps } = await import("./lib/ops");
    getOps();
  }
}
