#!/usr/bin/env node
/**
 * Builds src/generated/validation.ts from openapi/openapi.yaml (run by `npm run generate`).
 *
 * For every operation it resolves the path, query and request-body schemas (multipart field
 * names such as `customers[][dob]` become nested `customers[].dob` schemas), keeps only the
 * validation keywords, and turns each `x-hlthstack-rules` entry into a structured rule the
 * runtime validator (src/validation.ts) can apply.
 *
 * It fails loudly on anything the validator does not implement: an unknown schema keyword,
 * `format`, rule kind, or a rule description it cannot interpret. Extend the validator and
 * this script together.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = resolve(root, 'openapi/openapi.yaml');
const OUT = resolve(root, 'src/generated/validation.ts');

const spec = yaml.load(readFileSync(SPEC, 'utf8'));

/** Keywords the runtime validator implements: exactly those the request schemas use. */
const VALIDATION_KEYWORDS = new Set([
  'type', 'properties', 'required', 'items', 'enum', 'pattern', 'minLength', 'maxLength',
  'minimum', 'maximum', 'exclusiveMinimum', 'minItems', 'maxItems', 'format', 'oneOf',
  'anyOf', 'allOf',
]);
/** Keywords that do not constrain the value. */
const ANNOTATIONS = new Set([
  'description', 'example', 'examples', 'default', 'deprecated', 'title', 'readOnly',
  'writeOnly', 'contentMediaType', 'contentEncoding',
]);
const FORMATS = new Set(['date', 'date-time', 'uri', 'uuid']);
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const RULE_KINDS = new Set(Object.keys(spec['x-hlthstack-rule-kinds'] ?? {}));
const IMPLEMENTED_RULES = new Set([
  'required_if', 'at_least_one_of', 'mutually_exclusive', 'allowed_only_if', 'unique_by',
  'relative_date', 'no_conflicting_pincode', 'file_limits', 'item_count', 'positive_decimal',
]);

function fail(where, message) {
  throw new Error(`build-validation: ${where}: ${message}`);
}

for (const kind of RULE_KINDS) {
  if (!IMPLEMENTED_RULES.has(kind)) fail('x-hlthstack-rule-kinds', `rule kind "${kind}" is not implemented`);
}

function resolveRef(ref, where) {
  if (!ref.startsWith('#/')) fail(where, `external $ref ${ref}`);
  let node = spec;
  for (const part of ref.slice(2).split('/')) {
    node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) fail(where, `unresolved $ref ${ref}`);
  }
  return node;
}

/** Resolves $refs and keeps only validation keywords. */
function convert(schema, where, stack = []) {
  if (!schema || typeof schema !== 'object') fail(where, 'schema is not an object');
  if (schema.$ref) {
    if (stack.includes(schema.$ref)) fail(where, `recursive $ref ${schema.$ref}`);
    const siblings = Object.keys(schema).filter((k) => k !== '$ref' && !ANNOTATIONS.has(k));
    if (siblings.length) fail(where, `$ref with sibling keywords ${siblings.join(', ')}`);
    return convert(resolveRef(schema.$ref, where), `${where} -> ${schema.$ref}`, [...stack, schema.$ref]);
  }
  // A file part of a multipart body.
  if (schema.contentMediaType) return { file: true };
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key) || key.startsWith('x-')) continue;
    if (!VALIDATION_KEYWORDS.has(key)) fail(where, `unsupported keyword "${key}"`);
    switch (key) {
      case 'type':
        for (const t of [value].flat()) if (!TYPES.has(t)) fail(where, `unknown type "${t}"`);
        out.type = value;
        break;
      case 'format':
        if (!FORMATS.has(value)) fail(where, `unsupported format "${value}"`);
        out.format = value;
        break;
      case 'pattern':
        try {
          new RegExp(value);
        } catch (error) {
          fail(where, `pattern does not compile: ${error.message}`);
        }
        out.pattern = value;
        break;
      case 'properties':
        out.properties = Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, convert(v, `${where}.${k}`, stack)]),
        );
        break;
      case 'items':
        out.items = convert(value, `${where}[]`, stack);
        break;
      case 'oneOf':
      case 'anyOf':
      case 'allOf':
        out[key] = value.map((v, i) => convert(v, `${where}.${key}[${i}]`, stack));
        break;
      default:
        out[key] = value;
    }
  }
  return out;
}

