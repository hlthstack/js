/**
 * Client-side input validation.
 *
 * `src/generated/validation.ts` holds, per operation, the request schemas and the
 * `x-hlthstack-rules` from the OpenAPI spec (built by `scripts/build-validation.mjs`). This
 * module applies them: the subset of JSON Schema the spec uses, plus each rule kind. It
 * collects every problem instead of stopping at the first.
 */
import { operations, type ValidatedOperation } from './generated/validation.js';
import { describeFile, isFileInput } from './uploads.js';

export type { ValidatedOperation };

/** One problem found in the input. */
export interface ValidationIssue {
  /** Where the problem is, for example `customers[0].api_customer_id`. Empty for the whole input. */
  path: string;
  /** What is wrong, for example `must match ^[a-zA-Z0-9]+$`. */
  message: string;
  /** The schema keyword (`required`, `pattern`, ...) or rule kind (`relative_date`, ...) that failed. */
  rule: string;
}

// ------------------------------------------------------------------ generated shapes

/** The JSON Schema keywords the spec's request schemas use (the build script rejects others). */
export interface Schema {
  type?: string | readonly string[];
  properties?: Record<string, Schema>;
  required?: readonly string[];
  items?: Schema;
  enum?: readonly unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
  oneOf?: readonly Schema[];
  anyOf?: readonly Schema[];
  allOf?: readonly Schema[];
  /** A file part of a multipart body (`contentMediaType` in the spec). */
  file?: boolean;
}

export interface Condition {
  field: string;
  /** Holds when the field is not sent or blank. */
  blank?: boolean;
  equals?: string | boolean;
  notEquals?: string | boolean;
}

interface RuleBase {
  description: string;
  fields: readonly string[];
}

export type Rule = RuleBase &
  (
    | { rule: 'at_least_one_of' | 'mutually_exclusive' | 'positive_decimal' | 'unique_by' }
    | { rule: 'required_if'; required: readonly string[]; when: Condition }
    | { rule: 'allowed_only_if'; allowed: readonly string[]; when: Condition }
    | {
        rule: 'relative_date';
        targets: readonly string[];
        before?: 'today';
        years?: number;
        inclusive?: boolean;
        after?: 'now';
        unless?: Condition;
        defaultOffset?: string;
      }
    | { rule: 'no_conflicting_pincode'; pincode: string; text: readonly string[]; when?: Condition }
    | {
        rule: 'file_limits';
        files: readonly string[];
        maxBytes?: number;
        extensions?: readonly string[];
        contentTypes?: readonly string[];
      }
    | { rule: 'item_count'; arrays: readonly string[]; min?: number; max?: number }
  );

export interface OperationValidation {
  params?: Schema;
  query?: Schema;
  body?: Schema;
  form?: Schema;
  bodyRequired?: boolean;
  rules?: readonly Rule[];
}

// ------------------------------------------------------------------ entry point

export interface RequestInput {
  /** Path parameters, by their spec names. */
  params?: Record<string, unknown>;
  /** Query parameters. `undefined` and `null` values are not sent, so they count as absent. */
  query?: object;
  /** JSON body. */
  body?: unknown;
  /** Multipart body, as structured input (`customers[][dob]` is `customers[].dob`). */
  form?: unknown;
}

/**
 * Validates one request's inputs against the spec. Returns every problem found (empty when
 * the input is valid). `now` is the clock for date rules.
 */
export function validateRequest(
  operation: ValidatedOperation,
  input: RequestInput,
  now: Date = new Date(),
): ValidationIssue[] {
  const spec: OperationValidation = operations[operation];
  if (!spec) throw new Error(`Unknown operation ${operation}`);
  const issues: ValidationIssue[] = [];
  const query = input.query === undefined ? undefined : stripAbsent(input.query);

  if (spec.params) check(spec.params, input.params ?? {}, '', issues, true);
  if (spec.query) check(spec.query, query ?? {}, '', issues, true);
  const multipart = input.form !== undefined;
  const bodySchema = multipart ? spec.form : spec.body;
  const body = multipart ? input.form : input.body;
  if (bodySchema !== undefined) {
    if (body === undefined) {
      if (spec.bodyRequired) issues.push({ path: '', message: 'a request body is required', rule: 'required' });
    } else {
      check(bodySchema, body, '', issues, multipart);
    }
  }

  if (spec.rules) {
    const root = {
      ...(isObject(input.params) ? input.params : {}),
      ...(isObject(query) ? query : {}),
      ...(isObject(body) ? body : {}),
    };
    for (const rule of spec.rules) applyRule(rule, root, issues, now);
  }
  return issues;
}

