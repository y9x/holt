// shield opcodes + per-build polymorphic layout.
//
// This module is intentionally written in "erasable" TypeScript (no `enum`,
// no parameter properties, no `namespace`) so Node's built-in type stripping
// can load it directly from a plain `.mjs` test file, and so Vite can bundle it
// for the browser runtime without extra tooling.
//
// Opcodes are referenced BY NAME everywhere in the compiler and runtime. The
// numeric byte each name is assigned is decided per build from a seed
// (`buildLayout`), so the same logical operation maps to a different byte in
// every build. The runtime builds its dispatch table from the same layout.

export type OpName =
  // stack / constants
  | 'HALT' | 'NOP' | 'POP' | 'DUP' | 'DUP2' | 'SWAP' | 'ROTL3'
  | 'PUSH_CONST' | 'PUSH_UNDEF' | 'PUSH_NULL' | 'PUSH_TRUE' | 'PUSH_FALSE' | 'PUSH_THIS'
  // variables (name-based: globals/free vars + legacy)
  | 'LOAD_VAR' | 'STORE_VAR' | 'INIT_VAR'
  | 'DECLARE_VAR' | 'DECLARE_LET' | 'DECLARE_CONST' | 'DEF_FUNC'
  | 'TYPEOF_VAR' | 'LOAD_ARG' | 'LOAD_ARGS_FROM'
  // variables (slot-based: lexical locals resolved to (depth,index) at compile
  // time; the operand packs depth<<16 | index). DECLARE_SLOT/DEF_FUNC_SLOT pack
  // index<<2 | kind (0=var,1=let,2=const). *_GLOBAL go straight to `globals`.
  | 'LOAD_SLOT' | 'STORE_SLOT' | 'INIT_SLOT' | 'TYPEOF_SLOT'
  | 'DECLARE_SLOT' | 'DEF_FUNC_SLOT'
  | 'LOAD_GLOBAL' | 'STORE_GLOBAL' | 'TYPEOF_GLOBAL'
  | 'IMPORT_SLOT'
  // superinstructions (PLAN 5.11: fuse hot opcode bigrams/trigrams to cut both
  // dispatch overhead AND step count). Operand is a const-pool tuple so the
  // single-operand dispatch is unchanged.
  //   BIND_PARAM:        operand packs slot<<8 | argIndex (simple param bind)
  //   LOAD_SLOT_PROP:    const [addr, key]        - ident.prop
  //   LOAD_GLOBAL_PROP:  const [name, key]        - GLOBAL.prop
  //   LOAD_SLOT_DUP_PROP:const [addr, key]        - ident.method() receiver
  | 'BIND_PARAM' | 'LOAD_SLOT_PROP' | 'LOAD_GLOBAL_PROP'
  | 'LOAD_SLOT_DUP_PROP' | 'LOAD_GLOBAL_DUP_PROP'
  //   OBJ_SET_CONST:     const [key, valueConstIdx] - {key: <literal>} builder
  //   DECLARE_SLOTS:     const [startIndex, count, kind] - bulk TDZ declare run
  | 'OBJ_SET_CONST' | 'DECLARE_SLOTS'
  // scopes
  | 'ENTER_SCOPE' | 'EXIT_SCOPE'
  // arithmetic / unary / binary
  | 'ADD' | 'SUB' | 'MUL' | 'DIV' | 'MOD' | 'EXP'
  | 'EQ' | 'NEQ' | 'SEQ' | 'SNEQ' | 'LT' | 'LTE' | 'GT' | 'GTE'
  | 'BAND' | 'BOR' | 'BXOR' | 'SHL' | 'SHR' | 'USHR'
  | 'NOT' | 'NEG' | 'POS' | 'BNOT'
  | 'TYPEOF' | 'INSTANCEOF' | 'IN'
  // properties
  | 'GET_PROP' | 'GET_PROP_DYN' | 'SET_PROP' | 'SET_PROP_DYN'
  | 'DELETE_PROP' | 'DELETE_PROP_DYN'
  // control flow
  | 'JMP' | 'JMP_IF_FALSE' | 'JMP_IF_TRUE'
  | 'JMP_IF_FALSY_KEEP' | 'JMP_IF_TRUTHY_KEEP' | 'JMP_IF_NOT_NULLISH_KEEP'
  | 'OPT_SHORT' | 'OPT_SHORT_CALL'
  // calls / functions
  | 'CALL' | 'CALL_METHOD' | 'NEW'
  | 'CALL_APPLY' | 'CALL_METHOD_APPLY' | 'NEW_APPLY'
  | 'MAKE_FUNC' | 'RETURN' | 'RETURN_UNDEF'
  // arrays / objects
  | 'ARR_EMPTY' | 'ARR_APPEND' | 'ARR_SPREAD'
  | 'OBJ_EMPTY' | 'OBJ_SET' | 'OBJ_SET_DYN' | 'OBJ_SPREAD'
  | 'OBJ_DEFINE_GETTER' | 'OBJ_DEFINE_SETTER' | 'OBJ_REST' | 'OBJ_REST_DYN'
  // iteration
  | 'GET_ITERATOR' | 'FOR_ITER' | 'ITER_NEXT_PUSH' | 'ITER_REST_PUSH' | 'FOR_IN_KEYS'
  // exceptions
  | 'THROW' | 'RETHROW' | 'PUSH_HANDLER' | 'PUSH_FINALLY' | 'POP_HANDLER'
  | 'PUSH_COMPLETION_NORMAL' | 'END_FINALLY'
  // break/continue that crosses a finally: route the jump through the crossed
  // finally handlers (operand = const {target, stop}) then land at a trampoline.
  | 'ABRUPT_JUMP'
  // async
  | 'AWAIT'
  // classes
  | 'BUILD_CLASS' | 'LOAD_NEW_TARGET'
  | 'SUPER_GET' | 'SUPER_GET_DYN' | 'SUPER_SET' | 'SUPER_SET_DYN'
  | 'SUPER_CALL' | 'SUPER_CALL_APPLY'
  | 'GET_PRIVATE' | 'SET_PRIVATE' | 'HAS_PRIVATE' | 'INIT_PRIVATE'
  // ES modules (whole-chunk loader, PLAN 5.5)
  | 'MODULE_INIT' | 'IMPORT_BINDING' | 'EXPORT_BINDING'
  | 'DYNAMIC_IMPORT' | 'IMPORT_META' | 'AWAIT_TOP'
  // top-level completion value (eval-style)
  | 'SET_COMPLETION'

