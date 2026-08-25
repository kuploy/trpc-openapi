// @ts-nocheck
import { TRPCError } from "@trpc/server";
import { OpenAPIV3 } from "openapi-types";
import { z } from "zod";

import { OpenApiContentType } from "../types";
import {
	instanceofZodType,
	instanceofZodTypeCoercible,
	instanceofZodTypeLikeString,
	instanceofZodTypeLikeVoid,
	instanceofZodTypeObject,
	instanceofZodTypeOptional,
	unwrapZodType,
	zodSupportsCoerce,
} from "../utils/zod";

const zodSchemaToOpenApiSchemaObject = (
	zodSchema: z.ZodType,
): OpenAPIV3.SchemaObject => {
	/*
	 * Zod 4's own converter, not the zod-to-json-schema package.
	 *
	 * That package is a Zod 3 library. Handed a Zod 4 schema it does not throw —
	 * it returns `{"$schema": "...draft-07..."}` and nothing else, so every
	 * parameter and body in the generated document came out as `schema: {}`.
	 * A structurally valid OpenAPI document describing nothing is worse than a
	 * failure, because nothing surfaces it.
	 *
	 * Option mapping from the old call: `target: "openApi3"` -> "openapi-3.0"
	 * (both drop the $schema key), and `$refStrategy: "none"` -> `reused:
	 * "inline"` (both inline a shared subschema instead of emitting a $ref).
	 * `unrepresentable: "any"` keeps the old library's permissiveness: Zod 4
	 * throws by default on types with no JSON Schema form, and this generator
	 * feeds it z.void() for parameterless procedures.
	 */
	return z.toJSONSchema(zodSchema, {
		target: "openapi-3.0",
		reused: "inline",
		unrepresentable: "any",
	}) as any;
};

export const getParameterObjects = (
	currentSchema: unknown,
	pathParameters: string[],
	inType: "all" | "path" | "query",
	example: Record<string, any> | undefined,
): OpenAPIV3.ParameterObject[] | undefined => {
	// Same rule as getRequestBodyObject: a missing parser is fine (every
	// procedure is exposed by default here, so argument-less queries are
	// normal), a present-but-non-Zod one cannot be documented.
	if (currentSchema !== undefined && !instanceofZodType(currentSchema)) {
		throw new TRPCError({
			message: "Input parser expects a Zod validator",
			code: "INTERNAL_SERVER_ERROR",
		});
	}

	const schema = currentSchema || z.void();
	const isRequired = !schema.isOptional();
	const unwrappedSchema = unwrapZodType(schema, true);

	if (
		pathParameters.length === 0 &&
		instanceofZodTypeLikeVoid(unwrappedSchema)
	) {
		return undefined;
	}

	if (!instanceofZodTypeObject(unwrappedSchema)) {
		throw new TRPCError({
			message: "Input parser must be a ZodObject",
			code: "INTERNAL_SERVER_ERROR",
		});
	}

	const shape = unwrappedSchema.shape;
	const shapeKeys = Object.keys(shape);

	for (const pathParameter of pathParameters) {
		if (!shapeKeys.includes(pathParameter)) {
			throw new TRPCError({
				message: `Input parser expects key from path: "${pathParameter}"`,
				code: "INTERNAL_SERVER_ERROR",
			});
		}
	}

	return shapeKeys
		.filter((shapeKey) => {
			const isPathParameter = pathParameters.includes(shapeKey);
			if (inType === "path") {
				return isPathParameter;
			} else if (inType === "query") {
				return !isPathParameter;
			}
			return true;
		})
		.map((shapeKey) => {
			let shapeSchema = shape[shapeKey]!;
			const isShapeRequired = !shapeSchema.isOptional();
			const isPathParameter = pathParameters.includes(shapeKey);

			if (!instanceofZodTypeLikeString(shapeSchema)) {
				if (zodSupportsCoerce) {
					if (!instanceofZodTypeCoercible(shapeSchema)) {
						throw new TRPCError({
							message: `Input parser key: "${shapeKey}" must be ZodString, ZodNumber, ZodBoolean, ZodBigInt or ZodDate`,
							code: "INTERNAL_SERVER_ERROR",
						});
					}
				} else {
					throw new TRPCError({
						message: `Input parser key: "${shapeKey}" must be ZodString`,
						code: "INTERNAL_SERVER_ERROR",
					});
				}
			}

			if (instanceofZodTypeOptional(shapeSchema)) {
				if (isPathParameter) {
					throw new TRPCError({
						message: `Path parameter: "${shapeKey}" must not be optional`,
						code: "INTERNAL_SERVER_ERROR",
					});
				}
				shapeSchema = unwrapZodType(shapeSchema, false);
			}

			const { description, ...openApiSchemaObject } =
				zodSchemaToOpenApiSchemaObject(shapeSchema);

			return {
				name: shapeKey,
				in: isPathParameter ? "path" : "query",
				required: isPathParameter || (isRequired && isShapeRequired),
				schema: openApiSchemaObject,
				description: description,
				example: example?.[shapeKey],
			};
		});
};

