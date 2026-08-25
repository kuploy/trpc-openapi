import { z } from "zod";

/* ============================================================
   Base helpers
============================================================ */

export const instanceofZodType = (
  type: unknown
): type is z.ZodTypeAny => {
  return !!(type as any)?._zod?.def?.type;
};

export const instanceofZodTypeKind = <
  T extends z.ZodTypeAny,
  K extends string
>(
  type: z.ZodTypeAny,
  kind: K
): type is T => {
  return (type as any)?._zod?.def?.type === kind;
};

/* ============================================================
   Optional / Object
============================================================ */

export const instanceofZodTypeOptional = (
  type: z.ZodTypeAny
): type is z.ZodOptional<z.ZodTypeAny> => {
  return type instanceof z.ZodOptional;
};

export const instanceofZodTypeObject = (
  type: z.ZodTypeAny
): type is z.ZodObject<any> => {
  return type instanceof z.ZodObject;
};

/* ============================================================
   Void-like
============================================================ */

export type ZodTypeLikeVoid =
  | z.ZodVoid
  | z.ZodUndefined
  | z.ZodNever;

export const instanceofZodTypeLikeVoid = (
  type: z.ZodTypeAny
): type is ZodTypeLikeVoid => {
  const t = (type as any)?._zod?.def?.type;
  return t === "void" || t === "undefined" || t === "never";
};

/* ============================================================
   unwrapZodType
============================================================ */

export const unwrapZodType = (
  type: z.ZodTypeAny,
  unwrapPreprocess: boolean
): z.ZodTypeAny => {
  const def = (type as any)?._zod?.def;
  if (!def) return type;

  switch (def.type) {
    case "optional":
      return unwrapZodType(def.innerType, unwrapPreprocess);

    case "default":
      return unwrapZodType(def.innerType, unwrapPreprocess);

    /*
     * Transparent wrappers Zod 4 introduces or renames. `.required()` produces
     * a "nonoptional" node, which is why an ordinary z.string().min(1) stopped
     * unwrapping to a string the moment a schema used .pick().required() — it
     * took out every apiFindOne* in kuploy. The other three have the same
     * innerType shape and would have failed the same way.
     */
    case "nonoptional":
    case "nullable":
    case "readonly":
    case "catch":
      return unwrapZodType(def.innerType, unwrapPreprocess);

    case "lazy":
      return unwrapZodType(def.getter(), unwrapPreprocess);

    /*
     * Zod 4 folds .transform() and .preprocess() into one node, ZodPipe, whose
     * def carries `in`/`out` — there is no `def.schema`, so the previous branch
     * silently unwrapped to undefined and every transformed or preprocessed
     * query parameter was rejected as non-coercible.
     *
     * The two are told apart by which side holds the transform:
     *   z.string().transform(fn)    in = string,    out = transform
     *   z.preprocess(fn, z.string()) in = transform, out = string
     *
     * For a transform the source type is `in` — that is what a request must
     * actually supply. For a preprocess it is `out`, and only when the caller
     * asked to see through it, matching the old unwrapPreprocess contract.
     */
    case "transform":
    case "pipe": {
      const isPreprocess = (def.in as any)?._zod?.def?.type === "transform";
      if (isPreprocess) {
        return unwrapPreprocess ? unwrapZodType(def.out, unwrapPreprocess) : type;
      }
      return unwrapZodType(def.in, unwrapPreprocess);
    }

    default:
      return type;
  }
};

/* ============================================================
   ZodTypeLikeString
============================================================ */

type NativeEnumType = {
  [k: string]: string | number;
  [nu: number]: string;
};

export type ZodTypeLikeString =
  | z.ZodString
  | z.ZodOptional<any>
  | z.ZodDefault<any>
  | z.ZodUnion<any>
  | z.ZodIntersection<any, any>
  | z.ZodLazy<any>
  | z.ZodLiteral<string>
  | z.ZodEnum<any>
  | z.ZodEnum<NativeEnumType>;

export const instanceofZodTypeLikeString = (
  _type: z.ZodTypeAny
): _type is ZodTypeLikeString => {
  const type = unwrapZodType(_type, false);
  const def = (type as any)?._zod?.def;
  if (!def) return false;

  switch (def.type) {
    case "string":
      return true;

    /*
     * Zod 4 shapes. A literal carries `values` (an array), not `value`, so the
     * old `typeof def.value === "string"` was always false. And Zod 4 folds
     * native enums into "enum", which made the "nativeEnum" branch below dead
     * and left `case "enum": return true` accepting numeric enums it was
     * written to reject — a TS numeric enum's entries hold both directions,
     * {"0":"James","James":0}, so checking every value is a string rejects it.
     */
    case "literal":
      return (
        Array.isArray(def.values) &&
        def.values.length > 0 &&
        def.values.every((v: unknown) => typeof v === "string")
      );

    case "enum": {
      const values = Object.values(def.entries ?? {});
      return values.length > 0 && values.every((v) => typeof v === "string");
    }

    case "union":
      return def.options.every((option: any) =>
        instanceofZodTypeLikeString(option)
      );

    case "intersection":
      return (
        instanceofZodTypeLikeString(def.left) &&
        instanceofZodTypeLikeString(def.right)
      );

    /*
     * Zod 3 made z.preprocess() a ZodEffects and this check returned true for
     * any of them: a preprocess IS the caller taking responsibility for turning
     * the raw query string into the inner type, so the inner type is not ours
     * to police. Zod 4 emits a ZodPipe instead, so the "preprocess" case above
     * became unreachable and every preprocessed query parameter started being
     * rejected as "must be ZodString".
     *
     * unwrapZodType(_, false) leaves a preprocess wrapped and unwraps a plain
     * transform to its `in`, so a "pipe" surviving to here is a preprocess.
     */
    case "pipe":
      return true;

    default:
      return false;
  }
};

/* ============================================================
   Coercible
============================================================ */

export const zodSupportsCoerce = "coerce" in z;

export type ZodTypeCoercible =
  | z.ZodNumber
  | z.ZodBoolean
  | z.ZodBigInt
  | z.ZodDate;

export const instanceofZodTypeCoercible = (
  _type: z.ZodTypeAny
): _type is ZodTypeCoercible => {
  const type = unwrapZodType(_type, false);
  const def = (type as any)?._zod?.def?.type;

  /*
   * "string" was missing, though the error raised on failure says the key
   * "must be ZodString, ZodNumber, ZodBoolean, ZodBigInt or ZodDate". A plain
   * z.string() query parameter was rejected whenever coercion was enabled.
   */
  if (
    def === "string" ||
    def === "number" ||
    def === "boolean" ||
    def === "bigint" ||
    def === "date"
  ) {
    return true;
  }

  /*
   * Anything that reduces to a string is coercible too: a string-valued
   * literal or enum, and unions/intersections of those. `?status=active`
   * against z.enum(["active","idle"]) is ordinary REST, and rejecting it
   * aborted generation of the WHOLE document rather than one route.
   *
   * Delegating keeps one definition of "string-like" instead of two that can
   * drift. Numeric members stay rejected — z.literal(5) really would need
   * coercing, and passing the raw "5" through would fail at request time.
   */
  return instanceofZodTypeLikeString(type);
};