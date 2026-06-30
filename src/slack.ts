export async function sendSlackMessage(token: string, channel: string, text: string, username = "MCP Assistant"): Promise<{ ok: boolean; ts: string; channel: string }> {
  const res = await fetch("https://slack.com/api/chat.postMessage", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ channel, text, username }) });
  const data = await res.json() as { ok: boolean; ts?: string; channel?: string; error?: string };
  if (!data.ok) throw new Error(`Slack API: ${data.error}`);
  return { ok: true, ts: data.ts ?? "", channel: data.channel ?? channel };
}
