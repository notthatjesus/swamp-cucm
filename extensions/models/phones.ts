import { z } from "npm:zod@4";
import { XMLParser } from "npm:fast-xml-parser@4.5.0";
import { fetch, Agent } from "npm:undici@5.28.4";

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

const PhoneSchema = z
  .object({
    uuid: z.string().optional(),
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    product: z.string().optional(),
    model: z.string().optional(),
    class: z.string().optional(),
    protocol: z.string().optional(),
    protocolSide: z.string().optional(),
    callingSearchSpaceName: FkSchema.optional(),
    devicePoolName: FkSchema.optional(),
    locationName: FkSchema.optional(),
    ownerUserName: FkSchema.optional(),
    securityProfileName: FkSchema.optional(),
    sipProfileName: FkSchema.optional(),
    commonDeviceConfigName: FkSchema.optional(),
    commonPhoneConfigName: FkSchema.optional(),
    phoneTemplateName: FkSchema.optional(),
    softkeyTemplateName: FkSchema.optional(),
    isActive: z.boolean().optional(),
    enableExtensionMobility: z.boolean().optional(),
    allowCtiControlFlag: z.boolean().optional(),
  })
  .passthrough();

// Line (DN) associated with a phone button
const PhoneLineSchema = z.object({
  index: z.number().optional(),
  label: z.string().nullable().optional(),
  display: z.string().nullable().optional(),
  displayAscii: z.string().nullable().optional(),
  e164Mask: z.string().nullable().optional(),
  dirn: z.object({ uuid: z.string().nullable() }).nullable().optional(),
}).passthrough();

// Full phone detail returned by getPhone (RPhone — superset of LPhone)
const PhoneDetailSchema = z
  .object({
    uuid: z.string().optional(),
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    product: z.string().optional(),
    model: z.string().optional(),
    class: z.string().optional(),
    protocol: z.string().optional(),
    protocolSide: z.string().optional(),
    callingSearchSpaceName: FkSchema.optional(),
    devicePoolName: FkSchema.optional(),
    locationName: FkSchema.optional(),
    ownerUserName: FkSchema.optional(),
    securityProfileName: FkSchema.optional(),
    sipProfileName: FkSchema.optional(),
    commonDeviceConfigName: FkSchema.optional(),
    commonPhoneConfigName: FkSchema.optional(),
    phoneTemplateName: FkSchema.optional(),
    softkeyTemplateName: FkSchema.optional(),
    isActive: z.boolean().optional(),
    enableExtensionMobility: z.boolean().optional(),
    allowCtiControlFlag: z.boolean().optional(),
    lines: z.union([z.object({ line: z.array(PhoneLineSchema) }), z.string()]).optional(),
  })
  .passthrough();

const PhonesOutputSchema = z.object({
  axlVersion: z.string(),
  total: z.number(),
  phones: z.array(PhoneSchema),
});

// Default fields requested from CUCM (maps to LPhone elements in returnedTags)
const DEFAULT_RETURNED_TAGS = [
  "name",
  "description",
  "product",
  "model",
  "class",
  "protocol",
  "protocolSide",
  "callingSearchSpaceName",
  "devicePoolName",
  "locationName",
  "ownerUserName",
  "securityProfileName",
  "sipProfileName",
  "commonDeviceConfigName",
  "commonPhoneConfigName",
  "phoneTemplateName",
  "softkeyTemplateName",
  "isActive",
  "enableExtensionMobility",
  "allowCtiControlFlag",
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
 *  Wire format: <devicePoolName uuid="{u}">Name</devicePoolName>
 *  Parsed as:   { "#text": "Name", "@_uuid": "{u}" }  or just "Name" */
function normalizeFk(v: unknown): { name: string | null; uuid: string | null } | null {
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

/** Fields in LPhone that are XFkType */
const FK_FIELDS = new Set([
  "callingSearchSpaceName",
  "devicePoolName",
  "locationName",
  "ownerUserName",
  "securityProfileName",
  "sipProfileName",
  "commonDeviceConfigName",
  "commonPhoneConfigName",
  "mediaResourceListName",
  "automatedAlternateRoutingCssName",
  "aarNeighborhoodName",
  "phoneTemplateName",
  "primaryPhoneName",
  "softkeyTemplateName",
  "defaultProfileName",
  "currentProfileName",
  "cgpnTransformationCssName",
  "geoLocationName",
  "geoLocationFilterName",
  "subscribeCallingSearchSpaceName",
  "rerouteCallingSearchSpaceName",
  "presenceGroupName",
  "dialRulesName",
  "mobilityUserIdName",
  "featureControlPolicy",
  "mraServiceDomain",
  "roamingDevicePoolName",
]);

/** Normalize a raw phone record from the parsed XML */
function normalizePhone(raw: Record<string, unknown>): Record<string, unknown> {
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
  parseAttributeValue: false, // keep uuids as strings
  removeNSPrefix: true, // strip soapenv: axl: prefixes → easier navigation
  isArray: (_name, jpath) =>
    jpath === "Envelope.Body.listPhoneResponse.return.phone" ||
    jpath.endsWith(".lines.line"), // always arrays
});

async function soapRequest(
  host: string,
  auth: string,
  version: string,
  action: string,
  bodyInner: string,
): Promise<Record<string, unknown>> {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="${SOAP_NS}" xmlns:axl="${axlNs(version)}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
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
    const fault =
      parsed?.Envelope?.Body?.Fault?.faultstring ??
      parsed?.Envelope?.Body?.Fault?.detail?.axlError?.axlmessage ??
      text;
    throw new Error(`AXL ${action} failed (HTTP ${res.status}): ${fault}`);
  }

  return XML_PARSER.parse(text);
}