export const getRequestBodyObject = (
	currentSchema: unknown,
	pathParameters: string[],
	contentTypes: OpenApiContentType[],
	example: Record<string, any> | undefined,
): OpenAPIV3.RequestBodyObject | undefined => {
	/*
	 * A parser that exists but is not Zod cannot be turned into a schema, and
	 * emitting the route anyway is exactly the failure this package just spent
	 * a release fixing: a document that looks valid and describes nothing.
	 *
	 * Tested against `currentSchema`, not the fallback below. `undefined` means
	 * the procedure simply has no parser, which is normal here — this fork
	 * exposes every procedure by default, so argument-less queries are common
	 * and must keep generating. Only a present-but-non-Zod parser is an error.
	 *
	 * This guard was commented out rather than removed, because as written it
	 * referenced `schema` above its own declaration and would not compile.
	 */
	if (currentSchema !== undefined && !instanceofZodType(currentSchema)) {
		throw new TRPCError({
			message: "Input parser expects a Zod validator",
			code: "INTERNAL_SERVER_ERROR",
		});
	}

	const schema = currentSchema || z.void();

	const isRequired = !schema.isOptional();
	const unwrappedSchema = unwrapZodType(schema, true);

	if (
		pathParameters.length === 0 &&
		instanceofZodTypeLikeVoid(unwrappedSchema)
	) {
		return undefined;
	}

	if (!instanceofZodTypeObject(unwrappedSchema)) {
		throw new TRPCError({
			message: "Input parser must be a ZodObject",
			code: "INTERNAL_SERVER_ERROR",
		});
	}

	// remove path parameters
	const mask: Record<string, true> = {};
	const dedupedExample = example && { ...example };
	pathParameters.forEach((pathParameter) => {
		mask[pathParameter] = true;
		if (dedupedExample) {
			delete dedupedExample[pathParameter];
		}
	});
	/*
	 * Rebuilt from the shape rather than unwrappedSchema.omit(mask): Zod 4
	 * throws ".omit() cannot be used on object schemas containing refinements",
	 * so any procedure whose input object carries a .refine()/.superRefine()
	 * AND has path parameters could not generate at all.
	 *
	 * Dropping the refinement here is correct rather than merely expedient — a
	 * refinement is arbitrary code and has no JSON Schema representation, so it
	 * was never going to appear in the document. Only the shape matters, and
	 * the refinement still runs at request time where it belongs.
	 */
	const dedupedSchema = z.object(
		Object.fromEntries(
			Object.entries(unwrappedSchema.shape).filter(([key]) => !mask[key]),
		) as z.ZodRawShape,
	);

	// if all keys are path parameters
	if (
		pathParameters.length > 0 &&
		Object.keys(dedupedSchema.shape).length === 0
	) {
		return undefined;
	}

	const openApiSchemaObject = zodSchemaToOpenApiSchemaObject(dedupedSchema);
	const content: OpenAPIV3.RequestBodyObject["content"] = {};
	for (const contentType of contentTypes) {
		content[contentType] = {
			schema: openApiSchemaObject,
			example: dedupedExample,
		};
	}

	return {
		required: isRequired,
		content,
	};
};
export const errorResponseObject: OpenAPIV3.ResponseObject = {
	description: "Error response",
	content: {
		"application/json": {
			schema: zodSchemaToOpenApiSchemaObject(
				z.object({
					message: z.string(),
					code: z.string(),
					issues: z.array(z.object({ message: z.string() })).optional(),
				}),
			),
		},
	},
};

export const getResponsesObject = (
	schema: unknown,
	example: Record<string, any> | undefined,
	headers:
		| Record<string, OpenAPIV3.HeaderObject | OpenAPIV3.ReferenceObject>
		| undefined,
): OpenAPIV3.ResponsesObject => {
	// Mirrors the input guard. Without it a non-Zod output parser reached the
	// converter and failed with "Cannot read properties of undefined (reading
	// 'def')", which says nothing about the actual mistake.
	if (schema !== undefined && !instanceofZodType(schema)) {
		throw new TRPCError({
			message: "Output parser expects a Zod validator",
			code: "INTERNAL_SERVER_ERROR",
		});
	}

	const successResponseObject: OpenAPIV3.ResponseObject = {
		description: "Successful response",
		headers: headers,
		content: {
			"application/json": {
				...(schema && {
					schema: zodSchemaToOpenApiSchemaObject(schema),
				}),
				example,
			},
		},
	};

	return {
		200: successResponseObject,
		default: {
			$ref: "#/components/responses/error",
		},
	};
};