// ------------------------------------------------------------------ schemas

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isFileInput(value);
}

function stripAbsent(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => v !== undefined && v !== null).map(stripAbsent);
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined && v !== null) out[k] = stripAbsent(v);
  return out;
}

function join(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (isFileInput(value)) return 'file';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function hasType(type: string, value: unknown): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isObject(value);
    default:
      return false;
  }
}

const regexCache = new Map<string, RegExp>();
function regex(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern);
    regexCache.set(pattern, re);
  }
  return re;
}

function show(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function listValues(values: readonly unknown[]): string {
  const shown = values.slice(0, 8).map(show).join(', ');
  return values.length > 8 ? `${shown}, ... (${values.length} values)` : shown;
}

/**
 * Checks `value` against `schema`, appending problems to `issues`. `loose` is for query and
 * multipart fields, which travel as text: a number or boolean is accepted where a string is
 * expected and checked as its text.
 */
function check(schema: Schema, value: unknown, path: string, issues: ValidationIssue[], loose = false): void {
  if (schema.file) {
    if (!isFileInput(value)) {
      issues.push({
        path,
        message: `must be a file (Blob, ArrayBuffer, Uint8Array/Buffer or { data, filename }), got ${typeOf(value)}`,
        rule: 'type',
      });
    }
    return;
  }

  if (schema.type !== undefined) {
    const types = [schema.type].flat();
    if (!types.some((t) => hasType(t, value))) {
      if (loose && (typeof value === 'number' || typeof value === 'boolean') && types.includes('string')) {
        value = String(value);
      } else {
        issues.push({ path, message: `must be ${types.join(' or ')}, got ${typeOf(value)}`, rule: 'type' });
        return;
      }
    }
  }

  if (schema.enum && !schema.enum.some((e) => e === value)) {
    issues.push({ path, message: `must be one of ${listValues(schema.enum)}`, rule: 'enum' });
  }

  if (typeof value === 'string') checkString(schema, value, path, issues);
  if (typeof value === 'number') checkNumber(schema, value, path, issues);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path, message: `must have at least ${schema.minItems} item(s)`, rule: 'minItems' });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path, message: `must have at most ${schema.maxItems} item(s)`, rule: 'maxItems' });
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) => check(schema.items!, item, join(path, i), issues, loose));
    }
  }
  if (isObject(value)) checkObject(schema, value, path, issues, loose);

  for (const branch of schema.allOf ?? []) check(branch, value, path, issues, loose);
  if (schema.anyOf) checkAlternatives(schema.anyOf, 'anyOf', value, path, issues, loose);
  if (schema.oneOf) checkAlternatives(schema.oneOf, 'oneOf', value, path, issues, loose);
}

function checkString(schema: Schema, value: string, path: string, issues: ValidationIssue[]): void {
  const length = [...value].length;
  if (schema.minLength !== undefined && length < schema.minLength) {
    issues.push({ path, message: `must be at least ${schema.minLength} characters`, rule: 'minLength' });
  }
  if (schema.maxLength !== undefined && length > schema.maxLength) {
    issues.push({ path, message: `must be at most ${schema.maxLength} characters`, rule: 'maxLength' });
  }
  if (schema.pattern !== undefined && !regex(schema.pattern).test(value)) {
    issues.push({ path, message: `must match ${schema.pattern}`, rule: 'pattern' });
  }
  if (schema.format !== undefined && !FORMATS[schema.format]?.(value)) {
    issues.push({ path, message: `must be ${FORMAT_NAMES[schema.format] ?? schema.format}`, rule: 'format' });
  }
}

