import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import * as schemas from '../src/schemas.ts';
import * as graph from '../src/graph.ts';
import * as api from '../src/api.ts';
import * as events from '../src/events.ts';
import * as models from '../src/models.ts';
import * as agent from '../src/agent.ts';
import * as sidebar from '../src/sidebar.ts';

const MAX_WRAPPER_DEPTH = 20;
const MAX_SCHEMA_DEPTH = 20;
const EXPECTED_MODULES_WITH_SCHEMAS = new Set(['schemas', 'graph']);
const KNOWN_WRAPPER_TYPE_NAMES = new Set([
  'ZodDefault',
  'ZodEffects',
  'ZodNullable',
  'ZodOptional',
  'ZodReadonly',
]);
const KNOWN_TERMINAL_TYPE_NAMES = new Set([
  'ZodArray',
  'ZodBoolean',
  'ZodDiscriminatedUnion',
  'ZodEnum',
  'ZodIntersection',
  'ZodLiteral',
  'ZodMap',
  'ZodNever',
  'ZodNumber',
  'ZodObject',
  'ZodRecord',
  'ZodSet',
  'ZodString',
  'ZodTuple',
  'ZodUnion',
]);

// A typeName present in both sets would be classified as terminal before the
// wrapper branch runs, silently skipping its inner schema — the one list
// mismatch the fail-closed throws below cannot catch.
{
  const overlap = [...KNOWN_WRAPPER_TYPE_NAMES].filter(
    (typeName) => KNOWN_TERMINAL_TYPE_NAMES.has(typeName),
  );
  assert.equal(
    overlap.length,
    0,
    `wrapper and terminal type-name lists must be disjoint: ${overlap.join(', ')}`,
  );
}

function schemaTypeName(schema: z.ZodTypeAny): string {
  return schema._def.typeName;
}

function unwrapSchema(schema: z.ZodTypeAny, exportPath: string): z.ZodTypeAny {
  let current = schema;
  for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth += 1) {
    const typeName = schemaTypeName(current);
    if (KNOWN_TERMINAL_TYPE_NAMES.has(typeName)) return current;
    if (!KNOWN_WRAPPER_TYPE_NAMES.has(typeName)) {
      throw new Error(`${exportPath}: unsupported Zod schema type ${typeName}`);
    }
    if (current instanceof z.ZodEffects) {
      current = current._def.schema;
      continue;
    }
    if (
      current instanceof z.ZodOptional
      || current instanceof z.ZodNullable
      || current instanceof z.ZodDefault
      || current instanceof z.ZodReadonly
    ) {
      current = current._def.innerType;
      continue;
    }
    throw new Error(`${exportPath}: cannot unwrap known Zod wrapper ${typeName}`);
  }
  throw new Error(`${exportPath} exceeds the ${MAX_WRAPPER_DEPTH}-layer schema wrapper limit`);
}

interface ScanState {
  moduleName: string;
  objectSchemas: string[];
  modulesWithSchemas: Set<string>;
  violations: string[];
  seen: Set<z.ZodTypeAny>;
}

