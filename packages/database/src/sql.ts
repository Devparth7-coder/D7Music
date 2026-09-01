/**
 * Tiny SQL builder. All repositories use this so parameters are always bound
 * positionally ($1, $2, …) — no string interpolation of user input anywhere.
 */
export class Sql {
  private params: unknown[] = [];
  private parts: string[] = [];

  constructor(text = '') {
    if (text) this.parts.push(text);
  }

  /** Reserve the next placeholder for a value. Returns the `$n` token. */
  bind(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  bindList(values: unknown[], cast?: string): string {
    const tokens = values.map((v) => this.bind(v));
    return cast ? `array[${tokens.join(',')}]::${cast}` : `array[${tokens.join(',')}]`;
  }

  get placeholders() {
    return this.params.map((_, i) => `$${i + 1}`);
  }

  push(...chunks: (string | undefined | false)[]) {
    for (const c of chunks) if (c) this.parts.push(c);
    return this;
  }

  get text() {
    return this.parts.join(' ');
  }

  get values() {
    return this.params;
  }

  /** Number of bound params *before* any further binding — useful for `array_position`. */
  get size() {
    return this.params.length;
  }

  static escapeIdent(name: string) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unsafe identifier: ${name}`);
    return `"${name}"`;
  }

  /** Whitelisted ORDER BY fragment builder. */
  static order(directions: Record<string, 'ASC' | 'DESC'>, allowed: Record<string, string>, fallback: string) {
    const clauses = Object.entries(directions)
      .filter(([k, v]) => allowed[k] && (v === 'ASC' || v === 'DESC'))
      .map(([k, v]) => `${allowed[k]} ${v}`);
    return clauses.length ? clauses.join(', ') : fallback;
  }
}

/** LIMIT/OFFSET clamp shared by every list endpoint. */
export function paging(input: { limit?: number; offset?: number }, def = 20, max = 100) {
  const limit = Math.max(1, Math.min(max, Math.trunc(input.limit ?? def)));
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  return { limit, offset };
}
