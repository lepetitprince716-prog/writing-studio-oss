import type { z } from 'zod';

// Mutual `extends` is not enough: structural assignability ignores a wholly
// absent optional property, so it passes even when one side is missing an
// optional field the other declares. This identity check compares the types
// themselves rather than their assignability, which catches optional drift at
// every depth including nested objects and union members.
//
// It compares static output types only. Zod's runtime key policy (strip vs
// strict vs passthrough) does not change the output type of a plain object
// schema, so a missing `.strict()` is invisible here.
type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

export type SchemaMatches<TSchema extends z.ZodTypeAny, TContract> =
  Equals<z.output<TSchema>, TContract> extends true
    ? true
    // Equals remains the only verdict. These key sets are diagnostic-only:
    // they are incomplete for nested/value drift, where the marker still
    // makes the mismatch explicit even when both sets are `never`.
    : {
        mismatch: 'schema output and contract differ';
        schemaOnly: Exclude<keyof z.output<TSchema>, keyof TContract>;
        contractOnly: Exclude<keyof TContract, keyof z.output<TSchema>>;
      };

export type AssertSchemaMatch<T extends true> = T;