function scanSchema(
  wrappedSchema: z.ZodTypeAny,
  schemaPath: string,
  state: ScanState,
  depth = 0,
): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new Error(`${schemaPath} exceeds the ${MAX_SCHEMA_DEPTH}-layer schema traversal limit`);
  }

  const schema = unwrapSchema(wrappedSchema, schemaPath);
  if (state.seen.has(schema)) return;
  state.seen.add(schema);

  if (schema instanceof z.ZodObject) {
    state.objectSchemas.push(schemaPath);
    state.modulesWithSchemas.add(state.moduleName);
    // unknownKeys is only consulted when catchall is ZodNever; a .catchall()
    // schema accepts unknown keys while still reporting unknownKeys='strict',
    // so both must be checked to guarantee strict runtime semantics.
    const catchall: z.ZodTypeAny | undefined = schema._def.catchall;
    if (schema._def.unknownKeys !== 'strict' || !(catchall instanceof z.ZodNever)) {
      state.violations.push(
        `${schemaPath}: unknownKeys=${schema._def.unknownKeys}`
        + ` catchall=${catchall?._def?.typeName ?? 'undefined'}`,
      );
    }
    const shape: z.ZodRawShape = schema._def.shape();
    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      scanSchema(fieldSchema, `${schemaPath}.${fieldName}`, state, depth + 1);
    }
    scanSchema(schema._def.catchall, `${schemaPath}.*`, state, depth + 1);
    return;
  }
  if (schema instanceof z.ZodArray) {
    scanSchema(schema._def.type, `${schemaPath}[]`, state, depth + 1);
    return;
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    for (const [index, option] of schema._def.options.entries()) {
      scanSchema(option, `${schemaPath}<option:${index}>`, state, depth + 1);
    }
    return;
  }
  if (schema instanceof z.ZodUnion) {
    for (const [index, option] of schema._def.options.entries()) {
      scanSchema(option, `${schemaPath}<option:${index}>`, state, depth + 1);
    }
    return;
  }
  if (schema instanceof z.ZodRecord) {
    scanSchema(schema._def.valueType, `${schemaPath}{value}`, state, depth + 1);
    return;
  }
  if (schema instanceof z.ZodTuple) {
    for (const [index, item] of schema._def.items.entries()) {
      scanSchema(item, `${schemaPath}[${index}]`, state, depth + 1);
    }
    if (schema._def.rest) {
      scanSchema(schema._def.rest, `${schemaPath}[...]`, state, depth + 1);
    }
    return;
  }
  if (schema instanceof z.ZodIntersection) {
    scanSchema(schema._def.left, `${schemaPath}<left>`, state, depth + 1);
    scanSchema(schema._def.right, `${schemaPath}<right>`, state, depth + 1);
    return;
  }
  if (schema instanceof z.ZodMap) {
    scanSchema(schema._def.keyType, `${schemaPath}{key}`, state, depth + 1);
    scanSchema(schema._def.valueType, `${schemaPath}{value}`, state, depth + 1);
    return;
  }
  if (schema instanceof z.ZodSet) {
    scanSchema(schema._def.valueType, `${schemaPath}{value}`, state, depth + 1);
    return;
  }
  if (
    schema instanceof z.ZodBoolean
    || schema instanceof z.ZodEnum
    || schema instanceof z.ZodLiteral
    || schema instanceof z.ZodNever
    || schema instanceof z.ZodNumber
    || schema instanceof z.ZodString
  ) {
    return;
  }

  throw new Error(`${schemaPath}: no traversal handler for Zod schema type ${schemaTypeName(schema)}`);
}

const SCANNED_MODULES = { schemas, graph, api, events, models, agent, sidebar };

// Modules asserted (by hand) to export no runtime zod values. A new src module
// must land in exactly one of the two groups; the classification test below
// fails otherwise. 'index' cannot join SCANNED_MODULES: its './*.js' re-export
// specifiers do not resolve under bare-Node type stripping.
const MODULES_WITHOUT_RUNTIME_SCHEMAS = new Set([
  'agent-ids',
  'chapter-label',
  'index',
  'prompts',
  'word-count',
]);

test('every contract src module is classified for the strict-policy scan', () => {
  const srcModuleNames = readdirSync(new URL('../src/', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name.replace(/\.ts$/, ''));
  assert.ok(srcModuleNames.length > 0, 'src module discovery must find modules');

  const scanned = new Set(Object.keys(SCANNED_MODULES));
  for (const moduleName of srcModuleNames) {
    const isScanned = scanned.has(moduleName);
    const isExempt = MODULES_WITHOUT_RUNTIME_SCHEMAS.has(moduleName);
    assert.ok(
      isScanned || isExempt,
      `src/${moduleName}.ts is unclassified: import it into SCANNED_MODULES`
      + ' or, if it has no runtime zod exports, add it to MODULES_WITHOUT_RUNTIME_SCHEMAS',
    );
    assert.ok(
      !(isScanned && isExempt),
      `src/${moduleName}.ts is listed both as scanned and as schema-free`,
    );
  }
});

test('every object schema reachable from runtime exports uses the strict unknown-key policy', () => {
  const modules = SCANNED_MODULES;
  const objectSchemas: string[] = [];
  const modulesWithSchemas = new Set<string>();
  const violations: string[] = [];

  for (const [moduleName, moduleExports] of Object.entries(modules)) {
    for (const [exportName, value] of Object.entries(moduleExports)) {
      if (!(value instanceof z.ZodType)) continue;
      const exportPath = `${moduleName}.${exportName}`;
      scanSchema(value, exportPath, {
        moduleName,
        objectSchemas,
        modulesWithSchemas,
        violations,
        seen: new Set(),
      });
    }
  }

  assert.ok(objectSchemas.length > 0, 'strict-policy scan must discover object schemas');
  assert.deepEqual(
    [...modulesWithSchemas].sort(),
    [...EXPECTED_MODULES_WITH_SCHEMAS].sort(),
    'modules with runtime object schemas changed; update EXPECTED_MODULES_WITH_SCHEMAS when intentional',
  );
  assert.equal(
    violations.length,
    0,
    `object schemas reachable from runtime exports must use .strict():\n${violations.join('\n')}`,
  );
});
