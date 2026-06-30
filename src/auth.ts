import { randomUUID } from "node:crypto";
import { Auth, google } from "googleapis";
import { Redis } from "@upstash/redis";

type OAuth2Client = Auth.OAuth2Client;
type Credentials = Auth.Credentials;

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/spreadsheets",
];
const TOKEN_PREFIX = "mcp:session:";

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

if (!redis) {
  console.warn(
    "[auth] UPSTASH_REDIS_REST_URL/TOKEN ausentes — tokens não sobreviverão a reinicializações."
  );
}

type PendingState = { createdAt: number };

export class AuthManager {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  // In-memory cache para evitar roundtrips desnecessários ao Redis
  private cache = new Map<string, Credentials>();
  private pendingStates = new Map<string, PendingState>();

  constructor() {
    this.clientId = process.env.GOOGLE_CLIENT_ID ?? "";
    this.clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
    this.redirectUri = process.env.GOOGLE_REDIRECT_URI ?? "";
    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      console.warn(
        "[auth] GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI ausentes — preencha o .env antes de autenticar."
      );
    }
  }

  private async getTokens(sessionId: string): Promise<Credentials | null> {
    if (this.cache.has(sessionId)) return this.cache.get(sessionId)!;
    if (!redis) return null;
    const stored = await redis.get<Credentials>(TOKEN_PREFIX + sessionId);
    if (stored) this.cache.set(sessionId, stored);
    return stored ?? null;
  }

  private async setTokens(sessionId: string, tokens: Credentials): Promise<void> {
    this.cache.set(sessionId, tokens);
    if (redis) await redis.set(TOKEN_PREFIX + sessionId, tokens);
  }

  private newClient(): OAuth2Client {
    return new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
  }

  createAuthUrl(sessionId: string): string {
    const state = randomUUID();
    this.pendingStates.set(state, { createdAt: Date.now() });
    const client = this.newClient();
    return client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
      state: `${sessionId}:${state}`,
    });
  }

  async handleCallback(code: string, state: string): Promise<string> {
    const [sessionId, stateToken] = state.split(":");
    if (!sessionId || !this.pendingStates.has(stateToken)) {
      throw new Error("Estado OAuth inválido ou expirado.");
    }
    this.pendingStates.delete(stateToken);
    const client = this.newClient();
    const { tokens } = await client.getToken(code);
    await this.setTokens(sessionId, tokens);
    return sessionId;
  }

  async isAuthenticated(sessionId: string): Promise<boolean> {
    return (await this.getTokens(sessionId)) !== null;
  }

  async getClientForSession(sessionId: string): Promise<OAuth2Client> {
    const tokens = await this.getTokens(sessionId);
    if (!tokens) {
      throw new Error(
        "Sessão não autenticada com o Google Drive. Use a tool 'drive_get_auth_url' primeiro."
      );
    }
    const client = this.newClient();
    client.setCredentials(tokens);
    client.on("tokens", async (newTokens) => {
      await this.setTokens(sessionId, { ...tokens, ...newTokens });
    });
    return client;
  }
}