/**
 * Builds an object schema from flat field names (query parameters, multipart fields):
 * `a[b]` -> `a.b`, `a[]` -> array `a`, `a[][b]` -> array `a` of objects with `b`.
 */
function nest(fields, where) {
  const top = { type: 'object', properties: {}, required: [] };
  for (const { name, schema, required } of fields) {
    const match = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(name);
    if (!match) fail(where, `cannot parse field name "${name}"`);
    const steps = [match[1], ...[...match[2].matchAll(/\[([^[\]]*)\]/g)].map((m) => m[1] || '[]')];
    let node = top;
    for (let i = 0; i < steps.length; i += 1) {
      const key = steps[i];
      if (key === '[]') fail(where, `cannot parse field name "${name}"`);
      if (required && !node.required.includes(key)) node.required.push(key);
      const next = steps[i + 1];
      if (next === undefined) {
        node.properties[key] = schema;
      } else if (next === '[]' && steps[i + 2] === undefined) {
        // `files[]`: an array of the schema, unless the schema already describes the array.
        node.properties[key] = schema.type === 'array' ? schema : { type: 'array', items: schema };
        break;
      } else if (next === '[]') {
        node.properties[key] ??= { type: 'array', items: { type: 'object', properties: {}, required: [] } };
        node = node.properties[key].items;
        if (!node?.properties) fail(where, `"${name}" mixes array and object fields`);
        i += 1;
      } else {
        node.properties[key] ??= { type: 'object', properties: {}, required: [] };
        node = node.properties[key];
        if (!node.properties) fail(where, `"${name}" mixes field shapes`);
      }
    }
  }
  return prune(top);
}

function prune(schema) {
  if (schema.required && schema.required.length === 0) delete schema.required;
  for (const child of Object.values(schema.properties ?? {})) prune(child);
  if (schema.items && typeof schema.items === 'object') prune(schema.items);
  return schema;
}

/** `customers[][dob]` -> `customers[].dob`, `files[]` -> `files`. */
function normalizeField(field) {
  return field.replace(/\[([^[\]]+)\]/g, '.$1').replace(/\[\]$/, '');
}

/** Whether a normalized field path exists in the operation's schemas. */
function fieldExists(schemas, field) {
  return schemas.some((schema) => schema && lookup(schema, field.split('.')));
}

