import { Auth, calendar_v3, google } from "googleapis";
type OAuth2Client = Auth.OAuth2Client;
const client = (auth: OAuth2Client) => google.calendar({ version: "v3", auth });

export interface CalendarEvent { id: string; summary: string; description?: string; location?: string; start: string; end: string; allDay: boolean; attendees?: string[]; htmlLink?: string; }

function toEvent(e: calendar_v3.Schema$Event): CalendarEvent {
  return { id: e.id ?? "", summary: e.summary ?? "(sem título)", description: e.description ?? undefined, location: e.location ?? undefined, start: e.start?.dateTime ?? e.start?.date ?? "", end: e.end?.dateTime ?? e.end?.date ?? "", allDay: Boolean(e.start?.date && !e.start?.dateTime), attendees: e.attendees?.map(a => a.email ?? "").filter(Boolean) ?? undefined, htmlLink: e.htmlLink ?? undefined };
}

export async function listEvents(auth: OAuth2Client, timeMin: string, timeMax: string, maxResults = 20, calendarId = "primary"): Promise<{ events: CalendarEvent[] }> {
  const res = await client(auth).events.list({ calendarId, timeMin, timeMax, maxResults, singleEvents: true, orderBy: "startTime" });
  return { events: (res.data.items ?? []).map(toEvent) };
}

export async function createEvent(auth: OAuth2Client, summary: string, start: string, end: string, opts?: { description?: string; location?: string; attendees?: string[]; calendarId?: string }): Promise<CalendarEvent> {
  const { description, location, attendees, calendarId = "primary" } = opts ?? {};
  const res = await client(auth).events.insert({ calendarId, sendUpdates: attendees?.length ? "all" : "none", requestBody: { summary, description, location, start: { dateTime: start, timeZone: "America/Sao_Paulo" }, end: { dateTime: end, timeZone: "America/Sao_Paulo" }, attendees: attendees?.map(email => ({ email })) } });
  return toEvent(res.data);
}