// Operand arity (how many numbers follow the opcode byte in the flat code
// array). Jump/const/name/index operands are a single number each.
export const ARITY: Record<OpName, number> = {
  HALT: 0, NOP: 0, POP: 0, DUP: 0, DUP2: 0, SWAP: 0, ROTL3: 0,
  PUSH_CONST: 1, PUSH_UNDEF: 0, PUSH_NULL: 0, PUSH_TRUE: 0, PUSH_FALSE: 0, PUSH_THIS: 0,
  LOAD_VAR: 1, STORE_VAR: 1, INIT_VAR: 1,
  DECLARE_VAR: 1, DECLARE_LET: 1, DECLARE_CONST: 1, DEF_FUNC: 1,
  TYPEOF_VAR: 1, LOAD_ARG: 1, LOAD_ARGS_FROM: 1,
  LOAD_SLOT: 1, STORE_SLOT: 1, INIT_SLOT: 1, TYPEOF_SLOT: 1,
  DECLARE_SLOT: 1, DEF_FUNC_SLOT: 1,
  LOAD_GLOBAL: 1, STORE_GLOBAL: 1, TYPEOF_GLOBAL: 1,
  IMPORT_SLOT: 1,
  BIND_PARAM: 1, LOAD_SLOT_PROP: 1, LOAD_GLOBAL_PROP: 1,
  LOAD_SLOT_DUP_PROP: 1, LOAD_GLOBAL_DUP_PROP: 1,
  OBJ_SET_CONST: 1, DECLARE_SLOTS: 1,
  ENTER_SCOPE: 0, EXIT_SCOPE: 0,
  ADD: 0, SUB: 0, MUL: 0, DIV: 0, MOD: 0, EXP: 0,
  EQ: 0, NEQ: 0, SEQ: 0, SNEQ: 0, LT: 0, LTE: 0, GT: 0, GTE: 0,
  BAND: 0, BOR: 0, BXOR: 0, SHL: 0, SHR: 0, USHR: 0,
  NOT: 0, NEG: 0, POS: 0, BNOT: 0,
  TYPEOF: 0, INSTANCEOF: 0, IN: 0,
  GET_PROP: 1, GET_PROP_DYN: 0, SET_PROP: 1, SET_PROP_DYN: 0,
  DELETE_PROP: 1, DELETE_PROP_DYN: 0,
  JMP: 1, JMP_IF_FALSE: 1, JMP_IF_TRUE: 1,
  JMP_IF_FALSY_KEEP: 1, JMP_IF_TRUTHY_KEEP: 1, JMP_IF_NOT_NULLISH_KEEP: 1,
  OPT_SHORT: 1, OPT_SHORT_CALL: 1,
  CALL: 1, CALL_METHOD: 1, NEW: 1,
  CALL_APPLY: 0, CALL_METHOD_APPLY: 0, NEW_APPLY: 0,
  MAKE_FUNC: 1, RETURN: 0, RETURN_UNDEF: 0,
  ARR_EMPTY: 0, ARR_APPEND: 0, ARR_SPREAD: 0,
  OBJ_EMPTY: 0, OBJ_SET: 1, OBJ_SET_DYN: 0, OBJ_SPREAD: 0,
  OBJ_DEFINE_GETTER: 1, OBJ_DEFINE_SETTER: 1, OBJ_REST: 1, OBJ_REST_DYN: 0,
  GET_ITERATOR: 0, FOR_ITER: 1, ITER_NEXT_PUSH: 0, ITER_REST_PUSH: 0, FOR_IN_KEYS: 0,
  THROW: 0, RETHROW: 0, PUSH_HANDLER: 1, PUSH_FINALLY: 1, POP_HANDLER: 0,
  PUSH_COMPLETION_NORMAL: 0, END_FINALLY: 1,
  ABRUPT_JUMP: 1,
  AWAIT: 0,
  BUILD_CLASS: 1, LOAD_NEW_TARGET: 0,
  SUPER_GET: 1, SUPER_GET_DYN: 0, SUPER_SET: 1, SUPER_SET_DYN: 0,
  SUPER_CALL: 1, SUPER_CALL_APPLY: 0,
  GET_PRIVATE: 1, SET_PRIVATE: 1, HAS_PRIVATE: 1, INIT_PRIVATE: 1,
  MODULE_INIT: 1, IMPORT_BINDING: 1, EXPORT_BINDING: 1,
  DYNAMIC_IMPORT: 0, IMPORT_META: 0, AWAIT_TOP: 0,
  SET_COMPLETION: 0,
}

