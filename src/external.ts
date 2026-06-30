// CEP via ViaCEP
export async function lookupCep(cep: string): Promise<{
  cep: string; logradouro: string; complemento?: string;
  bairro: string; localidade: string; uf: string; ibge: string;
}> {
  const c = cep.replace(/\D/g, "");
  if (c.length !== 8) throw new Error(`CEP inválido: ${cep}`);
  const res = await fetch(`https://viacep.com.br/ws/${c}/json/`);
  if (!res.ok) throw new Error(`Erro ao consultar CEP: ${res.statusText}`);
  const data = await res.json() as Record<string, unknown> & { erro?: boolean };
  if (data.erro) throw new Error(`CEP não encontrado: ${cep}`);
  return data as never;
}

// CNPJ via ReceitaWS
export async function lookupCnpj(cnpj: string): Promise<Record<string, unknown>> {
  const c = cnpj.replace(/\D/g, "");
  if (c.length !== 14) throw new Error(`CNPJ inválido: ${cnpj}`);
  const res = await fetch(`https://receitaws.com.br/v1/cnpj/${c}`, {
    headers: { "User-Agent": "mcp-pgmais/2.0" },
  });
  if (res.status === 429) throw new Error("Rate limit da ReceitaWS. Tente em alguns segundos.");
  if (!res.ok) throw new Error(`Erro ao consultar CNPJ: ${res.statusText}`);
  const data = await res.json() as Record<string, unknown>;
  if (data["status"] === "ERROR") throw new Error(`CNPJ não encontrado: ${data["message"] ?? cnpj}`);
  return data;
}

// Conversão de moedas via AwesomeAPI
export async function convertCurrency(from: string, to: string, amount: number): Promise<{
  from: string; to: string; amount: number; rate: number; result: number; updatedAt: string;
}> {
  const pair = `${from.toUpperCase()}-${to.toUpperCase()}`;
  const res = await fetch(`https://economia.awesomeapi.com.br/json/last/${pair}`);
  if (!res.ok) throw new Error(`Par de moedas não suportado: ${pair}`);
  const data = await res.json() as Record<string, { bid: string; create_date: string }>;
  const key = pair.replace("-", "");
  const rate = parseFloat(data[key].bid);
  return { from: from.toUpperCase(), to: to.toUpperCase(), amount, rate, result: parseFloat((amount * rate).toFixed(4)), updatedAt: data[key].create_date };
}

// Web search — Brave (se BRAVE_SEARCH_API_KEY) ou DuckDuckGo
export interface WebSearchResult { title: string; url: string; description: string; }

async function braveSearch(query: string, count: number, key: string): Promise<WebSearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  url.searchParams.set("search_lang", "pt");
  url.searchParams.set("country", "br");
  url.searchParams.set("text_decorations", "false");
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
  });
  if (!res.ok) throw new Error(`Brave Search: ${res.statusText}`);
  const data = await res.json() as { web?: { results: Array<{ title: string; url: string; description?: string }> } };
  return (data.web?.results ?? []).map(r => ({ title: r.title, url: r.url, description: r.description ?? "" }));
}

async function ddgSearch(query: string): Promise<WebSearchResult[]> {
  const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
  if (!res.ok) throw new Error("Falha na busca DuckDuckGo");
  const d = await res.json() as {
    AbstractText?: string; AbstractURL?: string; AbstractSource?: string;
    Answer?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: unknown[] }>;
  };
  const results: WebSearchResult[] = [];
  if (d.Answer) results.push({ title: "Resposta direta", url: "", description: d.Answer });
  if (d.AbstractText) results.push({ title: d.AbstractSource ?? "Resumo", url: d.AbstractURL ?? "", description: d.AbstractText });
  for (const t of (d.RelatedTopics ?? []).slice(0, 5)) {
    if (t.Text && !t.Topics) results.push({ title: t.Text.slice(0, 80), url: t.FirstURL ?? "", description: t.Text });
  }
  return results;
}

export async function webSearch(query: string, count = 5): Promise<{ query: string; provider: string; results: WebSearchResult[] }> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (key) return { query, provider: "Brave Search", results: await braveSearch(query, count, key) };
  return { query, provider: "DuckDuckGo", results: (await ddgSearch(query)).slice(0, count) };
}
