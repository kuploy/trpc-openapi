// @ts-nocheck
import { type AnyProcedure, TRPCError } from "@trpc/server";
import type {
	NodeHTTPHandlerOptions,
	NodeHTTPRequest,
	NodeHTTPResponse,
} from "@trpc/server/dist/adapters/node-http";
import cloneDeep from "lodash.clonedeep";
import { z } from "zod";
import type { ZodError } from "zod";

import { generateOpenApiDocument } from "../../generator";
import type {
	OpenApiErrorResponse,
	OpenApiMethod,
	OpenApiResponse,
	OpenApiRouter,
	OpenApiSuccessResponse,
} from "../../types";
import { acceptsRequestBody } from "../../utils/method";
import { normalizePath } from "../../utils/path";
import { getInputOutputParsers } from "../../utils/procedure";
import {
	instanceofZodTypeCoercible,
	instanceofZodTypeLikeVoid,
	instanceofZodTypeObject,
	unwrapZodType,
	zodSupportsCoerce,
} from "../../utils/zod";
import { TRPC_ERROR_CODE_HTTP_STATUS, getErrorFromUnknown } from "./errors";
import { getBody, getQuery } from "./input";
import { createProcedureCache } from "./procedures";

/*
 * Zod's own coercion, reachable as a value.
 *
 * Coercion used to be applied by flipping `_def.coerce` on the caller's schema,
 * which mutated a schema this package does not own and never restored it. These
 * stand-ins let the same conversion be applied to the *value* instead, so the
 * schema is never touched. Using z.coerce.* rather than hand-rolled casts keeps
 * the semantics identical to the old behaviour, quirks included -- notably
 * z.coerce.boolean() is Boolean(value), so "false" is true.
 */
const VALUE_COERCERS: Record<string, z.ZodTypeAny> = {
	string: z.coerce.string(),
	number: z.coerce.number(),
	boolean: z.coerce.boolean(),
	bigint: z.coerce.bigint(),
	date: z.coerce.date(),
};

export type CreateOpenApiNodeHttpHandlerOptions<
	TRouter extends OpenApiRouter,
	TRequest extends NodeHTTPRequest,
	TResponse extends NodeHTTPResponse,
> = Pick<
	NodeHTTPHandlerOptions<TRouter, TRequest, TResponse>,
	"router" | "createContext" | "responseMeta" | "onError" | "maxBodySize"
>;

export type OpenApiNextFunction = () => void;

export const createOpenApiNodeHttpHandler = <
	TRouter extends OpenApiRouter,
	TRequest extends NodeHTTPRequest,
	TResponse extends NodeHTTPResponse,
