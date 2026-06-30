export interface NotionResult { id: string; title: string; type: "page" | "database"; url: string; lastEdited: string; emoji?: string; }

type NItem = { id: string; object: "page" | "database"; url: string; last_edited_time: string; icon?: { type: string; emoji?: string }; properties?: Record<string, { type: string; title?: Array<{ plain_text: string }> }>; title?: Array<{ plain_text: string }>; };

function extractTitle(item: NItem): string {
  if (item.properties) { for (const p of Object.values(item.properties)) { if (p.type === "title" && p.title?.[0]) return p.title[0].plain_text; } }
  if (item.title?.[0]) return item.title[0].plain_text;
  return "(sem título)";
}

export async function searchNotion(token: string, query: string, pageSize = 10): Promise<{ results: NotionResult[] }> {
  const res = await fetch("https://api.notion.com/v1/search", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" }, body: JSON.stringify({ query, page_size: pageSize }) });
  if (!res.ok) { const e = await res.json() as { message?: string }; throw new Error(`Notion API: ${e.message ?? res.statusText}`); }
  const data = await res.json() as { results: NItem[] };
  return { results: data.results.map(item => ({ id: item.id, title: extractTitle(item), type: item.object, url: item.url, lastEdited: item.last_edited_time, emoji: item.icon?.type === "emoji" ? item.icon.emoji : undefined })) };
}
