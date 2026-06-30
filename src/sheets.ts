import { Auth, google } from "googleapis";
type OAuth2Client = Auth.OAuth2Client;
const client = (auth: OAuth2Client) => google.sheets({ version: "v4", auth });

export async function readSheet(auth: OAuth2Client, spreadsheetId: string, range: string): Promise<{ values: unknown[][]; range: string; rowCount: number }> {
  const res = await client(auth).spreadsheets.values.get({ spreadsheetId, range });
  const values = (res.data.values ?? []) as unknown[][];
  return { values, range: res.data.range ?? range, rowCount: values.length };
}

export async function writeSheet(auth: OAuth2Client, spreadsheetId: string, range: string, values: unknown[][]): Promise<{ updatedRange: string; updatedRows: number; updatedCells: number }> {
  const res = await client(auth).spreadsheets.values.update({ spreadsheetId, range, valueInputOption: "USER_ENTERED", requestBody: { values } });
  return { updatedRange: res.data.updatedRange ?? range, updatedRows: res.data.updatedRows ?? 0, updatedCells: res.data.updatedCells ?? 0 };
}

export async function appendSheet(auth: OAuth2Client, spreadsheetId: string, range: string, values: unknown[][]): Promise<{ updatedRange: string; updatedRows: number }> {
  const res = await client(auth).spreadsheets.values.append({ spreadsheetId, range, valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS", requestBody: { values } });
  return { updatedRange: res.data.updates?.updatedRange ?? range, updatedRows: res.data.updates?.updatedRows ?? 0 };
}
