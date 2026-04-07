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

const FkSchema = z
  .object({ name: z.string().nullable(), uuid: z.string().nullable() })
  .nullable();

const PhoneLineSchema = z.object({
  index: z.number().optional(),
  label: z.string().nullable().optional(),
  display: z.string().nullable().optional(),
  displayAscii: z.string().nullable().optional(),
  e164Mask: z.string().nullable().optional(),
  dirn: z.object({ uuid: z.string().nullable() }).nullable().optional(),
}).passthrough();

// Subset returned by listDeviceProfile (LDeviceProfile)
const DeviceProfileSchema = z
  .object({
    uuid: z.string().optional(),
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    product: z.string().optional(),
    model: z.string().optional(),
    class: z.string().optional(),
    protocol: z.string().optional(),
    protocolSide: z.string().optional(),
    phoneTemplateName: FkSchema.optional(),
  })
  .passthrough();

// Full detail returned by getDeviceProfile (RDeviceProfile)
const DeviceProfileDetailSchema = z
  .object({
    uuid: z.string().optional(),
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    product: z.string().optional(),
    model: z.string().optional(),
    class: z.string().optional(),
    protocol: z.string().optional(),
    protocolSide: z.string().optional(),
    phoneTemplateName: FkSchema.optional(),
    softkeyTemplateName: FkSchema.optional(),
    loginUserId: FkSchema.optional(),
    lines: z.union([z.object({ line: z.array(PhoneLineSchema) }), z.string()])
      .optional(),
  })
  .passthrough();

const DeviceProfilesOutputSchema = z.object({
  axlVersion: z.string(),
  total: z.number(),
  deviceProfiles: z.array(DeviceProfileSchema),
});

const DEFAULT_RETURNED_TAGS = [
  "name",
  "description",
  "product",
  "model",
  "class",
  "protocol",
  "protocolSide",
  "phoneTemplateName",
];

// ─── Helpers ────────────────────────────────────────────────────────────────

const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";

const AGENT = new Agent({ connect: { rejectUnauthorized: false } });

function axlNs(version: string) {
  return `http://www.cisco.com/AXL/API/${version}`;
}

