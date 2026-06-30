import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { AuthManager } from "./auth.js";
import {
  listFolder,
  searchFiles,
  readFile,
  getFileInfo,
  listRecent,
  getSharingInfo,
} from "./drive.js";

const PORT = Number(process.env.PORT ?? 3000);
const DRIVE_ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID || undefined;

const auth = new AuthManager();

function buildServer(sessionId: string): McpServer {
  const server = new McpServer({ name: "mcp-drive-pgmais", version: "2.0.0" });

  // ── 1. Autenticação ───────────────────────────────────────────────────────
  server.registerTool(
    "drive_get_auth_url",
    {
      title: "Gerar link de autorização do Google Drive",
      description:
        "Retorna uma URL para o usuário fazer login e autorizar acesso de leitura ao Google Drive. Use sempre que uma tool do Drive falhar por falta de autenticação.",
      inputSchema: {},
    },
    async () => {
      const url = auth.createAuthUrl(sessionId);
      return {
        content: [
          { type: "text", text: `Abra este link para autorizar o acesso ao Google Drive:\n${url}` },
        ],
      };
    }
  );

  // ── 2. Busca de arquivos ──────────────────────────────────────────────────
  server.registerTool(
    "drive_search_files",
    {
      title: "Buscar arquivos no Google Drive",
      description:
        "Busca arquivos pelo nome dentro da pasta raiz configurada (setor comercial). Suporta busca recursiva em subpastas e filtros por tipo MIME, data de modificação e proprietário.",
      inputSchema: {
        query: z.string().describe("Termo de busca contido no nome do arquivo"),
        pageSize: z.number().int().min(1).max(100).default(20),
        pageToken: z.string().optional().describe("Token de paginação da resposta anterior"),
        recursive: z
          .boolean()
          .default(false)
          .describe("Se true, busca recursivamente em todas as subpastas"),
        mimeType: z
          .string()
          .optional()
          .describe(
            "Filtrar por tipo MIME (ex: 'application/pdf', 'application/vnd.google-apps.document')"
          ),
        modifiedAfter: z
          .string()
          .optional()
          .describe(
            "Filtrar arquivos modificados após esta data (ISO 8601, ex: '2024-01-01T00:00:00Z')"
          ),
        owner: z.string().optional().describe("Filtrar por e-mail do proprietário do arquivo"),
        includeSharedDrives: z
          .boolean()
          .default(false)
          .describe("Se true, inclui resultados de Drives Compartilhados"),
      },
    },
    async ({ query, pageSize, pageToken, recursive, mimeType, modifiedAfter, owner, includeSharedDrives }) => {
      const client = await auth.getClientForSession(sessionId);
      const result = await searchFiles(client, {
        query,
        rootFolderId: DRIVE_ROOT_FOLDER_ID,
        pageSize,
        pageToken,
        recursive,
        mimeType,
        modifiedAfter,
        owner,
        includeSharedDrives,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  // ── 3. Listar pasta ───────────────────────────────────────────────────────
  server.registerTool(
    "drive_list_folder",
    {
      title: "Listar arquivos de uma pasta do Google Drive",
      description: "Lista os arquivos diretamente dentro de uma pasta do Drive pelo seu ID.",
      inputSchema: {
        folderId: z.string().describe("ID da pasta do Google Drive"),
        pageSize: z.number().int().min(1).max(100).default(50),
        pageToken: z.string().optional(),
        includeSharedDrives: z
          .boolean()
          .default(false)
          .describe("Se true, inclui arquivos de Drives Compartilhados"),
      },
    },
    async ({ folderId, pageSize, pageToken, includeSharedDrives }) => {
      const client = await auth.getClientForSession(sessionId);
      const result = await listFolder(client, folderId, pageSize, pageToken, includeSharedDrives);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  // ── 4. Ler arquivo ────────────────────────────────────────────────────────
  server.registerTool(
    "drive_read_file",
    {
      title: "Ler conteúdo de um arquivo do Google Drive",
      description:
        "Lê o conteúdo textual de um arquivo do Drive. Suporta Google Docs, Sheets, Slides, PDFs e arquivos de texto puro. Para arquivos grandes, use 'offset' com o valor de 'nextOffset' da resposta anterior para ler em partes.",
      inputSchema: {
        fileId: z.string().describe("ID do arquivo do Google Drive"),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe(
            "Posição inicial em caracteres. Use nextOffset da resposta anterior para continuar."
          ),
        chunkSize: z
          .number()
          .int()
          .min(1000)
          .max(100000)
          .default(50000)
          .describe("Máximo de caracteres a retornar por chamada"),
      },
    },
    async ({ fileId, offset, chunkSize }) => {
      const client = await auth.getClientForSession(sessionId);
      const result = await readFile(client, fileId, offset, chunkSize);
      const pagesNote = result.pages !== undefined ? ` (${result.pages} páginas)` : "";
      const footer = result.truncated
        ? `\n\n[Leitura parcial${pagesNote}: chars ${result.offset}–${result.offset + result.content.length} de ${result.totalLength}. Chame novamente com offset=${result.nextOffset} para continuar.]`
        : pagesNote
        ? `\n\n[PDF lido integralmente${pagesNote} — ${result.totalLength} caracteres]`
        : "";
      return {
        content: [{ type: "text", text: result.content + footer }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  // ── 5. Informações do arquivo ─────────────────────────────────────────────
  server.registerTool(
    "drive_get_file_info",
    {
      title: "Obter metadados detalhados de um arquivo do Drive",
      description:
        "Retorna informações completas sobre um arquivo: caminho completo (breadcrumb), proprietário, último editor, tamanho, tipo, link e status de compartilhamento.",
      inputSchema: {
        fileId: z.string().describe("ID do arquivo do Google Drive"),
      },
    },
    async ({ fileId }) => {
      const client = await auth.getClientForSession(sessionId);
      const result = await getFileInfo(client, fileId);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  // ── 6. Arquivos recentes ──────────────────────────────────────────────────
  server.registerTool(
    "drive_list_recent",
    {
      title: "Listar arquivos modificados recentemente",
      description:
        "Retorna os arquivos mais recentemente modificados nos últimos N dias, ordenados do mais novo para o mais antigo.",
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .default(7)
          .describe("Janela de tempo em dias (padrão: 7)"),
        pageSize: z.number().int().min(1).max(100).default(20),
        pageToken: z.string().optional(),
        restrictToRoot: z
          .boolean()
          .default(true)
          .describe(
            "Se true (padrão), restringe à pasta raiz configurada. Se false, busca em todo o Drive."
          ),
      },
    },
    async ({ days, pageSize, pageToken, restrictToRoot }) => {
      const client = await auth.getClientForSession(sessionId);
      const rootId = restrictToRoot ? DRIVE_ROOT_FOLDER_ID : undefined;
      const result = await listRecent(client, days, pageSize, pageToken, rootId);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  // ── 7. Informações de compartilhamento ────────────────────────────────────
  server.registerTool(
    "drive_get_sharing_info",
    {
      title: "Verificar permissões de um arquivo do Drive",
      description:
        "Retorna a lista completa de quem tem acesso ao arquivo e com qual nível (viewer, commenter, editor), incluindo usuários individuais, grupos e domínios.",
      inputSchema: {
        fileId: z.string().describe("ID do arquivo do Google Drive"),
      },
    },
    async ({ fileId }) => {
      const client = await auth.getClientForSession(sessionId);
      const result = await getSharingInfo(client, fileId);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// MCP endpoint — stateless: cada request ganha um transport/server novo,
// mas o sessionId (via header) mantém os tokens OAuth estáveis entre chamadas.
app.post("/mcp", async (req, res) => {
  const sessionId = (req.header("mcp-session-id") ||
    req.body?.params?._meta?.sessionId ||
    randomUUID()) as string;
  try {
    const server = buildServer(sessionId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] erro ao processar requisição:", err);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  }
});

app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  if (!code || !state) {
    res.status(400).send("Faltam parâmetros 'code' ou 'state'.");
    return;
  }
  try {
    const sessionId = await auth.handleCallback(code, state);
    res.send(
      `Autorização concluída para a sessão ${sessionId}. Pode voltar para o cliente MCP e tentar a tool de Drive novamente.`
    );
  } catch (err) {
    console.error("[oauth] erro no callback:", err);
    res.status(400).send(`Falha na autorização: ${(err as Error).message}`);
  }
});

app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`MCP Drive server rodando em http://localhost:${PORT}/mcp`);
});