function checkNumber(schema: Schema, value: number, path: string, issues: ValidationIssue[]): void {
  if (schema.minimum !== undefined && value < schema.minimum) {
    issues.push({ path, message: `must be >= ${schema.minimum}`, rule: 'minimum' });
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    issues.push({ path, message: `must be <= ${schema.maximum}`, rule: 'maximum' });
  }
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    issues.push({ path, message: `must be > ${schema.exclusiveMinimum}`, rule: 'exclusiveMinimum' });
  }
}

function checkObject(
  schema: Schema,
  value: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
  loose: boolean,
): void {
  for (const key of schema.required ?? []) {
    if (value[key] === undefined) issues.push({ path: join(path, key), message: 'is required', rule: 'required' });
  }
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const propertySchema = schema.properties?.[key];
    if (propertySchema !== undefined) check(propertySchema, child, join(path, key), issues, loose);
  }
}

function checkAlternatives(
  branches: readonly Schema[],
  keyword: 'anyOf' | 'oneOf',
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  loose: boolean,
): void {
  const results = branches.map((branch) => {
    const found: ValidationIssue[] = [];
    check(branch, value, path, found, loose);
    return found;
  });
  const passing = results.filter((r) => r.length === 0).length;
  if (keyword === 'oneOf' && passing > 1) {
    issues.push({ path, message: 'matches more than one of the accepted forms', rule: 'oneOf' });
    return;
  }
  if (passing > 0) return;
  // When only one branch accepts the value's type, its problems are the useful ones.
  const typed = results.filter((r) => !r.some((i) => i.rule === 'type' && i.path === path));
  if (typed.length === 1) {
    issues.push(...typed[0]!);
    return;
  }
  issues.push({ path, message: 'does not match any of the accepted forms', rule: keyword });
}

// ------------------------------------------------------------------ formats

function validDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// The offset is optional: the API reads a date-time without one as IST.
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?$/;

const FORMATS: Record<string, (value: string) => boolean> = {
  date: (v) => {
    const m = DATE.exec(v);
    return Boolean(m) && validDay(Number(m![1]), Number(m![2]), Number(m![3]));
  },
  'date-time': (v) => {
    const m = DATE_TIME.exec(v);
    if (!m || !validDay(Number(m[1]), Number(m[2]), Number(m[3]))) return false;
    return Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6] ?? 0) < 61;
  },
  uri: (v) => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$/.test(v),
  uuid: (v) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v),
};

const FORMAT_NAMES: Record<string, string> = {
  date: 'a date (YYYY-MM-DD)',
  'date-time': 'an ISO 8601 date-time (2026-01-15T03:30:00Z)',
  uri: 'a URI',
  uuid: 'a UUID',
};

// ------------------------------------------------------------------ rules

interface Located {
  path: string;
  value: unknown;
}

/**
 * Resolves a dotted field path (`customers[].dob`, `address.pincode`) to every value it names.
 * Missing parents yield nothing; a missing leaf yields `undefined`.
 */
function select(root: Record<string, unknown>, field: string): Located[] {
  let current: Located[] = [{ path: '', value: root }];
  for (const part of field.split('.')) {
    const array = part.endsWith('[]');
    const key = array ? part.slice(0, -2) : part;
    const next: Located[] = [];
    for (const { path, value } of current) {
      if (!isObject(value)) continue;
      const child = value[key];
      const childPath = join(path, key);
      if (!array) next.push({ path: childPath, value: child });
      else if (Array.isArray(child)) child.forEach((item, i) => next.push({ path: join(childPath, i), value: item }));
    }
    current = next;
  }
  return current;
}

/** The objects that hold the given fields' last segments (all fields share a parent). */
function containers(root: Record<string, unknown>, fields: readonly string[]): Array<{ path: string; value: Record<string, unknown>; keys: string[] }> {
  const parent = (f: string) => (f.includes('.') ? f.slice(0, f.lastIndexOf('.')) : '');
  const prefix = parent(fields[0]!);
  const keys = fields.map((f) => f.slice(f.lastIndexOf('.') + 1));
  const found = prefix === '' ? [{ path: '', value: root as unknown }] : select(root, prefix);
  return found.filter((c): c is { path: string; value: Record<string, unknown> } => isObject(c.value)).map((c) => ({ ...c, keys }));
}

