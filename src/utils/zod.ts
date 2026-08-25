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

    case "literal":
      return typeof def.value === "string";

    case "enum":
      return true;

    case "nativeEnum":
      return !Object.values(def.values).some(
        (value) => typeof value === "number"
      );

    case "union":
      return def.options.every((option: any) =>
        instanceofZodTypeLikeString(option)
      );

    case "intersection":
      return (
        instanceofZodTypeLikeString(def.left) &&
        instanceofZodTypeLikeString(def.right)
      );

    case "preprocess":
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
  return (
    def === "string" ||
    def === "number" ||
    def === "boolean" ||
    def === "bigint" ||
    def === "date"
  );
};