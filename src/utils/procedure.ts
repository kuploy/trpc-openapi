// eslint-disable-next-line import/no-unresolved
import { ProcedureType } from "@trpc/server";
import {  z } from "zod";

import {
	OpenApiMeta,
	OpenApiMethod,
	OpenApiProcedure,
	OpenApiProcedureRecord,
} from "../types";
import {
	instanceofZodType,
	instanceofZodTypeLikeString,
	instanceofZodTypeLikeVoid,
	instanceofZodTypeObject,
	unwrapZodType,
} from "./zod";

const mergeInputs = (inputParsers: z.ZodObject[]): z.ZodObject => {
	return inputParsers.reduce((acc, inputParser) => {
		return acc.merge(inputParser);
	}, z.object({}));
};

// `inputParser` & `outputParser` are private so this is a hack to access it
export const getInputOutputParsers = (procedure: OpenApiProcedure) => {
	const { inputs, output } = procedure._def;
	return {
		inputParser:
			inputs.length >= 2 ? mergeInputs(inputs as z.ZodObject[]) : inputs[0],
		outputParser: output,
	};
};

const getProcedureType = (procedure: OpenApiProcedure): ProcedureType => {
	if (procedure._def.query) return "query";
	if (procedure._def.mutation) return "mutation";
	if (procedure._def.subscription) return "subscription";
	throw new Error("Unknown procedure type");
};

/**
 * Can this procedure's input actually travel as query parameters?
 *
 * A GET has no body, so its input must flatten into `?key=value` pairs: an
 * object whose every value survives as a string. A nested object, an array, a
 * non-object input — none of those fit, and asking for them produced a hard
 * error that aborted the ENTIRE document rather than one route.
 */
const canTravelAsQueryParams = (procedure: OpenApiProcedure): boolean => {
	const { inputParser } = getInputOutputParsers(procedure);

	// No input at all is fine as a GET — this fork exposes every procedure, so
	// argument-less queries are the common case.
	if (inputParser === undefined) return true;
	if (!instanceofZodType(inputParser)) return false;

	const unwrapped = unwrapZodType(inputParser, true);
	if (instanceofZodTypeLikeVoid(unwrapped)) return true;
	if (!instanceofZodTypeObject(unwrapped)) return false;

	return Object.values(unwrapped.shape).every((value) =>
		instanceofZodTypeLikeString(value as z.ZodTypeAny),
	);
};

/**
 * The method for an AUTO-DERIVED route.
 *
 * Was `query ? "GET" : "POST"`, chosen without looking at the input. That is
 * the root of most generation failures here: a query whose input is a nested
 * object is perfectly expressible as a POST body, but it was forced to GET and
 * then rejected for not fitting in a query string. Nobody declared GET — the
 * generator inferred it — so inferring POST instead loses nothing and rescues
 * the route.
 *
 * A procedure that explicitly sets a method in its meta never reaches this;
 * see forEachOpenApiProcedure, where an override wins.
 */
export const getMethod = (procedure: OpenApiProcedure): OpenApiMethod => {
	if (getProcedureType(procedure) !== "query") return "POST";
	return canTravelAsQueryParams(procedure) ? "GET" : "POST";
};

export const forEachOpenApiProcedure = (
	procedureRecord: OpenApiProcedureRecord,
	callback: (values: {
		path: string;
		type: ProcedureType;
		procedure: OpenApiProcedure;
		openapi: NonNullable<OpenApiMeta["openapi"]>;
		/**
		 * Did a developer actually ask for this route?
		 *
		 * True when the procedure carries openapi meta of its own. False when
		 * the route exists only because this fork exposes every procedure by
		 * default. The distinction decides whether a route that cannot be
		 * represented is an error worth failing the build for, or simply one to
		 * leave out — see getOpenApiPathsObject.
		 */
		declared: boolean;
	}) => void,
) => {
	for (const [path, procedure] of Object.entries(procedureRecord)) {
		const additional = procedure._def.meta?.openapi?.additional ?? false;
		const override = procedure._def.meta?.openapi?.override ?? false;
		const defaultOpenApiMeta = {
			method: getMethod(procedure),
			path: path,
			enabled: true,
			tags: [path.split(".")[0]],
			protect: true,
		};
		let openapi: OpenApiMeta;

		if (override) {
			openapi = { ...procedure._def.meta?.openapi };
		} else if (additional) {
			openapi = { ...defaultOpenApiMeta, ...procedure._def.meta?.openapi };
		} else {
			openapi = { ...procedure._def.meta?.openapi, ...defaultOpenApiMeta };
		}

		if (openapi && openapi.enabled !== false) {
			const type = getProcedureType(procedure);
			const declared = Boolean(procedure._def.meta?.openapi);
			// @ts-ignore
			callback({ path, type, procedure, openapi, declared });
		}
	}
};
