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
import { lookupCep, lookupCnpj, convertCurrency, webSearch } from "./external.js";
import { formatDocument } from "./utils.js";
import { searchEmails, readEmail } from "./gmail.js";
import { listEvents, createEvent } from "./calendar.js";
import { readSheet, writeSheet, appendSheet } from "./sheets.js";
import { searchNotion } from "./notion.js";
import { sendSlackMessage } from "./slack.js";

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

  // ── 8. CEP ───────────────────────────────────────────────────────────────
  server.registerTool("cep_lookup", {
    title: "Buscar endereço por CEP",
    description: "Retorna endereço completo (logradouro, bairro, cidade, UF) a partir de um CEP brasileiro.",
    inputSchema: { cep: z.string().describe("CEP com ou sem formatação (ex: 01310-100 ou 01310100)") },
  }, async ({ cep }) => {
    const result = await lookupCep(cep);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  });

  // ── 9. CNPJ ──────────────────────────────────────────────────────────────
  server.registerTool("cnpj_lookup", {
    title: "Consultar dados de empresa por CNPJ",
    description: "Retorna dados completos da empresa na Receita Federal: razão social, situação cadastral, endereço, sócios, atividade e mais.",
    inputSchema: { cnpj: z.string().describe("CNPJ com ou sem formatação (ex: 11.222.333/0001-81 ou 11222333000181)") },
  }, async ({ cnpj }) => {
    const result = await lookupCnpj(cnpj);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as Record<string, unknown> };
  });

  // ── 10. Conversão de moedas ───────────────────────────────────────────────
  server.registerTool("currency_convert", {
    title: "Converter moedas",
    description: "Converte um valor entre duas moedas usando cotação em tempo real. Suporta BRL, USD, EUR, GBP, ARS, etc.",
    inputSchema: {
      from: z.string().describe("Código da moeda de origem (ex: USD, EUR, BRL)"),
      to: z.string().describe("Código da moeda de destino (ex: BRL, USD)"),
      amount: z.number().positive().describe("Valor a converter"),
    },
  }, async ({ from, to, amount }) => {
    const result = await convertCurrency(from, to, amount);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  });

  // ── 11. Busca na web ──────────────────────────────────────────────────────
  server.registerTool("web_search", {
    title: "Buscar na web",
    description: "Realiza uma busca na web e retorna os resultados mais relevantes. Usa Brave Search (se BRAVE_SEARCH_API_KEY configurado) ou DuckDuckGo (grátis, sem configuração).",
    inputSchema: {
      query: z.string().describe("Termos de busca"),
      count: z.number().int().min(1).max(10).default(5).describe("Número máximo de resultados"),
    },
  }, async ({ query, count }) => {
    const result = await webSearch(query, count);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  });

  // ── 12. Formatar documento ────────────────────────────────────────────────
  server.registerTool("format_document", {
    title: "Formatar e validar CNPJ ou CPF",
    description: "Detecta automaticamente se é CNPJ (14 dígitos) ou CPF (11 dígitos), formata com máscara e valida os dígitos verificadores.",
    inputSchema: { value: z.string().describe("Número do documento com ou sem formatação") },
  }, async ({ value }) => {
    const result = formatDocument(value);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  });

  // ── 13. Gmail — busca ─────────────────────────────────────────────────────
  server.registerTool("gmail_search", {
    title: "Buscar e-mails no Gmail",
    description: "Busca e-mails usando a sintaxe do Gmail (from:, to:, subject:, after:, before:, has:attachment, etc.). Retorna assunto, remetente, data e prévia.",
    inputSchema: {
      query: z.string().describe("Filtro de busca no formato Gmail (ex: 'from:cliente@empresa.com subject:proposta after:2024/01/01')"),
      maxResults: z.number().int().min(1).max(50).default(10),
    },
  }, async ({ query, maxResults }) => {
    const client = await auth.getClientForSession(sessionId);
    const result = await searchEmails(client, query, maxResults);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  });

  // ── 14. Gmail — leitura ───────────────────────────────────────────────────
  server.registerTool("gmail_read", {
    title: "Ler conteúdo de um e-mail",
    description: "Lê o conteúdo completo de um e-mail pelo seu ID (obtido via gmail_search).",
    inputSchema: { messageId: z.string().describe("ID do e-mail (obtido via gmail_search)") },
  }, async ({ messageId }) => {
    const client = await auth.getClientForSession(sessionId);
    const result = await readEmail(client, messageId);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  });

  // ── 15. Calendar — listar ─────────────────────────────────────────────────
  server.registerTool("calendar_list_events", {
    title: "Listar eventos do Google Calendar",
    description: "Lista eventos da agenda em um intervalo de tempo. Use ISO 8601 para as datas (ex: 2024-06-30T00:00:00-03:00).",
    inputSchema: {
      timeMin: z.string().describe("Início do intervalo (ISO 8601, ex: 2024-06-30T00:00:00-03:00)"),
      timeMax: z.string().describe("Fim do intervalo (ISO 8601)"),
      maxResults: z.number().int().min(1).max(100).default(20),
      calendarId: z.string().default("primary").describe("ID do calendário (padrão: 'primary')"),
    },
  }, async ({ timeMin, timeMax, maxResults, calendarId }) => {
    const client = await auth.getClientForSession(sessionId);
    const result = await listEvents(client, timeMin, timeMax, maxResults, calendarId);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  });

  // ── 16. Calendar — criar ──────────────────────────────────────────────────
  server.registerTool("calendar_create_event", {
    title: "Criar evento no Google Calendar",
    description: "Cria um novo evento na agenda. Pode incluir participantes (envia convites automaticamente) e localização.",
    inputSchema: {
      summary: z.string().describe("Título do evento"),
      start: z.string().describe("Data/hora de início (ISO 8601, ex: 2024-07-01T14:00:00-03:00)"),
      end: z.string().describe("Data/hora de fim (ISO 8601)"),
      description: z.string().optional().describe("Descrição do evento"),
      location: z.string().optional().describe("Local do evento"),
      attendees: z.array(z.string().email()).optional().describe("Lista de e-mails dos participantes"),
      calendarId: z.string().default("primary"),
    },
  }, async ({ summary, start, end, description, location, attendees, calendarId }) => {
    const client = await auth.getClientForSession(sessionId);
    const result = await createEvent(client, summary, start, end, { description, location, attendees, calendarId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  });

  // ── 17. Sheets — ler ──────────────────────────────────────────────────────
  server.registerTool("sheets_read", {
    title: "Ler dados de uma planilha Google Sheets",
    description: "Lê os valores de um range de células em uma planilha. O range usa notação A1 (ex: 'Sheet1!A1:D10').",
    inputSchema: {
      spreadsheetId: z.string().describe("ID da planilha (da URL do Google Sheets)"),
      range: z.string().describe("Range em notação A1 (ex: 'Sheet1!A1:D10' ou 'A1:Z100')"),
    },
  }, async ({ spreadsheetId, range }) => {
    const client = await auth.getClientForSession(sessionId);
    const result = await readSheet(client, spreadsheetId, range);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  });

  // ── 18. Sheets — escrever ─────────────────────────────────────────────────
  server.registerTool("sheets_write", {
    title: "Escrever dados em uma planilha Google Sheets",
    description: "Sobrescreve um range de células com os dados fornecidos. values é um array de arrays (linhas > colunas).",
    inputSchema: {
      spreadsheetId: z.string().describe("ID da planilha"),
      range: z.string().describe("Range de destino em notação A1 (ex: 'Sheet1!A1')"),
      values: z.array(z.array(z.unknown())).describe("Dados: array de linhas, cada linha é array de valores"),
    },
  }, async ({ spreadsheetId, range, values }) => {
    const client = await auth.getClientForSession(sessionId);
    const result = await writeSheet(client, spreadsheetId, range, values as unknown[][]);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  });

  // ── 19. Sheets — append ───────────────────────────────────────────────────
  server.registerTool("sheets_append", {
    title: "Adicionar linhas em uma planilha Google Sheets",
    description: "Adiciona novas linhas ao final de um range em uma planilha, sem sobrescrever dados existentes.",
    inputSchema: {
      spreadsheetId: z.string().describe("ID da planilha"),
      range: z.string().describe("Range de referência (ex: 'Sheet1!A:Z') — os dados são inseridos após a última linha preenchida"),
      values: z.array(z.array(z.unknown())).describe("Linhas a adicionar"),
    },
  }, async ({ spreadsheetId, range, values }) => {
    const client = await auth.getClientForSession(sessionId);
    const result = await appendSheet(client, spreadsheetId, range, values as unknown[][]);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  });

  // ── 20. Notion — busca ───────────────────────────────────────────────────
  server.registerTool("notion_search", {
    title: "Buscar no Notion",
    description: "Busca páginas e databases no Notion. Requer NOTION_API_TOKEN configurado nas variáveis de ambiente.",
    inputSchema: {
      query: z.string().describe("Termo de busca"),
      pageSize: z.number().int().min(1).max(20).default(10),
    },
  }, async ({ query, pageSize }) => {
    const token = process.env.NOTION_API_TOKEN;
    if (!token) throw new Error("NOTION_API_TOKEN não configurado. Adicione nas variáveis de ambiente do servidor.");
    const result = await searchNotion(token, query, pageSize);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  });

  // ── 21. Slack — enviar mensagem ───────────────────────────────────────────
  server.registerTool("slack_send", {
    title: "Enviar mensagem no Slack",
    description: "Envia uma mensagem para um canal ou usuário do Slack. Requer SLACK_BOT_TOKEN configurado.",
    inputSchema: {
      channel: z.string().describe("Canal (ex: #geral) ou ID do usuário (ex: U01234)"),
      text: z.string().describe("Texto da mensagem (suporta Slack markdown)"),
      username: z.string().optional().default("MCP Assistant").describe("Nome exibido como remetente"),
    },
  }, async ({ channel, text, username }) => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) throw new Error("SLACK_BOT_TOKEN não configurado. Adicione nas variáveis de ambiente do servidor.");
    const result = await sendSlackMessage(token, channel, text, username);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
  });

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
