export function validateCnpj(cnpj: string): boolean {
  const n = cnpj.replace(/\D/g, "");
  if (n.length !== 14 || /^(\d)\1+$/.test(n)) return false;
  const d = n.split("").map(Number);
  const w1 = [5,4,3,2,9,8,7,6,5,4,3,2];
  const w2 = [6,5,4,3,2,9,8,7,6,5,4,3,2];
  const s1 = d.slice(0,12).reduce((a,v,i) => a + v * w1[i], 0);
  const d1 = s1 % 11 < 2 ? 0 : 11 - (s1 % 11);
  const s2 = d.slice(0,13).reduce((a,v,i) => a + v * w2[i], 0);
  const d2 = s2 % 11 < 2 ? 0 : 11 - (s2 % 11);
  return d[12] === d1 && d[13] === d2;
}

export function validateCpf(cpf: string): boolean {
  const n = cpf.replace(/\D/g, "");
  if (n.length !== 11 || /^(\d)\1+$/.test(n)) return false;
  const d = n.split("").map(Number);
  const s1 = d.slice(0,9).reduce((a,v,i) => a + v * (10 - i), 0);
  const d1 = (s1 * 10) % 11 >= 10 ? 0 : (s1 * 10) % 11;
  const s2 = d.slice(0,10).reduce((a,v,i) => a + v * (11 - i), 0);
  const d2 = (s2 * 10) % 11 >= 10 ? 0 : (s2 * 10) % 11;
  return d[9] === d1 && d[10] === d2;
}

export function formatDocument(value: string): {
  type: "CNPJ" | "CPF" | "inválido"; valid: boolean; formatted: string; raw: string;
} {
  const raw = value.replace(/\D/g, "");
  if (raw.length === 14) {
    return { type: "CNPJ", valid: validateCnpj(raw), formatted: raw.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5"), raw };
  }
  if (raw.length === 11) {
    return { type: "CPF", valid: validateCpf(raw), formatted: raw.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4"), raw };
  }
  return { type: "inválido", valid: false, formatted: value, raw };
}