function lookup(schema, parts) {
  if (!schema || typeof schema !== 'object') return false;
  if (parts.length === 0) return true;
  for (const branch of [...(schema.allOf ?? []), ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    if (lookup(branch, parts)) return true;
  }
  const [head, ...rest] = parts;
  if (head.endsWith('[]')) {
    const prop = schema.properties?.[head.slice(0, -2)];
    return Boolean(prop?.items) && lookup(prop.items, rest);
  }
  return schema.properties?.[head] !== undefined && lookup(schema.properties[head], rest);
}

// ------------------------------------------------------------------ rule descriptions

/** "a, b and c" / "a or b" -> [a, b, c] */
function list(text) {
  return text.split(/,\s*|\s+(?:and|or)\s+/).map((s) => s.trim()).filter(Boolean);
}

function literal(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/** Turns one `x-hlthstack-rules` entry into a structured rule. */
function parseRule(entry, where, schemas, bodyProperties) {
  const { rule, description, fields: rawFields } = entry;
  if (!RULE_KINDS.has(rule)) fail(where, `rule "${rule}" is not defined in x-hlthstack-rule-kinds`);
  if (!Array.isArray(rawFields) || rawFields.length === 0) fail(where, 'rule has no fields');
  const fields = rawFields.map(normalizeField);
  for (const field of fields) {
    if (!fieldExists(schemas, field)) fail(where, `rule field "${field}" is not in the operation's schemas`);
  }
  const base = { rule, description, fields };
  const unknown = (what = 'description') => fail(where, `cannot interpret ${rule} ${what}: "${description}"`);
  let m;
  switch (rule) {
    case 'at_least_one_of':
    case 'mutually_exclusive':
    case 'positive_decimal':
      return base;
    case 'unique_by': {
      if (fields.length !== 1 || !fields[0].includes('[].')) unknown('fields');
      return base;
    }
    case 'required_if': {
      if ((m = /^When (\w+) is not sent, (.+?) are both required\b/.exec(description))) {
        return { ...base, required: list(m[2]), when: { field: m[1], blank: true } };
      }
      if ((m = /^(\w+) is required when (\w+) is (\w+)\b/.exec(description))) {
        return { ...base, required: [m[1]], when: { field: m[2], equals: literal(m[3]) } };
      }
      if ((m = /^(\w+) is required unless (\w+) is (\w+)\b/.exec(description))) {
        return { ...base, required: [m[1]], when: { field: m[2], notEquals: literal(m[3]) } };
      }
      return unknown();
    }
    case 'allowed_only_if': {
      if ((m = /^(.+?) (?:is|are) accepted only when (\w+) is (\w+)\b/.exec(description))) {
        return { ...base, allowed: list(m[1]), when: { field: m[2], equals: literal(m[3]) } };
      }
      return unknown();
    }
    case 'relative_date': {
      let unless;
      if ((m = /^Unless (\w+) is (\w+), /.exec(description))) {
        unless = { field: m[1], equals: literal(m[2]) };
      }
      const targets = fields.filter((f) => f !== unless?.field);
      let compare;
      if (/on or before the same date one year ago/.test(description)) {
        compare = { before: 'today', years: -1, inclusive: true };
      } else if (/must not be after today/.test(description)) {
        compare = { before: 'today', years: 0, inclusive: true };
      } else if (/must be later than now/.test(description)) {
        compare = { after: 'now' };
      } else {
        return unknown();
      }
      return {
        ...base,
        targets,
        ...compare,
        ...(unless ? { unless } : {}),
        ...(/without an offset is read as IST/.test(description) ? { defaultOffset: '+05:30' } : {}),
      };
    }
    case 'no_conflicting_pincode': {
      const pincode = fields.filter((f) => f.endsWith('.pincode'));
      if (pincode.length !== 1) unknown('fields');
      let when;
      if (/^Home collection only\./.test(description)) {
        if (!bodyProperties?.appointment_type) fail(where, '"Home collection only" without an appointment_type field');
        when = { field: 'appointment_type', equals: 'home_collection' };
      } else if (!/^(When address is sent|A new address)/.test(description)) {
        return unknown();
      }
      return {
        ...base,
        pincode: pincode[0],
        text: fields.filter((f) => f !== pincode[0]),
        ...(when ? { when } : {}),
      };
    }
    case 'file_limits': {
      const files = fields.filter((f) => lookupFile(schemas, f));
      if (files.length === 0) unknown('fields');
      const out = { ...base, files };
      if ((m = /\bat most (\d+) MB\b/.exec(description))) out.maxBytes = Number(m[1]) * 1024 * 1024;
      else if ((m = /\bsmaller than (\d+) MB\b/.exec(description))) out.maxBytes = Number(m[1]) * 1024 * 1024 - 1;
      if ((m = /\(extension ([^)]+)\)/.exec(description))) {
        out.extensions = list(m[1]);
      } else {
        const types = description.match(/\b(?:image|application)\/[a-z0-9.+-]*[a-z0-9]/g);
        const named = /\bbe ((?:PDF|PNG|JPEG)(?:(?:, | or )(?:PDF|PNG|JPEG))*)\b/.exec(description);
        const names = { PDF: 'application/pdf', PNG: 'image/png', JPEG: 'image/jpeg' };
        if (types) out.contentTypes = [...new Set(types)];
        else if (named) out.contentTypes = list(named[1]).map((n) => names[n]);
      }
      if (!out.maxBytes && !out.extensions && !out.contentTypes) return unknown();
      return out;
    }
    case 'item_count': {
      const out = { ...base, arrays: [...new Set(fields.map((f) => f.split('[].')[0]))] };
      if (/\bexactly one\b/.test(description)) Object.assign(out, { min: 1, max: 1 });
      else if (/^At least one\b|\bat least one\b/.test(description)) out.min = 1;
      else if ((m = /^At most (\d+)\b/.exec(description))) out.max = Number(m[1]);
      else return unknown();
      return out;
    }
    default:
      return fail(where, `rule "${rule}" is not implemented`);
  }
}

function lookupFile(schemas, field) {
  const parts = field.split('.');
  for (const schema of schemas) {
    let node = schema;
    for (const part of parts) {
      if (!node) break;
      if (part.endsWith('[]')) node = node.properties?.[part.slice(0, -2)]?.items;
      else node = node.properties?.[part];
    }
    if (node?.file || node?.items?.file) return true;
  }
  return false;
}

// ------------------------------------------------------------------ operations

const METHODS = ['get', 'put', 'post', 'patch', 'delete'];
const operations = {};

for (const [route, item] of Object.entries(spec.paths)) {
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    const id = op.operationId;
    if (!id) fail(`${method.toUpperCase()} ${route}`, 'missing operationId');
    const where = id;

    const params = new Map();
    for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
      const p = raw.$ref ? resolveRef(raw.$ref, where) : raw;
      params.set(`${p.in}:${p.name}`, p);
    }
    const byLocation = (location) =>
      [...params.values()]
        .filter((p) => p.in === location)
        .map((p) => {
          if (!p.schema) fail(where, `parameter ${p.name} has no schema`);
          return { name: p.name, required: Boolean(p.required), schema: convert(p.schema, `${where}.${p.name}`) };
        });

    const entry = {};
    const pathParams = byLocation('path');
    if (pathParams.length) entry.params = nest(pathParams, where);
    const queryParams = byLocation('query');
    if (queryParams.length) entry.query = nest(queryParams, where);

    const body = op.requestBody?.$ref ? resolveRef(op.requestBody.$ref, where) : op.requestBody;
    if (body) {
      for (const type of Object.keys(body.content ?? {})) {
        if (type !== 'application/json' && type !== 'multipart/form-data') {
          fail(where, `unsupported request content type ${type}`);
        }
      }
      if (body.required) entry.bodyRequired = true;
      const json = body.content?.['application/json']?.schema;
      if (json) entry.body = convert(json, `${where}.body`);
      const multipart = body.content?.['multipart/form-data']?.schema;
      if (multipart) {
        const flat = convert(multipart, `${where}.form`);
        const keys = Object.keys(flat).filter((k) => k !== 'type' && k !== 'properties' && k !== 'required');
        if (keys.length) fail(where, `multipart schema keywords ${keys.join(', ')} are not supported`);
        entry.form = nest(
          Object.entries(flat.properties ?? {}).map(([name, schema]) => ({
            name,
            schema,
            required: (flat.required ?? []).includes(name),
          })),
          `${where}.form`,
        );
      }
    }

    const schemas = [entry.params, entry.query, entry.body, entry.form].filter(Boolean);
    const bodyProperties = entry.body?.properties ?? entry.form?.properties;
    const rules = (op['x-hlthstack-rules'] ?? []).map((r, i) =>
      parseRule(r, `${where} x-hlthstack-rules[${i}]`, schemas, bodyProperties),
    );
    if (rules.length) entry.rules = rules;
    operations[id] = entry;
  }
}

const ids = Object.keys(operations);
const output = `// Generated by scripts/build-validation.mjs from openapi/openapi.yaml. Do not edit.
// Run \`npm run generate\` after changing the spec.
import type { OperationValidation } from '../validation.js';

export type ValidatedOperation =
${ids.map((id) => `  | '${id}'`).join('\n')};

export const operations: Record<ValidatedOperation, OperationValidation> = ${JSON.stringify(operations, null, 2)};
`;
writeFileSync(OUT, output);
console.log(`build-validation: wrote ${Object.keys(operations).length} operations to ${OUT}`);
