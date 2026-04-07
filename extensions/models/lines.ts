import { z } from "npm:zod@4";
import { XMLParser } from "npm:fast-xml-parser@4.5.0";
import { Agent, fetch } from "npm:undici@5.28.4";

// ─── Schemas ────────────────────────────────────────────────────────────────

const GlobalArgsSchema = z.object({
  host: z.string().describe("CUCM hostname or IP address"),
  username: z.string().meta({ sensitive: true }).describe("AXL username"),
  password: z.string().meta({ sensitive: true }).describe("AXL password"),
  version: z
    .string()
    .optional()
    .describe(
      "AXL schema version (e.g. '12.5', '14.0', '15.0'). Auto-discovered via getCCMVersion if omitted.",
    ),
});

// CUCM foreign-key reference field (name + optional uuid)
const FkSchema = z
  .object({ name: z.string().nullable(), uuid: z.string().nullable() })
  .nullable();

// Subset of fields returned by listLine (LLine)
const LineSchema = z
  .object({
    uuid: z.string().optional(),
    pattern: z.string().optional(),
    description: z.string().nullable().optional(),
    usage: z.string().optional(),
    routePartitionName: FkSchema.optional(),
    alertingName: z.string().nullable().optional(),
    asciiAlertingName: z.string().nullable().optional(),
    presenceGroupName: FkSchema.optional(),
    shareLineAppearanceCssName: FkSchema.optional(),
    voiceMailProfileName: FkSchema.optional(),
    autoAnswer: z.string().optional(),
  })
  .passthrough();

// Full line detail returned by getLine (RLine)
const LineDetailSchema = z
  .object({
    uuid: z.string().optional(),
    pattern: z.string().optional(),
    description: z.string().nullable().optional(),
    usage: z.string().optional(),
    routePartitionName: FkSchema.optional(),
    alertingName: z.string().nullable().optional(),
    asciiAlertingName: z.string().nullable().optional(),
    presenceGroupName: FkSchema.optional(),
    shareLineAppearanceCssName: FkSchema.optional(),
    voiceMailProfileName: FkSchema.optional(),
    autoAnswer: z.string().optional(),
    active: z.boolean().optional(),
  })
  .passthrough();

const LinesOutputSchema = z.object({
  axlVersion: z.string(),
  total: z.number(),
  lines: z.array(LineSchema),
});

// Default fields requested from CUCM (maps to LLine elements in returnedTags)
const DEFAULT_RETURNED_TAGS = [
  "pattern",
  "description",
  "usage",
  "routePartitionName",
  "alertingName",
  "asciiAlertingName",
  "presenceGroupName",
  "shareLineAppearanceCssName",
  "voiceMailProfileName",
  "autoAnswer",
];

// ─── Helpers ────────────────────────────────────────────────────────────────

const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";

// Reusable agent that skips TLS certificate verification (self-signed CUCM certs)
const AGENT = new Agent({ connect: { rejectUnauthorized: false } });

function axlNs(version: string) {
  return `http://www.cisco.com/AXL/API/${version}`;
}

function basicAuth(username: string, password: string) {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

/** Normalize an XFkType value from fast-xml-parser output.
 *  Wire format: <routePartitionName uuid="{u}">Name</routePartitionName>
 *  Parsed as:   { "#text": "Name", "@_uuid": "{u}" }  or just "Name" */
function normalizeFk(
  v: unknown,
): { name: string | null; uuid: string | null } | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return { name: v || null, uuid: null };
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const name = (obj["#text"] ?? obj["_"] ?? null) as string | null;
    const uuid = (obj["@_uuid"] ?? null) as string | null;
    return { name: name || null, uuid: uuid || null };
  }
  return null;
}

/** Fields in LLine/RLine that are XFkType */
const FK_FIELDS = new Set([
  "routePartitionName",
  "aarNeighborhoodName",
  "callPickupGroupName",
  "presenceGroupName",
  "shareLineAppearanceCssName",
  "voiceMailProfileName",
  "defaultActivatedDeviceName",
  "parkMonForwardNoRetrieveCssName",
  "parkMonForwardNoRetrieveIntCssName",
  "externalCallControlProfile",
]);

