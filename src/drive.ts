import { extractText, getDocumentProxy } from "unpdf";
import { Auth, drive_v3, google } from "googleapis";

type OAuth2Client = Auth.OAuth2Client;

const EXPORTABLE_MIME_MAP: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

const TEXTUAL_MIME_PREFIXES = ["text/", "application/json"];
const PDF_MIME = "application/pdf";
const DEFAULT_CHUNK = 50_000;

const FILE_FIELDS =
  "id, name, mimeType, modifiedTime, size, parents, webViewLink, shared";

function driveClient(auth: OAuth2Client): drive_v3.Drive {
  return google.drive({ version: "v3", auth });
}

export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  parents?: string[];
  webViewLink?: string;
}

function toSummary(file: drive_v3.Schema$File): DriveFileSummary {
  return {
    id: file.id ?? "",
    name: file.name ?? "",
    mimeType: file.mimeType ?? "",
    modifiedTime: file.modifiedTime ?? undefined,
    size: file.size ?? undefined,
    parents: file.parents ?? undefined,
    webViewLink: file.webViewLink ?? undefined,
  };
}

// ─── searchFiles ────────────────────────────────────────────────────────────

export interface SearchOptions {
  query: string;
  rootFolderId?: string;
  pageSize: number;
  pageToken?: string;
  recursive?: boolean;
  mimeType?: string;
  modifiedAfter?: string;
  owner?: string;
  includeSharedDrives?: boolean;
}

export async function searchFiles(
  auth: OAuth2Client,
  opts: SearchOptions
): Promise<{ files: DriveFileSummary[]; nextPageToken?: string }> {
  const drive = driveClient(auth);
  const { query, rootFolderId, pageSize, pageToken, recursive, mimeType, modifiedAfter, owner, includeSharedDrives } = opts;

  const clauses: string[] = [
    `name contains '${query.replace(/'/g, "\\'")}'`,
    "trashed = false",
  ];

  if (rootFolderId) {
    const relation = recursive ? "ancestors" : "parents";
    clauses.push(`'${rootFolderId}' in ${relation}`);
  }
  if (mimeType) clauses.push(`mimeType = '${mimeType}'`);
  if (modifiedAfter) clauses.push(`modifiedTime > '${modifiedAfter}'`);
  if (owner) clauses.push(`'${owner}' in owners`);

  const res = await drive.files.list({
    q: clauses.join(" and "),
    fields: `nextPageToken, files(${FILE_FIELDS})`,
    pageSize,
    pageToken,
    corpora: includeSharedDrives ? "allDrives" : "user",
    includeItemsFromAllDrives: includeSharedDrives ?? false,
    supportsAllDrives: includeSharedDrives ?? false,
  });

  return {
    files: (res.data.files ?? []).map(toSummary),
    nextPageToken: res.data.nextPageToken ?? undefined,
  };
}

// ─── listFolder ─────────────────────────────────────────────────────────────

export async function listFolder(
  auth: OAuth2Client,
  folderId: string,
  pageSize: number,
  pageToken?: string,
  includeSharedDrives?: boolean
): Promise<{ files: DriveFileSummary[]; nextPageToken?: string }> {
  const drive = driveClient(auth);
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: `nextPageToken, files(${FILE_FIELDS})`,
    pageSize,
    pageToken,
    orderBy: "name",
    corpora: includeSharedDrives ? "allDrives" : "user",
    includeItemsFromAllDrives: includeSharedDrives ?? false,
    supportsAllDrives: includeSharedDrives ?? false,
  });
  return {
    files: (res.data.files ?? []).map(toSummary),
    nextPageToken: res.data.nextPageToken ?? undefined,
  };
}

// ─── listRecent ─────────────────────────────────────────────────────────────

export async function listRecent(
  auth: OAuth2Client,
  days: number,
  pageSize: number,
  pageToken?: string,
  rootFolderId?: string
): Promise<{ files: DriveFileSummary[]; nextPageToken?: string }> {
  const drive = driveClient(auth);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const clauses = [`modifiedTime > '${since}'`, "trashed = false"];
  if (rootFolderId) clauses.push(`'${rootFolderId}' in ancestors`);

  const res = await drive.files.list({
    q: clauses.join(" and "),
    fields: `nextPageToken, files(${FILE_FIELDS})`,
    pageSize,
    pageToken,
    orderBy: "modifiedTime desc",
    corpora: "user",
  });

  return {
    files: (res.data.files ?? []).map(toSummary),
    nextPageToken: res.data.nextPageToken ?? undefined,
  };
}

// ─── getFileInfo ─────────────────────────────────────────────────────────────

export interface FileInfo extends DriveFileSummary {
  path: string[];
  shared?: boolean;
  description?: string;
  starred?: boolean;
  version?: string;
  ownerNames?: string[];
  lastModifyingUser?: string;
}