>(
	opts: CreateOpenApiNodeHttpHandlerOptions<TRouter, TRequest, TResponse>,
) => {
	const router = cloneDeep(opts.router);

	// Validate router
	if (process.env.NODE_ENV !== "production") {
		generateOpenApiDocument(router, { title: "", version: "", baseUrl: "" });
	}

	const { createContext, responseMeta, onError, maxBodySize } = opts;
	const getProcedure = createProcedureCache(router);

	return async (req: TRequest, res: TResponse, next?: OpenApiNextFunction) => {
		const sendResponse = (
			statusCode: number,
			headers: Record<string, string>,
			body: OpenApiResponse | undefined,
		) => {
			res.statusCode = statusCode;
			res.setHeader("Content-Type", "application/json");
			for (const [key, value] of Object.entries(headers)) {
				if (typeof value !== "undefined") {
					res.setHeader(key, value);
				}
			}
			res.end(JSON.stringify(body));
		};

		const method = req.method! as OpenApiMethod & "HEAD";
		const reqUrl = req.url!;
		const url = new URL(
			reqUrl.startsWith("/") ? `http://127.0.0.1${reqUrl}` : reqUrl,
		);
		const path = normalizePath(url.pathname);
		const { procedure, pathInput } = getProcedure(method, path) ?? {};

		let input: any = undefined;
		let ctx: any = undefined;
		let data: any = undefined;

		try {
			if (!procedure) {
				if (next) {
					return next();
				}

				// Can be used for warmup
				if (method === "HEAD") {
					sendResponse(204, {}, undefined);
					return;
				}

				throw new TRPCError({
					message: "Not found",
					code: "NOT_FOUND",
				});
			}

			const useBody = acceptsRequestBody(method);
			const schema = getInputOutputParsers(procedure.procedure)
				.inputParser as z.ZodTypeAny;
			const unwrappedSchema = unwrapZodType(schema, true);

			// input should stay undefined if z.void()
			if (!instanceofZodTypeLikeVoid(unwrappedSchema)) {
				input = {
					...(useBody ? await getBody(req, maxBodySize) : getQuery(req, url)),
					...pathInput,
				};
			}

			/*
			 * Coercion, scoped by what the transport can actually carry, and
			 * applied to the VALUE rather than to the schema.
			 *
			 * A query string is always text: `?n=123` must become a number
			 * before z.number() will take it, so everything coercible is fair
			 * game there.
			 *
			 * A JSON body is different. It already carries real types, so
			 * coercing indiscriminately means POSTing {"payload": 123} to a
			 * z.string() field silently becomes "123" and returns 200 -- the API
			 * accepting input its own schema rejects. But JSON cannot express
			 * every type either: a Date arrives as a string and a BigInt as a
			 * string or number, and those genuinely do need coercing.
			 *
			 * So: in a body, coerce only what JSON has no representation for.
			 * string / number / boolean are left alone, and a mismatch there is
			 * reported as the client error it is.
			 *
			 * Only keys the request actually sent are touched. Coercion has
			 * nothing to convert for a key that never arrived, and marking one
			 * coerced destroys the error: Zod 4 reports a coerced-but-missing
			 * value as `expected: "nonoptional"` instead of naming the type the
			 * client failed to send.
			 *
			 * `input` is built above from this request's query/body/path, so
			 * rewriting it is local to this request. The previous approach set
			 * `_def.coerce` on the caller's schema and never restored it, which
			 * left a schema shared between a GET and a POST route coerced for
			 * the body route too, for the life of the process -- silently
			 * undoing the transport scoping this comment describes.
			 *
			 * A value that will not coerce is left exactly as it arrived, so the
			 * procedure's own parser produces the authoritative error rather
			 * than this adapter inventing one.
			 */
			const JSON_CANNOT_EXPRESS = new Set(["date", "bigint"]);
			if (zodSupportsCoerce && input !== undefined) {
				if (instanceofZodTypeObject(unwrappedSchema)) {
					Object.entries(unwrappedSchema.shape).forEach(
						([shapeKey, shapeSchema]) => {
							if (!Object.prototype.hasOwnProperty.call(input, shapeKey)) {
								return;
							}
							const unwrappedShapeSchema = unwrapZodType(shapeSchema, false);
							if (!instanceofZodTypeCoercible(unwrappedShapeSchema)) return;
							const kind = (unwrappedShapeSchema as any)?._zod?.def?.type;
							if (useBody && !JSON_CANNOT_EXPRESS.has(kind)) return;
							const coercer = VALUE_COERCERS[kind];
							if (!coercer) return;
							const coerced = coercer.safeParse(input[shapeKey]);
							if (coerced.success) input[shapeKey] = coerced.data;
						},
					);
				}
			}

			ctx = await createContext?.({ req, res });
			const caller = router.createCaller(ctx);

			const segments = procedure.path.split(".");
			const procedureFn = segments.reduce(
				(acc, curr) => acc[curr],
				caller as any,
			) as AnyProcedure;

			data = await procedureFn(input);

			const meta = responseMeta?.({
				type: procedure.type,
				paths: [procedure.path],
				ctx,
				data: [data],
				errors: [],
			});

			const statusCode = meta?.status ?? 200;
			const headers = meta?.headers ?? {};
			const body: OpenApiSuccessResponse<typeof data> = data;
			sendResponse(statusCode, headers, body);
		} catch (cause) {
			const error = getErrorFromUnknown(cause);

			onError?.({
				error,
				type: procedure?.type ?? "unknown",
				path: procedure?.path,
				input,
				ctx,
				req,
			});

			const meta = responseMeta?.({
				type: procedure?.type ?? "unknown",
				paths: procedure?.path ? [procedure?.path] : undefined,
				ctx,
				data: [data],
				errors: [error],
			});

			const errorShape = router.getErrorShape({
				error,
				type: procedure?.type ?? "unknown",
				path: procedure?.path,
				input,
				ctx,
			});

			const isInputValidationError =
				error.code === "BAD_REQUEST" &&
				error.cause instanceof Error &&
				error.cause.name === "ZodError";

			const statusCode =
				meta?.status ?? TRPC_ERROR_CODE_HTTP_STATUS[error.code] ?? 500;
			const headers = meta?.headers ?? {};
			const body: OpenApiErrorResponse = {
				message: isInputValidationError
					? "Input validation failed"
					: errorShape?.message ?? error.message ?? "An error occurred",
				code: error.code,
				/*
				 * `.issues`, not `.errors`. Zod 4 renamed it, and since the old
				 * name simply reads as undefined rather than throwing, every
				 * validation error response silently lost its issues array —
				 * clients got `{message, code}` and no indication of WHICH field
				 * was wrong.
				 */
				issues: isInputValidationError
					? (error.cause as ZodError).issues
					: undefined,
			};
			sendResponse(statusCode, headers, body);
		}
	};
};