function blank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function normalize(value: unknown): string | undefined {
  return blank(value) ? undefined : String(value).trim().toLowerCase();
}

function holds(condition: Condition, scope: Record<string, unknown>): boolean {
  const value = scope[condition.field];
  if (condition.blank) return blank(value);
  if (condition.equals !== undefined) return normalize(value) === String(condition.equals).toLowerCase();
  if (condition.notEquals !== undefined) return normalize(value) !== String(condition.notEquals).toLowerCase();
  return false;
}

function describeCondition(condition: Condition): string {
  if (condition.blank) return `when ${condition.field} is not sent`;
  if (condition.notEquals !== undefined) return `unless ${condition.field} is ${condition.notEquals}`;
  return `when ${condition.field} is ${condition.equals}`;
}

function applyRule(rule: Rule, root: Record<string, unknown>, issues: ValidationIssue[], now: Date): void {
  const add = (path: string, message: string) => issues.push({ path, message, rule: rule.rule });
  switch (rule.rule) {
    case 'required_if':
      if (!holds(rule.when, root)) return;
      for (const field of rule.required) {
        if (blank(root[field])) add(field, `is required ${describeCondition(rule.when)}`);
      }
      return;

    case 'allowed_only_if':
      if (holds(rule.when, root)) return;
      for (const field of rule.allowed) {
        if (!blank(root[field])) {
          add(field, `is accepted only when ${rule.when.field} is ${rule.when.equals}`);
        }
      }
      return;

    case 'at_least_one_of':
      for (const { path, value, keys } of containers(root, rule.fields)) {
        if (keys.every((k) => blank(value[k]))) add(path, `send at least one of ${keys.join(', ')}`);
      }
      return;

    case 'mutually_exclusive':
      for (const { path, value, keys } of containers(root, rule.fields)) {
        const sent = keys.filter((k) => !blank(value[k]));
        if (sent.length > 1) add(path, `send only one of ${keys.join(', ')}`);
      }
      return;

    case 'unique_by': {
      const field = rule.fields[0]!;
      const seen = new Map<string, string>();
      for (const { path, value } of select(root, field)) {
        if (value === undefined || value === null) continue;
        const key = String(value);
        const first = seen.get(key);
        if (first !== undefined) add(path, `duplicates ${first} (${show(value)})`);
        else seen.set(key, path);
      }
      return;
    }

    case 'positive_decimal':
      for (const field of rule.fields) {
        for (const { path, value } of select(root, field)) {
          if (value === undefined || value === null) continue;
          if (!isPositiveDecimal(value)) add(path, 'must be a decimal number greater than 0');
        }
      }
      return;

    case 'item_count': {
      let total = 0;
      for (const field of rule.arrays) {
        const [found] = select(root, field);
        if (Array.isArray(found?.value)) total += found.value.length;
      }
      const what = rule.arrays.join(' and ');
      const path = rule.arrays.length === 1 ? rule.arrays[0]! : '';
      const together = rule.arrays.length > 1 ? ' together' : '';
      if (rule.min !== undefined && rule.max === rule.min && total !== rule.min) {
        add(path, `${what} must have exactly ${rule.min} item(s)${together}, got ${total}`);
      } else if (rule.min !== undefined && total < rule.min) {
        add(path, `${what} must have at least ${rule.min} item(s)${together}, got ${total}`);
      } else if (rule.max !== undefined && total > rule.max) {
        add(path, `${what} must have at most ${rule.max} item(s)${together}, got ${total}`);
      }
      return;
    }

    case 'relative_date':
      if (rule.unless && holds(rule.unless, root)) return;
      for (const field of rule.targets) {
        for (const { path, value } of select(root, field)) {
          if (blank(value) || typeof value !== 'string') continue;
          const problem = checkRelativeDate(rule, value, now);
          if (problem) add(path, problem);
        }
      }
      return;

    case 'no_conflicting_pincode': {
      if (rule.when && !holds(rule.when, root)) return;
      for (const { path, value } of containers(root, [rule.pincode])) {
        const country = value.country;
        if (!blank(country) && !/^\s*india\s*$/i.test(String(country))) continue;
        // zip_code is an alias of pincode where the address accepts both.
        const allowed = [value.pincode, value.zip_code].filter((v) => !blank(v)).map((v) => String(v).trim());
        if (allowed.length === 0) continue;
        for (const field of rule.text) {
          const key = field.slice(field.lastIndexOf('.') + 1);
          const text = value[key];
          if (typeof text !== 'string') continue;
          const other = (text.match(/(?<!\d)\d{6}(?!\d)/g) ?? []).find((n) => !allowed.includes(n));
          if (other) add(join(path, key), `contains the pincode ${other}, which differs from the address pincode ${allowed[0]}`);
        }
      }
      return;
    }

    case 'file_limits':
      for (const field of rule.files) {
        for (const located of select(root, field)) {
          const files = Array.isArray(located.value)
            ? located.value.map((value, i) => ({ path: join(located.path, i), value }))
            : [located];
          for (const { path, value } of files) {
            if (!isFileInput(value)) continue;
            const file = describeFile(value);
            if (rule.maxBytes !== undefined && file.size > rule.maxBytes) {
              add(path, `is ${file.size} bytes; at most ${rule.maxBytes} bytes are accepted`);
            }
            if (rule.extensions) {
              const ext = /\.([^.]+)$/.exec(file.filename)?.[1]?.toLowerCase();
              if (!ext || !rule.extensions.includes(ext)) {
                add(path, `needs a filename ending in .${rule.extensions.join(', .')} (got ${show(file.filename)})`);
              }
            }
            if (rule.contentTypes && !(file.type && rule.contentTypes.includes(file.type))) {
              add(
                path,
                `must be ${rule.contentTypes.join(', ')} (got ${file.type ? show(file.type) : 'no content type'}; pass a filename or contentType)`,
              );
            }
          }
        }
      }
      return;
  }
}

