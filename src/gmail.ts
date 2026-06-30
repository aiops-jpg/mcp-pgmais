import { Auth, gmail_v1, google } from "googleapis";
type OAuth2Client = Auth.OAuth2Client;
const client = (auth: OAuth2Client) => google.gmail({ version: "v1", auth });

export interface EmailSummary { id: string; threadId: string; subject: string; from: string; date: string; snippet: string; }
export interface EmailFull extends EmailSummary { to: string; cc?: string; body: string; }

export async function searchEmails(auth: OAuth2Client, query: string, maxResults = 10): Promise<{ emails: EmailSummary[]; nextPageToken?: string }> {
  const gmail = client(auth);
  const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults });
  const msgs = list.data.messages ?? [];
  const emails: EmailSummary[] = [];
  for (const msg of msgs) {
    if (!msg.id) continue;
    const d = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "metadata", metadataHeaders: ["Subject", "From", "Date"] });
    const h = d.data.payload?.headers ?? [];
    const g = (n: string) => h.find(x => x.name === n)?.value ?? "";
    emails.push({ id: msg.id, threadId: msg.threadId ?? "", subject: g("Subject"), from: g("From"), date: g("Date"), snippet: d.data.snippet ?? "" });
  }
  return { emails, nextPageToken: list.data.nextPageToken ?? undefined };
}

export async function readEmail(auth: OAuth2Client, messageId: string): Promise<EmailFull> {
  const gmail = client(auth);
  const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const h = res.data.payload?.headers ?? [];
  const g = (n: string) => h.find(x => x.name === n)?.value ?? "";
  function body(part: gmail_v1.Schema$MessagePart | undefined): string {
    if (!part) return "";
    if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64").toString("utf-8");
    for (const p of part.parts ?? []) { const t = body(p); if (t) return t; }
    return "";
  }
  return { id: messageId, threadId: res.data.threadId ?? "", subject: g("Subject"), from: g("From"), to: g("To"), cc: g("Cc") || undefined, date: g("Date"), snippet: res.data.snippet ?? "", body: body(res.data.payload) || res.data.snippet || "" };
}