function basicAuth(username: string, password: string) {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

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

const FK_FIELDS = new Set([
  "phoneTemplateName",
  "softkeyTemplateName",
  "loginUserId",
  "emccCallingSearchSpace",
  "featureControlPolicy",
]);

function normalizeDeviceProfile(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const { "@_uuid": uuid, "@_ctiid": ctiid, ...fields } = raw;
  const result: Record<string, unknown> = { uuid, ctiid };

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
  parseAttributeValue: false,
  removeNSPrefix: true,
  isArray: (_name, jpath) =>
    jpath === "Envelope.Body.listDeviceProfileResponse.return.deviceProfile" ||
    jpath.endsWith(".lines.line"),
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
  const match = versionStr.match(/^(\d+\.\d+)/);
  if (!match) throw new Error(`Unexpected CUCM version format: ${versionStr}`);
  return match[1];
}

// ─── Model ──────────────────────────────────────────────────────────────────

export const model = {
  type: "@notthatjesus/cisco-unified-communications-manager/device-profile",
  version: "2026.04.07.3",
  globalArguments: GlobalArgsSchema,
  resources: {
    deviceProfiles: {
      description: "Device profiles returned by listDeviceProfile",
      schema: DeviceProfilesOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    deviceProfile: {
      description:
        "Full device profile detail returned by getDeviceProfile, keyed by name",
      schema: DeviceProfileDetailSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    listDeviceProfile: {
      description:
        "List device profiles from CUCM AXL. At least one searchCriteria field is required; use '%' for wildcard.",
      arguments: z.object({
        searchCriteria: z
          .object({
            name: z.string().optional(),
            description: z.string().optional(),
          })
          .default({ name: "%" })
          .describe("At least one field required. Use '%' for wildcard match."),
        returnedTags: z
          .array(z.string())
          .default(DEFAULT_RETURNED_TAGS)
          .describe("LDeviceProfile fields to return."),
        skip: z.number().int().nonnegative().optional(),
        first: z.number().int().positive().optional(),
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
          throw new Error("searchCriteria must have at least one field.");
        }

        const tagsLines = returnedTags.map((t) => `        <${t}/>`).join("\n");

        const paginationLines = [
          skip !== undefined ? `      <skip>${skip}</skip>` : "",
          first !== undefined ? `      <first>${first}</first>` : "",
        ]
          .filter(Boolean)
          .join("\n");

        const bodyInner = `    <axl:listDeviceProfile sequence="1">
      <searchCriteria>
${criteriaLines}
      </searchCriteria>
      <returnedTags>
${tagsLines}
      </returnedTags>
${paginationLines}
    </axl:listDeviceProfile>`;

        const parsed = await soapRequest(
          host,
          auth,
          axlVersion,
          "listDeviceProfile",
          bodyInner,
        );

        const profiles: unknown[] =
          parsed?.Envelope?.Body?.listDeviceProfileResponse?.return
            ?.deviceProfile ?? [];

        const normalized = (profiles as Record<string, unknown>[]).map(
          normalizeDeviceProfile,
        );
        context.logger.info(
          `listDeviceProfile returned ${normalized.length} profiles`,
        );

        const handle = await context.writeResource("deviceProfiles", "main", {
          axlVersion,
          total: normalized.length,
          deviceProfiles: normalized,
        });

        return { dataHandles: [handle] };
      },
    },

    getDeviceProfile: {
      description: "Get full details of a device profile by name or UUID.",
      arguments: z.object({
        name: z.string().optional().describe("Device profile name"),
        uuid: z.string().optional().describe("Device profile UUID"),
      }).refine((a) => a.name || a.uuid, {
        message: "Either name or uuid is required",
      }),
      execute: async (args, context) => {
        const { host, username, password, version: configuredVersion } =
          context.globalArgs;
        const auth = basicAuth(username, password);
        const axlVersion = configuredVersion ??
          (await discoverVersion(host, auth));
        context.logger.info(`Using AXL version ${axlVersion}`);

        const lookup = args.name
          ? `      <name>${args.name}</name>`
          : `      <uuid>${args.uuid}</uuid>`;

        const bodyInner = `    <axl:getDeviceProfile sequence="1">
${lookup}
    </axl:getDeviceProfile>`;

        const parsed = await soapRequest(
          host,
          auth,
          axlVersion,
          "getDeviceProfile",
          bodyInner,
        );

        const raw = parsed?.Envelope?.Body?.getDeviceProfileResponse?.return
          ?.deviceProfile;
        if (!raw || typeof raw !== "object") {
          throw new Error("getDeviceProfile returned no deviceProfile object");
        }

        const profile = normalizeDeviceProfile(raw as Record<string, unknown>);
        const instanceName = (profile.name as string) ?? args.name ??
          args.uuid ?? "unknown";

        context.logger.info(`getDeviceProfile returned "${instanceName}"`);

        const handle = await context.writeResource(
          "deviceProfile",
          instanceName,
          profile,
        );
        return { dataHandles: [handle] };
      },
    },

    addDeviceProfile: {
      description: "Add a new device profile to CUCM.",
      arguments: z.object({
        name: z.string().describe("Device profile name"),
        product: z.string().describe("Product type (e.g. 'Cisco 8861')"),
        class: z.string().default("Device Profile").describe(
          "Device class — almost always 'Device Profile'",
        ),
        protocol: z.string().describe("Protocol: 'SIP' or 'SCCP'"),
        protocolSide: z.string().default("User"),
        phoneTemplateName: z.string().describe("Phone button template name"),
        description: z.string().optional(),
        softkeyTemplateName: z.string().nullable().optional(),
        userLocale: z.string().optional(),
        lines: z.array(z.object({
          index: z.number().int().min(1),
          pattern: z.string(),
          routePartitionName: z.string().nullable().default(null),
          label: z.string().optional(),
          display: z.string().optional(),
          displayAscii: z.string().optional(),
          maxNumCalls: z.number().int().default(2),
          busyTrigger: z.number().int().default(1),
        })).optional().describe("Lines to assign to the profile"),
      }),
      execute: async (args, context) => {
        const { host, username, password, version: configuredVersion } =
          context.globalArgs;
        const auth = basicAuth(username, password);
        const axlVersion = configuredVersion ??
          (await discoverVersion(host, auth));
        context.logger.info(`Using AXL version ${axlVersion}`);

        const fkEl = (tag: string, value: string | null | undefined) => {
          if (value === undefined) return "";
          if (value === null) return `        <${tag} xsi:nil="true"/>`;
          return `        <${tag}>${value}</${tag}>`;
        };

        const linesXml = args.lines && args.lines.length > 0
          ? `        <lines>
${
            args.lines.map((l) =>
              `          <line>
            <index>${l.index}</index>
${
                l.label !== undefined
                  ? `            <label>${l.label}</label>`
                  : ""
              }
${l.display !== undefined ? `            <display>${l.display}</display>` : ""}
${
                l.displayAscii !== undefined
                  ? `            <displayAscii>${l.displayAscii}</displayAscii>`
                  : ""
              }
            <dirn>
              <pattern>${l.pattern}</pattern>
              ${
                l.routePartitionName
                  ? `<routePartitionName>${l.routePartitionName}</routePartitionName>`
                  : `<routePartitionName xsi:nil="true"/>`
              }
            </dirn>
            <maxNumCalls>${l.maxNumCalls}</maxNumCalls>
            <busyTrigger>${l.busyTrigger}</busyTrigger>
          </line>`
            ).join("\n")
          }
        </lines>`
          : "";

        const bodyInner = `    <axl:addDeviceProfile sequence="1">
      <deviceProfile>
        <name>${args.name}</name>
${
          args.description !== undefined
            ? `        <description>${args.description}</description>`
            : ""
        }
        <product>${args.product}</product>
        <class>${args.class}</class>
        <protocol>${args.protocol}</protocol>
        <protocolSide>${args.protocolSide}</protocolSide>
        <phoneTemplateName>${args.phoneTemplateName}</phoneTemplateName>
${fkEl("softkeyTemplateName", args.softkeyTemplateName)}
${
          args.userLocale !== undefined
            ? `        <userLocale>${args.userLocale}</userLocale>`
            : ""
        }
${linesXml}
      </deviceProfile>
    </axl:addDeviceProfile>`;

        const result = await soapRequest(
          host,
          auth,
          axlVersion,
          "addDeviceProfile",
          bodyInner,
        );
        const newUuid =
          result?.Envelope?.Body?.addDeviceProfileResponse?.return?.["#text"] ??
            result?.Envelope?.Body?.addDeviceProfileResponse?.return;
        context.logger.info(
          `addDeviceProfile created "${args.name}" with UUID ${newUuid}`,
        );

        const refreshed = await soapRequest(
          host,
          auth,
          axlVersion,
          "getDeviceProfile",
          `    <axl:getDeviceProfile sequence="1">\n      <name>${args.name}</name>\n    </axl:getDeviceProfile>`,
        );
        const raw = refreshed?.Envelope?.Body?.getDeviceProfileResponse?.return
          ?.deviceProfile;
        const profile = normalizeDeviceProfile(
          (raw ?? {}) as Record<string, unknown>,
        );

        const handle = await context.writeResource(
          "deviceProfile",
          args.name,
          profile,
        );
        return { dataHandles: [handle] };
      },
    },

    updateDeviceProfile: {
      description:
        "Update a device profile in CUCM. Only provided fields are updated.",
      arguments: z.object({
        name: z.string().optional().describe("Current device profile name"),
        uuid: z.string().optional().describe("Device profile UUID"),
        newName: z.string().optional().describe("Rename the profile"),
        description: z.string().optional(),
        phoneTemplateName: z.string().optional(),
        softkeyTemplateName: z.string().nullable().optional(),
        userLocale: z.string().nullable().optional(),
      }).refine((a) => a.name || a.uuid, {
        message: "Either name or uuid is required",
      }),
      execute: async (args, context) => {
        const { host, username, password, version: configuredVersion } =
          context.globalArgs;
        const auth = basicAuth(username, password);
        const axlVersion = configuredVersion ??
          (await discoverVersion(host, auth));
        context.logger.info(`Using AXL version ${axlVersion}`);

        const { name, uuid, newName, ...fields } = args;

        const lookup = name
          ? `      <name>${name}</name>`
          : `      <uuid>${uuid}</uuid>`;

        const fieldLines = Object.entries(fields)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => {
            if (v === null) return `      <${k} xsi:nil="true"/>`;
            return `      <${k}>${v}</${k}>`;
          })
          .join("\n");

        const renameLine = newName ? `      <newName>${newName}</newName>` : "";

        const bodyInner = `    <axl:updateDeviceProfile sequence="1">
${lookup}
${renameLine}
${fieldLines}
    </axl:updateDeviceProfile>`;

        await soapRequest(
          host,
          auth,
          axlVersion,
          "updateDeviceProfile",
          bodyInner,
        );

        const refreshName = newName ?? name;
        const refreshLookup = refreshName
          ? `      <name>${refreshName}</name>`
          : `      <uuid>${uuid}</uuid>`;

        const refreshed = await soapRequest(
          host,
          auth,
          axlVersion,
          "getDeviceProfile",
          `    <axl:getDeviceProfile sequence="1">\n${refreshLookup}\n    </axl:getDeviceProfile>`,
        );

        const raw = refreshed?.Envelope?.Body?.getDeviceProfileResponse?.return
          ?.deviceProfile;
        const profile = normalizeDeviceProfile(
          (raw ?? {}) as Record<string, unknown>,
        );
        const instanceName = (profile.name as string) ?? refreshName ??
          "unknown";

        context.logger.info(
          `updateDeviceProfile succeeded, refreshed "${instanceName}"`,
        );

        const handle = await context.writeResource(
          "deviceProfile",
          instanceName,
          profile,
        );
        return { dataHandles: [handle] };
      },
    },

    removeDeviceProfile: {
      description: "Remove a device profile from CUCM by name or UUID.",
      arguments: z.object({
        name: z.string().optional().describe("Device profile name"),
        uuid: z.string().optional().describe("Device profile UUID"),
      }).refine((a) => a.name || a.uuid, {
        message: "Either name or uuid is required",
      }),
      execute: async (args, context) => {
        const { host, username, password, version: configuredVersion } =
          context.globalArgs;
        const auth = basicAuth(username, password);
        const axlVersion = configuredVersion ??
          (await discoverVersion(host, auth));
        context.logger.info(`Using AXL version ${axlVersion}`);

        const lookup = args.name
          ? `      <name>${args.name}</name>`
          : `      <uuid>${args.uuid}</uuid>`;

        const bodyInner = `    <axl:removeDeviceProfile sequence="1">
${lookup}
    </axl:removeDeviceProfile>`;

        await soapRequest(
          host,
          auth,
          axlVersion,
          "removeDeviceProfile",
          bodyInner,
        );

        context.logger.info(
          `removeDeviceProfile deleted "${args.name ?? args.uuid}"`,
        );
        return { dataHandles: [] };
      },
    },
  },
};