function isPositiveDecimal(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value !== 'string' || !/^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*$/.test(value)) return false;
  return Number(value) > 0;
}

/** The API's calendar day: India Standard Time (UTC+05:30, no daylight saving). */
const IST_OFFSET_MS = 330 * 60 * 1000;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** `YYYY-MM-DD`, `DD-MM-YYYY` or `DD/MM/YYYY` -> sortable `YYYY-MM-DD`, or undefined. */
function parseDay(value: string): string | undefined {
  const v = value.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return validDay(+m[1]!, +m[2]!, +m[3]!) ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
  m = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(v);
  if (m) return validDay(+m[3]!, +m[2]!, +m[1]!) ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
  return undefined;
}

function checkRelativeDate(rule: Extract<Rule, { rule: 'relative_date' }>, value: string, now: Date): string | undefined {
  if (rule.after === 'now') {
    if (!FORMATS['date-time']!(value)) return undefined; // the format check reports it
    let text = value.trim().replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    const offset = /(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(text);
    if (!offset) text += rule.defaultOffset ?? 'Z';
    const at = Date.parse(text);
    if (Number.isNaN(at) || at > now.getTime()) return undefined;
    const note = !offset && rule.defaultOffset ? `; without an offset it is read as ${rule.defaultOffset}` : '';
    return `must be later than now (${now.toISOString()})${note}`;
  }
  const day = parseDay(value);
  if (!day) return undefined; // the format or pattern check reports it
  const today = new Date(now.getTime() + IST_OFFSET_MS);
  const year = today.getUTCFullYear() + (rule.years ?? 0);
  const month = today.getUTCMonth() + 1;
  // The same date `years` ago; 29 February falls back to 28 February.
  const date = Math.min(today.getUTCDate(), new Date(Date.UTC(year, month, 0)).getUTCDate());
  const limit = `${pad(year, 4)}-${pad(month)}-${pad(date)}`;
  if (day < limit || (rule.inclusive && day === limit)) return undefined;
  return rule.years
    ? `must be on or before ${limit} (at least ${-rule.years} year(s) ago)`
    : `must not be after today (${limit})`;
}