async function buildBreadcrumb(drive: drive_v3.Drive, parents: string[]): Promise<string[]> {
  const path: string[] = [];
  let current = parents;
  for (let i = 0; i < 10 && current.length > 0; i++) {
    try {
      const res = await drive.files.get({
        fileId: current[0],
        fields: "id, name, parents",
        supportsAllDrives: true,
      });
      path.unshift(res.data.name ?? current[0]);
      current = res.data.parents ?? [];
    } catch {
      break;
    }
  }
  return path;
}

export async function getFileInfo(auth: OAuth2Client, fileId: string): Promise<FileInfo> {
  const drive = driveClient(auth);
  const res = await drive.files.get({
    fileId,
    fields:
      "id, name, mimeType, modifiedTime, size, parents, webViewLink, description, starred, version, owners, lastModifyingUser, shared",
    supportsAllDrives: true,
  });

  const f = res.data;
  const path = f.parents ? await buildBreadcrumb(drive, f.parents) : [];

  return {
    id: f.id ?? "",
    name: f.name ?? "",
    mimeType: f.mimeType ?? "",
    modifiedTime: f.modifiedTime ?? undefined,
    size: f.size ?? undefined,
    parents: f.parents ?? undefined,
    webViewLink: f.webViewLink ?? undefined,
    shared: f.shared ?? false,
    path,
    description: f.description ?? undefined,
    starred: f.starred ?? undefined,
    version: f.version ?? undefined,
    ownerNames: f.owners?.map((o) => o.displayName ?? o.emailAddress ?? "") ?? undefined,
    lastModifyingUser:
      f.lastModifyingUser?.displayName ?? f.lastModifyingUser?.emailAddress ?? undefined,
  };
}

// ─── getSharingInfo ──────────────────────────────────────────────────────────

export interface SharingInfo {
  id: string;
  name: string;
  shared: boolean;
  permissions: Array<{
    id: string;
    type: string;
    role: string;
    email?: string;
    displayName?: string;
    domain?: string;
  }>;
}

export async function getSharingInfo(auth: OAuth2Client, fileId: string): Promise<SharingInfo> {
  const drive = driveClient(auth);
  const [fileMeta, permsRes] = await Promise.all([
    drive.files.get({ fileId, fields: "id, name, shared", supportsAllDrives: true }),
    drive.permissions.list({
      fileId,
      fields: "permissions(id, type, role, emailAddress, displayName, domain)",
      supportsAllDrives: true,
    }),
  ]);

  return {
    id: fileMeta.data.id ?? "",
    name: fileMeta.data.name ?? "",
    shared: fileMeta.data.shared ?? false,
    permissions: (permsRes.data.permissions ?? []).map((p) => ({
      id: p.id ?? "",
      type: p.type ?? "",
      role: p.role ?? "",
      email: p.emailAddress ?? undefined,
      displayName: p.displayName ?? undefined,
      domain: p.domain ?? undefined,
    })),
  };
}

// ─── readFile ────────────────────────────────────────────────────────────────

export interface ReadFileResult {
  name: string;
  mimeType: string;
  content: string;
  offset: number;
  nextOffset?: number;
  totalLength: number;
  truncated: boolean;
  pages?: number;
}

export async function readFile(
  auth: OAuth2Client,
  fileId: string,
  offset = 0,
  chunkSize = DEFAULT_CHUNK
): Promise<ReadFileResult> {
  const drive = driveClient(auth);
  const meta = await drive.files.get({
    fileId,
    fields: "id, name, mimeType",
    supportsAllDrives: true,
  });
  const mimeType = meta.data.mimeType ?? "";
  const name = meta.data.name ?? fileId;

  // PDF
  if (mimeType === PDF_MIME) {
    const res = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" }
    );
    const uint8 = new Uint8Array(res.data as ArrayBuffer);
    const pdf = await getDocumentProxy(uint8);
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    return chunk(name, mimeType, text, offset, chunkSize, totalPages);
  }

  // Google Workspace exportável
  const exportMime = EXPORTABLE_MIME_MAP[mimeType];
  if (exportMime) {
    const res = await drive.files.export({ fileId, mimeType: exportMime }, { responseType: "text" });
    return chunk(name, mimeType, res.data as unknown as string, offset, chunkSize);
  }

  // Texto puro
  if (TEXTUAL_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) {
    const res = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "text" }
    );
    return chunk(name, mimeType, res.data as unknown as string, offset, chunkSize);
  }

  throw new Error(
    `Tipo '${mimeType}' não suportado para leitura de texto. Use webViewLink para abrir manualmente.`
  );
}

function chunk(
  name: string,
  mimeType: string,
  raw: string,
  offset: number,
  chunkSize: number,
  pages?: number
): ReadFileResult {
  const totalLength = raw.length;
  const slice = raw.slice(offset, offset + chunkSize);
  const end = offset + slice.length;
  const nextOffset = end < totalLength ? end : undefined;
  return { name, mimeType, content: slice, offset, nextOffset, totalLength, truncated: nextOffset !== undefined, pages };
}