/** Normalize a raw line record from the parsed XML */
function normalizeLine(raw: Record<string, unknown>): Record<string, unknown> {
  const { "@_uuid": uuid, ...fields } = raw;
  const result: Record<string, unknown> = { uuid };

  for (const [key, value] of Object.entries(fields)) {
    result[key] = FK_FIELDS.has(key) ? normalizeFk(value) : value;
  }

  return result;
}

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: true,
  parseAttributeValue: false, // keep uuids as strings
  removeNSPrefix: true, // strip soapenv: axl: prefixes → easier navigation
  isArray: (_name, jpath) =>
    jpath === "Envelope.Body.listLineResponse.return.line", // always an array
});

async function soapRequest(
  host: string,
  auth: string,
  version: string,
  action: string,
  bodyInner: string,
): Promise<Record<string, unknown>> {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="${SOAP_NS}" xmlns:axl="${
    axlNs(version)
  }" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <soapenv:Header/>
  <soapenv:Body>
${bodyInner}
  </soapenv:Body>
</soapenv:Envelope>`;

  const res = await fetch(`https://${host}:8443/axl/`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `CUCM:DB ver=${version} ${action}`,
      Authorization: auth,
    },
    body: envelope,
    dispatcher: AGENT,
  });

  const text = await res.text();

  if (!res.ok) {
    const parsed = XML_PARSER.parse(text);
    const fault = parsed?.Envelope?.Body?.Fault?.faultstring ??
      parsed?.Envelope?.Body?.Fault?.detail?.axlError?.axlmessage ??
      text;
    throw new Error(`AXL ${action} failed (HTTP ${res.status}): ${fault}`);
  }

  return XML_PARSER.parse(text);
}

/** Discover AXL version from CUCM via getCCMVersion */
async function discoverVersion(host: string, auth: string): Promise<string> {
  const parsed = await soapRequest(
    host,
    auth,
    "15.0",
    "getCCMVersion",
    `    <axl:getCCMVersion/>`,
  );

  const versionStr = parsed?.Envelope?.Body?.getCCMVersionResponse?.return
    ?.componentVersion?.version;

  if (typeof versionStr !== "string" || !versionStr) {
    throw new Error("getCCMVersion returned no version string");
  }

  // "12.5.1.12900-2" → "12.5"
  const match = versionStr.match(/^(\d+\.\d+)/);
  if (!match) throw new Error(`Unexpected CUCM version format: ${versionStr}`);
  return match[1];
}

/** Build an instance name for getLine storage: "pattern@partition" or just "pattern" */
function lineInstanceName(
  pattern: string,
  routePartitionName?: string | null,
): string {
  return routePartitionName ? `${pattern}@${routePartitionName}` : pattern;
}

// ─── Model ──────────────────────────────────────────────────────────────────