/** Discover AXL version from CUCM via getCCMVersion */
async function discoverVersion(host: string, auth: string): Promise<string> {
  const parsed = await soapRequest(host, auth, "15.0", "getCCMVersion", `    <axl:getCCMVersion/>`);

  const versionStr =
    parsed?.Envelope?.Body?.getCCMVersionResponse?.return?.componentVersion?.version;

  if (typeof versionStr !== "string" || !versionStr) {
    throw new Error("getCCMVersion returned no version string");
  }

  // "12.5.1.12900-2" → "12.5"
  const match = versionStr.match(/^(\d+\.\d+)/);
  if (!match) throw new Error(`Unexpected CUCM version format: ${versionStr}`);
  return match[1];
}

// ─── Model ──────────────────────────────────────────────────────────────────

export const model = {
  type: "@notthatjesus/cisco-unified-communications-manager/phone",
  version: "2026.04.06.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    phones: {
      description: "Phone devices returned by listPhone",
      schema: PhonesOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    phone: {
      description: "Full phone detail returned by getPhone, keyed by phone name",
      schema: PhoneDetailSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    listPhone: {
      description:
        "List phones from CUCM AXL. At least one searchCriteria field is required; use '%' for wildcard.",
      arguments: z.object({
        searchCriteria: z
          .object({
            name: z.string().optional(),
            description: z.string().optional(),
            protocol: z.string().optional(),
            callingSearchSpaceName: z.string().optional(),
            devicePoolName: z.string().optional(),
            securityProfileName: z.string().optional(),
          })
          .default({ name: "%" })
          .describe("At least one field required. Use '%' for wildcard match."),
        returnedTags: z
          .array(z.string())
          .default(DEFAULT_RETURNED_TAGS)
          .describe("LPhone fields to return. Defaults to a practical core set."),
        skip: z.number().int().nonnegative().optional().describe("Pagination offset"),
        first: z.number().int().positive().optional().describe("Max records to return"),
      }),
      execute: async (args, context) => {
        const { host, username, password, version: configuredVersion } = context.globalArgs;
        const auth = basicAuth(username, password);

        const axlVersion = configuredVersion ?? (await discoverVersion(host, auth));
        context.logger.info(`Using AXL version ${axlVersion}`);

        const { searchCriteria, returnedTags, skip, first } = args;

        // Build <searchCriteria> — filter out undefined entries
        const criteriaLines = Object.entries(searchCriteria)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `        <${k}>${v}</${k}>`)
          .join("\n");

        if (!criteriaLines) {
          throw new Error(
            "searchCriteria must have at least one field. Use name='%' to match all phones.",
          );
        }

        // Build <returnedTags> — empty elements signal which fields to return
        const tagsLines = returnedTags.map((t) => `        <${t}/>`).join("\n");

        const paginationLines = [
          skip !== undefined ? `      <skip>${skip}</skip>` : "",
          first !== undefined ? `      <first>${first}</first>` : "",
        ]
          .filter(Boolean)
          .join("\n");

        const bodyInner = `    <axl:listPhone sequence="1">
      <searchCriteria>
${criteriaLines}
      </searchCriteria>
      <returnedTags>
${tagsLines}
      </returnedTags>
${paginationLines}
    </axl:listPhone>`;

        const parsed = await soapRequest(host, auth, axlVersion, "listPhone", bodyInner);

        const phones: unknown[] =
          parsed?.Envelope?.Body?.listPhoneResponse?.return?.phone ?? [];

        const normalized = (phones as Record<string, unknown>[]).map(normalizePhone);

        context.logger.info(`listPhone returned ${normalized.length} phones`);

        const handle = await context.writeResource("phones", "main", {
          axlVersion,
          total: normalized.length,
          phones: normalized,
        });

        return { dataHandles: [handle] };
      },
    },

    getPhone: {
      description:
        "Get full details of a single phone by name or UUID. Stores result keyed by phone name.",
      arguments: z.object({
        name: z.string().optional().describe("Device name (e.g. SEP000C30F01E48)"),
        uuid: z.string().optional().describe("Phone UUID"),
      }).refine((a) => a.name || a.uuid, { message: "Either name or uuid is required" }),
      execute: async (args, context) => {
        const { host, username, password, version: configuredVersion } = context.globalArgs;
        const auth = basicAuth(username, password);
        const axlVersion = configuredVersion ?? (await discoverVersion(host, auth));
        context.logger.info(`Using AXL version ${axlVersion}`);

        // XSD requires xsd:choice — send name or uuid, not both
        const lookup = args.name
          ? `      <name>${args.name}</name>`
          : `      <uuid>${args.uuid}</uuid>`;

        const bodyInner = `    <axl:getPhone sequence="1">
${lookup}
    </axl:getPhone>`;

        const parsed = await soapRequest(host, auth, axlVersion, "getPhone", bodyInner);

        const raw = parsed?.Envelope?.Body?.getPhoneResponse?.return?.phone;
        if (!raw || typeof raw !== "object") {
          throw new Error("getPhone returned no phone object");
        }

        const phone = normalizePhone(raw as Record<string, unknown>);
        const instanceName = (phone.name as string) ?? args.uuid ?? "unknown";

        context.logger.info(`getPhone returned phone "${instanceName}"`);

        const handle = await context.writeResource("phone", instanceName, phone);
        return { dataHandles: [handle] };
      },
    },

    addPhone: {
      description: "Add a new phone to CUCM. Stores the created phone record afterwards.",
      arguments: z.object({
        // Required by XPhone
        name: z.string().describe("Device name (e.g. SEP001122334455)"),
        product: z.string().describe("Product type (e.g. 'Cisco 8861', 'Cisco IP Communicator')"),
        class: z.string().default("Phone").describe("Device class — almost always 'Phone'"),
        protocol: z.string().describe("Protocol: 'SIP' or 'SCCP'"),
        protocolSide: z.string().default("User").describe("Protocol side — almost always 'User'"),
        devicePoolName: z.string().describe("Device pool name"),
        commonPhoneConfigName: z.string().default("Standard Common Phone Profile"),
        locationName: z.string().default("Hub_None"),
        useTrustedRelayPoint: z.string().default("Default"),
        phoneTemplateName: z.string().describe("Phone button template name"),
        builtInBridgeStatus: z.string().default("Default"),
        packetCaptureMode: z.string().default("None"),
        // Optional but commonly needed
        description: z.string().optional(),
        callingSearchSpaceName: z.string().nullable().optional(),
        commonDeviceConfigName: z.string().nullable().optional(),
        securityProfileName: z.string().optional(),
        sipProfileName: z.string().nullable().optional(),
        softkeyTemplateName: z.string().nullable().optional(),
        ownerUserName: z.string().nullable().optional(),
        enableExtensionMobility: z.boolean().default(false),
        allowCtiControlFlag: z.boolean().default(true),
        lines: z.array(z.object({
          index: z.number().int().min(1).describe("Button index (1-based)"),
          pattern: z.string().describe("Directory number pattern (e.g. '1001')"),
          routePartitionName: z.string().nullable().default(null).describe("Route partition (null for none)"),
          label: z.string().optional().describe("Line label shown on phone display"),
          display: z.string().optional().describe("Caller ID display name"),
          displayAscii: z.string().optional().describe("ASCII version of display name"),
          maxNumCalls: z.number().int().default(2),
          busyTrigger: z.number().int().default(1),
        })).optional().describe("Lines (DNs) to assign to the phone"),
      }),
      execute: async (args, context) => {
        const { host, username, password, version: configuredVersion } = context.globalArgs;
        const auth = basicAuth(username, password);
        const axlVersion = configuredVersion ?? (await discoverVersion(host, auth));
        context.logger.info(`Using AXL version ${axlVersion}`);

        // Helper: build a nullable FK element
        const fkEl = (tag: string, value: string | null | undefined) => {
          if (value === undefined) return "";
          if (value === null) return `        <${tag} xsi:nil="true"/>`;
          return `        <${tag}>${value}</${tag}>`;
        };

        // Build <lines> block if provided
        const linesXml = args.lines && args.lines.length > 0
          ? `        <lines>
${args.lines.map((l) => `          <line>
            <index>${l.index}</index>
${l.label !== undefined ? `            <label>${l.label}</label>` : ""}
${l.display !== undefined ? `            <display>${l.display}</display>` : ""}
${l.displayAscii !== undefined ? `            <displayAscii>${l.displayAscii}</displayAscii>` : ""}
            <dirn>
              <pattern>${l.pattern}</pattern>
              ${l.routePartitionName ? `<routePartitionName>${l.routePartitionName}</routePartitionName>` : `<routePartitionName xsi:nil="true"/>`}
            </dirn>
            <maxNumCalls>${l.maxNumCalls}</maxNumCalls>
            <busyTrigger>${l.busyTrigger}</busyTrigger>
          </line>`).join("\n")}
        </lines>`
          : "";

        const bodyInner = `    <axl:addPhone sequence="1">
      <phone>
        <name>${args.name}</name>
${args.description !== undefined ? `        <description>${args.description}</description>` : ""}
        <product>${args.product}</product>
        <class>${args.class}</class>
        <protocol>${args.protocol}</protocol>
        <protocolSide>${args.protocolSide}</protocolSide>
${fkEl("callingSearchSpaceName", args.callingSearchSpaceName)}
        <devicePoolName>${args.devicePoolName}</devicePoolName>
${fkEl("commonDeviceConfigName", args.commonDeviceConfigName)}
        <commonPhoneConfigName>${args.commonPhoneConfigName}</commonPhoneConfigName>
        <locationName>${args.locationName}</locationName>
        <useTrustedRelayPoint>${args.useTrustedRelayPoint}</useTrustedRelayPoint>
${args.securityProfileName !== undefined ? `        <securityProfileName>${args.securityProfileName}</securityProfileName>` : ""}
${fkEl("sipProfileName", args.sipProfileName)}
        <phoneTemplateName>${args.phoneTemplateName}</phoneTemplateName>
${linesXml}
        <primaryPhoneName xsi:nil="true"/>
        <builtInBridgeStatus>${args.builtInBridgeStatus}</builtInBridgeStatus>
        <packetCaptureMode>${args.packetCaptureMode}</packetCaptureMode>
${fkEl("softkeyTemplateName", args.softkeyTemplateName)}
${fkEl("ownerUserName", args.ownerUserName)}
        <enableExtensionMobility>${args.enableExtensionMobility}</enableExtensionMobility>
        <allowCtiControlFlag>${args.allowCtiControlFlag}</allowCtiControlFlag>
      </phone>
    </axl:addPhone>`;

        const result = await soapRequest(host, auth, axlVersion, "addPhone", bodyInner);
        const newUuid = result?.Envelope?.Body?.addPhoneResponse?.return?.["#text"] ?? result?.Envelope?.Body?.addPhoneResponse?.return;
        context.logger.info(`addPhone created phone "${args.name}" with UUID ${newUuid}`);

        // Fetch and store the full phone record
        const refreshed = await soapRequest(
          host, auth, axlVersion, "getPhone",
          `    <axl:getPhone sequence="1">\n      <name>${args.name}</name>\n    </axl:getPhone>`,
        );
        const raw = refreshed?.Envelope?.Body?.getPhoneResponse?.return?.phone;
        const phone = normalizePhone((raw ?? {}) as Record<string, unknown>);

        const handle = await context.writeResource("phone", args.name, phone);
        return { dataHandles: [handle] };
      },
    },

    updatePhone: {
      description:
        "Update a phone in CUCM AXL. Identify by name or uuid. Only provided fields are updated. Refreshes stored phone record afterwards.",
      arguments: z.object({
        name: z.string().optional().describe("Current device name"),
        uuid: z.string().optional().describe("Phone UUID"),
        newName: z.string().optional().describe("Rename the device"),
        description: z.string().optional().describe("Device description"),
        devicePoolName: z.string().optional().describe("Device pool name"),
        callingSearchSpaceName: z.string().nullable().optional().describe("CSS name (null to clear)"),
        locationName: z.string().optional().describe("Location name"),
        commonDeviceConfigName: z.string().nullable().optional().describe("Common device config name (null to clear)"),
        commonPhoneConfigName: z.string().optional().describe("Common phone config name"),
        securityProfileName: z.string().optional().describe("Security profile name"),
        sipProfileName: z.string().nullable().optional().describe("SIP profile name (null to clear)"),
        phoneTemplateName: z.string().optional().describe("Phone button template name"),
        softkeyTemplateName: z.string().nullable().optional().describe("Softkey template name (null to clear)"),
        ownerUserName: z.string().nullable().optional().describe("Owner user ID (null to clear)"),
        enableExtensionMobility: z.boolean().optional().describe("Enable Extension Mobility"),
        allowCtiControlFlag: z.boolean().optional().describe("Allow CTI control"),
        isActive: z.boolean().optional().describe("Whether the device consumes a license"),
      }).refine((a) => a.name || a.uuid, { message: "Either name or uuid is required" }),
      execute: async (args, context) => {
        const { host, username, password, version: configuredVersion } = context.globalArgs;
        const auth = basicAuth(username, password);
        const axlVersion = configuredVersion ?? (await discoverVersion(host, auth));
        context.logger.info(`Using AXL version ${axlVersion}`);

        const { name, uuid, ...fields } = args;

        // Lookup identifier
        const lookup = name
          ? `      <name>${name}</name>`
          : `      <uuid>${uuid}</uuid>`;

        // Build update field elements — only include fields that were provided
        // FK fields (strings) → <field>value</field>
        // Nullable fields set to null → <field xsi:nil="true"/>
        const fieldLines = Object.entries(fields)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => {
            if (v === null) return `      <${k} xsi:nil="true"/>`;
            if (typeof v === "boolean") return `      <${k}>${v}</${k}>`;
            return `      <${k}>${v}</${k}>`;
          })
          .join("\n");

        const bodyInner = `    <axl:updatePhone sequence="1">
${lookup}
${fieldLines}
    </axl:updatePhone>`;

        await soapRequest(host, auth, axlVersion, "updatePhone", bodyInner);

        // Determine the name to use for the refresh getPhone call
        const lookupName = fields.newName ?? name;
        const lookupUuid = lookupName ? undefined : uuid;

        const refreshLookup = lookupName
          ? `      <name>${lookupName}</name>`
          : `      <uuid>${lookupUuid}</uuid>`;

        const refreshed = await soapRequest(
          host, auth, axlVersion, "getPhone",
          `    <axl:getPhone sequence="1">\n${refreshLookup}\n    </axl:getPhone>`,
        );

        const raw = refreshed?.Envelope?.Body?.getPhoneResponse?.return?.phone;
        const phone = normalizePhone((raw ?? {}) as Record<string, unknown>);
        const instanceName = (phone.name as string) ?? lookupName ?? lookupUuid ?? "unknown";

        context.logger.info(`updatePhone succeeded, refreshed "${instanceName}"`);

        const handle = await context.writeResource("phone", instanceName, phone);
        return { dataHandles: [handle] };
      },
    },

    removePhone: {
      description: "Remove a phone from CUCM by name or UUID.",
      arguments: z.object({
        name: z.string().optional().describe("Device name (e.g. SEP001122334455)"),
        uuid: z.string().optional().describe("Phone UUID"),
      }).refine((a) => a.name || a.uuid, { message: "Either name or uuid is required" }),
      execute: async (args, context) => {
        const { host, username, password, version: configuredVersion } = context.globalArgs;
        const auth = basicAuth(username, password);
        const axlVersion = configuredVersion ?? (await discoverVersion(host, auth));
        context.logger.info(`Using AXL version ${axlVersion}`);

        const lookup = args.name
          ? `      <name>${args.name}</name>`
          : `      <uuid>${args.uuid}</uuid>`;

        const bodyInner = `    <axl:removePhone sequence="1">
${lookup}
    </axl:removePhone>`;

        await soapRequest(host, auth, axlVersion, "removePhone", bodyInner);

        context.logger.info(`removePhone deleted "${args.name ?? args.uuid}"`);
        return { dataHandles: [] };
      },
    },
  },
};