export const OP_NAMES: OpName[] = Object.keys(ARITY) as OpName[]

// Deterministic PRNG (mulberry32). Same seed => same stream in Node and browser.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Stable string hash -> 32-bit int, so a seed may be a string or number.
export function hashSeed(seed: string | number): number {
  const s = String(seed)
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export interface OpcodeLayout {
  version: number
  tableSize: number
  // name -> byte value used in the compiled code stream
  byteOf: Record<string, number>
  // byte value -> name (sparse; trap slots are absent)
  nameOf: Record<number, OpName>
}

// Build a per-build polymorphic layout: every opcode gets a distinct random
// byte in a 256-slot table. The remaining slots are trap slots (the runtime
// fills them with a wipe-and-throw handler). This implements "per-build opcode
// byte assignment + handler slot layout" from PLAN 5.4.
//
// NOTE (honesty): this implements per-BUILD polymorphism (one mapping per
// build). The stronger "several byte variants per logical op chosen per
// emission" form described in 5.4 is NOT implemented; see README.
export function buildLayout(seed: string | number): OpcodeLayout {
  const tableSize = 256
  if (OP_NAMES.length > tableSize) throw new Error('too many opcodes for table size')
  const rng = mulberry32(hashSeed(seed))
  const slots: number[] = []
  for (let i = 0; i < tableSize; i++) slots.push(i)
  // Fisher-Yates shuffle of the slot pool.
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = slots[i]; slots[i] = slots[j]; slots[j] = tmp
  }
  const byteOf: Record<string, number> = {}
  const nameOf: Record<number, OpName> = {}
  OP_NAMES.forEach((name, idx) => {
    const byte = slots[idx]
    byteOf[name] = byte
    nameOf[byte] = name
  })
  return { version: 1, tableSize, byteOf, nameOf }
}