export const model = {
  type: "@notthatjesus/cisco-unified-communications-manager/line",
  version: "2026.04.07.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    lines: {
      description: "Directory numbers returned by listLine",
      schema: LinesOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    line: {
      description:
        "Full line detail returned by getLine, keyed by pattern[@partition]",
      schema: LineDetailSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    listLine: {
      description:
        "List directory numbers (lines) from CUCM AXL. At least one searchCriteria field is required; use '%' for wildcard.",
      arguments: z.object({
        searchCriteria: z
          .object({
            pattern: z.string().optional(),
            description: z.string().optional(),
            usage: z.string().optional(),
            routePartitionName: z.string().optional(),
          })
          .default({ pattern: "%" })
          .describe("At least one field required. Use '%' for wildcard match."),
        returnedTags: z
          .array(z.string())
          .default(DEFAULT_RETURNED_TAGS)
          .describe(
            "LLine fields to return. Defaults to a practical core set.",
          ),
        skip: z.number().int().nonnegative().optional().describe(
          "Pagination offset",
        ),
        first: z.number().int().positive().optional().describe(
          "Max records to return",
        ),
      }),
      execute: async (args, context) => {
        const { host, username, password, version: configuredVersion } =
          context.globalArgs;
        const auth = basicAuth(username, password);

        const axlVersion = configuredVersion ??
          (await discoverVersion(host, auth));
        context.logger.info(`Using AXL version ${axlVersion}`);

        const { searchCriteria, returnedTags, skip, first } = args;

        const criteriaLines = Object.entries(searchCriteria)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `        <${k}>${v}</${k}>`)
          .join("\n");

        if (!criteriaLines) {
          throw new Error(
            "searchCriteria must have at least one field. Use pattern='%' to match all lines.",
          );
        }

        const tagsLines = returnedTags.map((t) => `        <${t}/>`).join("\n");

        const paginationLines = [
          skip !== undefined ? `      <skip>${skip}</skip>` : "",
          first !== undefined ? `      <first>${first}</first>` : "",
        ]
          .filter(Boolean)
          .join("\n");

        const bodyInner = `    <axl:listLine sequence="1">
      <searchCriteria>
${criteriaLines}
      </searchCriteria>
      <returnedTags>
${tagsLines}
      </returnedTags>
${paginationLines}
    </axl:listLine>`;

        const parsed = await soapRequest(
          host,
          auth,
          axlVersion,
          "listLine",
          bodyInner,
        );

        const lines: unknown[] =
          parsed?.Envelope?.Body?.listLineResponse?.return?.line ?? [];

        const normalized = (lines as Record<string, unknown>[]).map(
          normalizeLine,
        );

        context.logger.info(`listLine returned ${normalized.length} lines`);

        const handle = await context.writeResource("lines", "main", {
          axlVersion,
          total: normalized.length,
          lines: normalized,
        });

        return { dataHandles: [handle] };
      },
    },

    getLine: {
      description:
        "Get full details of a single directory number by pattern+partition or UUID. Stores result keyed by pattern[@partition].",
      arguments: z.object({
        pattern: z.string().optional().describe("DN pattern (e.g. '1001')"),
        routePartitionName: z
          .string()
          .nullable()
          .optional()
          .describe("Route partition name (null or omit for none)"),
        uuid: z.string().optional().describe("Line UUID"),
      }).refine((a) => a.pattern || a.uuid, {
        message: "Either pattern or uuid is required",
      }),
      execute: async (args, context) => {
        const { host, username, password, version: configuredVersion } =
          context.globalArgs;
        const auth = basicAuth(username, password);
        const axlVersion = configuredVersion ??
          (await discoverVersion(host, auth));
        context.logger.info(`Using AXL version ${axlVersion}`);

        let lookup: string;
        if (args.uuid) {
          lookup = `      <uuid>${args.uuid}</uuid>`;
        } else {
          lookup = `      <pattern>${args.pattern}</pattern>
      <routePartitionName${
            args.routePartitionName
              ? `>${args.routePartitionName}</routePartitionName`
              : ` xsi:nil="true"/`
          }>`;
        }

        const bodyInner = `    <axl:getLine sequence="1">
${lookup}
    </axl:getLine>`;

        const parsed = await soapRequest(
          host,
          auth,
          axlVersion,
          "getLine",
          bodyInner,
        );

        const raw = parsed?.Envelope?.Body?.getLineResponse?.return?.line;
        if (!raw || typeof raw !== "object") {
          throw new Error("getLine returned no line object");
        }

        const line = normalizeLine(raw as Record<string, unknown>);
        const pattern = (line.pattern as string) ?? args.pattern ?? "unknown";
        const partition =
          (line.routePartitionName as { name: string | null } | null)?.name ??
            args.routePartitionName ?? null;
        const instanceName = lineInstanceName(pattern, partition);

        context.logger.info(`getLine returned line "${instanceName}"`);

        const handle = await context.writeResource("line", instanceName, line);
        return { dataHandles: [handle] };
      },
    },

    addLine: {
      description: "Add a new directory number (line) to CUCM.",
      arguments: z.object({
        // Required by XLine
        pattern: z.string().describe("DN pattern (e.g. '1001')"),
        usage: z
          .string()
          .default("Device")
          .describe(
            "Pattern usage: 'Device', 'Translation', 'Hunt Pilot', etc.",
          ),
        routePartitionName: z
          .string()
          .nullable()
          .default(null)
          .describe("Route partition name (null for none)"),
        // Commonly configured optional fields
        description: z.string().optional().describe("Description of this DN"),
        alertingName: z.string().optional().describe(
          "Alerting name (caller ID)",
        ),
        asciiAlertingName: z.string().optional().describe(
          "ASCII alerting name",
        ),
        presenceGroupName: z.string().optional().describe("Presence group"),
        shareLineAppearanceCssName: z.string().nullable().optional().describe(
          "Shared line CSS",
        ),
        voiceMailProfileName: z.string().nullable().optional().describe(
          "Voice mail profile",
        ),
        autoAnswer: z
          .string()
          .optional()
          .describe(
            "Auto answer: 'Auto Answer Off', 'Auto Answer with Headset', etc.",
          ),
        active: z.boolean().optional().describe("Whether the line is active"),
      }),
      execute: async (args, context) => {
        const { host, username, password, version: configuredVersion } =
          context.globalArgs;
        const auth = basicAuth(username, password);
        const axlVersion = configuredVersion ??
          (await discoverVersion(host, auth));
        context.logger.info(`Using AXL version ${axlVersion}`);

        // Helper: build a nullable FK element
        const fkEl = (tag: string, value: string | null | undefined) => {
          if (value === undefined) return "";
          if (value === null) return `        <${tag} xsi:nil="true"/>`;
          return `        <${tag}>${value}</${tag}>`;
        };

        // Helper: optional string element (omit if undefined)
        const optEl = (tag: string, value: string | undefined) =>
          value !== undefined ? `        <${tag}>${value}</${tag}>` : "";

        const bodyInner = `    <axl:addLine sequence="1">
      <line>
        <pattern>${args.pattern}</pattern>
        <usage>${args.usage}</usage>
${fkEl("routePartitionName", args.routePartitionName)}
${optEl("description", args.description)}
${optEl("alertingName", args.alertingName)}
${optEl("asciiAlertingName", args.asciiAlertingName)}
${optEl("presenceGroupName", args.presenceGroupName)}
${fkEl("shareLineAppearanceCssName", args.shareLineAppearanceCssName)}
${fkEl("voiceMailProfileName", args.voiceMailProfileName)}
${optEl("autoAnswer", args.autoAnswer)}
${args.active !== undefined ? `        <active>${args.active}</active>` : ""}
      </line>
    </axl:addLine>`;

        const result = await soapRequest(
          host,
          auth,
          axlVersion,
          "addLine",
          bodyInner,
        );
        const newUuid =
          result?.Envelope?.Body?.addLineResponse?.return?.["#text"] ??
            result?.Envelope?.Body?.addLineResponse?.return;
        context.logger.info(
          `addLine created line "${args.pattern}" with UUID ${newUuid}`,
        );

        // Fetch and store the full line record
        const partition = args.routePartitionName;
        const refreshLookup = `      <pattern>${args.pattern}</pattern>
      <routePartitionName${
          partition ? `>${partition}</routePartitionName` : ` xsi:nil="true"/`
        }>`;

        const refreshed = await soapRequest(
          host,
          auth,
          axlVersion,
          "getLine",
          `    <axl:getLine sequence="1">\n${refreshLookup}\n    </axl:getLine>`,
        );
        const raw = refreshed?.Envelope?.Body?.getLineResponse?.return?.line;
        const line = normalizeLine((raw ?? {}) as Record<string, unknown>);
        const instanceName = lineInstanceName(args.pattern, partition);

        const handle = await context.writeResource("line", instanceName, line);
        return { dataHandles: [handle] };
      },
    },

    updateLine: {
      description:
        "Update a directory number in CUCM AXL. Identify by pattern+partition or UUID. Only provided fields are updated. Refreshes stored line record afterwards.",
      arguments: z
        .object({
          pattern: z.string().optional().describe("Current DN pattern"),
          routePartitionName: z
            .string()
            .nullable()
            .optional()
            .describe("Route partition (null for none)"),
          uuid: z.string().optional().describe("Line UUID"),
          newPattern: z.string().optional().describe("New DN pattern (rename)"),
          newRoutePartitionName: z
            .string()
            .nullable()
            .optional()
            .describe("New route partition name (null to clear)"),
          description: z.string().optional(),
          alertingName: z.string().optional(),
          asciiAlertingName: z.string().optional(),
          presenceGroupName: z.string().nullable().optional(),
          shareLineAppearanceCssName: z.string().nullable().optional(),
          voiceMailProfileName: z.string().nullable().optional(),
          autoAnswer: z.string().optional(),
          active: z.boolean().optional(),
        })
        .refine((a) => a.pattern || a.uuid, {
          message: "Either pattern or uuid is required",
        }),
      execute: async (args, context) => {
        const { host, username, password, version: configuredVersion } =
          context.globalArgs;
        const auth = basicAuth(username, password);
        const axlVersion = configuredVersion ??
          (await discoverVersion(host, auth));
        context.logger.info(`Using AXL version ${axlVersion}`);

        const {
          pattern,
          routePartitionName,
          uuid,
          newPattern,
          newRoutePartitionName,
          ...updateFields
        } = args;

        // Build lookup block (xsd:choice: uuid OR pattern+routePartitionName)
        let lookup: string;
        if (uuid) {
          lookup = `      <uuid>${uuid}</uuid>`;
        } else {
          lookup = `      <pattern>${pattern}</pattern>
      <routePartitionName${
            routePartitionName
              ? `>${routePartitionName}</routePartitionName`
              : ` xsi:nil="true"/`
          }>`;
        }

        // Optional rename fields
        const renameLines = [
          newPattern !== undefined
            ? `      <newPattern>${newPattern}</newPattern>`
            : "",
          newRoutePartitionName !== undefined
            ? newRoutePartitionName === null
              ? `      <newRoutePartitionName xsi:nil="true"/>`
              : `      <newRoutePartitionName>${newRoutePartitionName}</newRoutePartitionName>`
            : "",
        ]
          .filter(Boolean)
          .join("\n");

        // Build other update field elements
        const fieldLines = Object.entries(updateFields)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => {
            if (v === null) return `      <${k} xsi:nil="true"/>`;
            if (typeof v === "boolean") return `      <${k}>${v}</${k}>`;
            return `      <${k}>${v}</${k}>`;
          })
          .join("\n");

        const bodyInner = `    <axl:updateLine sequence="1">
${lookup}
${renameLines}
${fieldLines}
    </axl:updateLine>`;

        await soapRequest(host, auth, axlVersion, "updateLine", bodyInner);

        // Determine lookup for refresh
        const refreshPattern = newPattern ?? pattern;
        const refreshPartition = newRoutePartitionName !== undefined
          ? newRoutePartitionName
          : routePartitionName;

        let refreshLookup: string;
        if (refreshPattern) {
          refreshLookup = `      <pattern>${refreshPattern}</pattern>
      <routePartitionName${
            refreshPartition
              ? `>${refreshPartition}</routePartitionName`
              : ` xsi:nil="true"/`
          }>`;
        } else {
          refreshLookup = `      <uuid>${uuid}</uuid>`;
        }

        const refreshed = await soapRequest(
          host,
          auth,
          axlVersion,
          "getLine",
          `    <axl:getLine sequence="1">\n${refreshLookup}\n    </axl:getLine>`,
        );

        const raw = refreshed?.Envelope?.Body?.getLineResponse?.return?.line;
        const line = normalizeLine((raw ?? {}) as Record<string, unknown>);
        const finalPattern = (line.pattern as string) ?? refreshPattern ??
          "unknown";
        const finalPartition =
          (line.routePartitionName as { name: string | null } | null)?.name ??
            refreshPartition ??
            null;
        const instanceName = lineInstanceName(finalPattern, finalPartition);

        context.logger.info(
          `updateLine succeeded, refreshed "${instanceName}"`,
        );

        const handle = await context.writeResource("line", instanceName, line);
        return { dataHandles: [handle] };
      },
    },

    removeLine: {
      description:
        "Remove a directory number from CUCM by pattern+partition or UUID.",
      arguments: z
        .object({
          pattern: z.string().optional().describe("DN pattern (e.g. '1001')"),
          routePartitionName: z
            .string()
            .nullable()
            .optional()
            .describe("Route partition name (null for none)"),
          uuid: z.string().optional().describe("Line UUID"),
        })
        .refine((a) => a.pattern || a.uuid, {
          message: "Either pattern or uuid is required",
        }),
      execute: async (args, context) => {
        const { host, username, password, version: configuredVersion } =
          context.globalArgs;
        const auth = basicAuth(username, password);
        const axlVersion = configuredVersion ??
          (await discoverVersion(host, auth));
        context.logger.info(`Using AXL version ${axlVersion}`);

        let lookup: string;
        if (args.uuid) {
          lookup = `      <uuid>${args.uuid}</uuid>`;
        } else {
          lookup = `      <pattern>${args.pattern}</pattern>
      <routePartitionName${
            args.routePartitionName
              ? `>${args.routePartitionName}</routePartitionName`
              : ` xsi:nil="true"/`
          }>`;
        }

        const bodyInner = `    <axl:removeLine sequence="1">
${lookup}
    </axl:removeLine>`;

        await soapRequest(host, auth, axlVersion, "removeLine", bodyInner);

        context.logger.info(
          `removeLine deleted "${args.pattern ?? args.uuid}"`,
        );
        return { dataHandles: [] };
      },
    },
  },
};
