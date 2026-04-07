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

// Subset of fields returned by listUser (LUser)
const UserSchema = z
  .object({
    uuid: z.string().optional(),
    userid: z.string().optional(),
    firstName: z.string().nullable().optional(),
    middleName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    mailid: z.string().nullable().optional(),
    department: z.string().nullable().optional(),
    manager: z.string().nullable().optional(),
    primaryExtension: z
      .object({
        pattern: z.string().optional(),
        routePartitionName: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    enableCti: z.boolean().optional(),
    enableMobility: z.boolean().optional(),
    imAndPresenceEnable: z.boolean().optional(),
    homeCluster: z.boolean().optional(),
    directoryUri: z.string().nullable().optional(),
    telephoneNumber: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    mobileNumber: z.string().nullable().optional(),
  })
  .passthrough();

// Full user detail returned by getUser (RUser)
const UserDetailSchema = z
  .object({
    uuid: z.string().optional(),
    userid: z.string().optional(),
    firstName: z.string().nullable().optional(),
    middleName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
    mailid: z.string().nullable().optional(),
    department: z.string().nullable().optional(),
    manager: z.string().nullable().optional(),
    primaryExtension: z
      .object({
        pattern: z.string().optional(),
        routePartitionName: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    associatedDevices: z
      .object({ device: z.union([z.array(z.string()), z.string()]) })
      .nullable()
      .optional(),
    associatedGroups: z
      .object({
        userGroup: z.union([
          z.array(z.object({ name: z.string() }).passthrough()),
          z.object({ name: z.string() }).passthrough(),
        ]),
      })
      .nullable()
      .optional(),
    enableCti: z.boolean().optional(),
    enableMobility: z.boolean().optional(),
    imAndPresenceEnable: z.boolean().optional(),
    homeCluster: z.boolean().optional(),
    presenceGroupName: FkSchema.optional(),
    subscribeCallingSearchSpaceName: FkSchema.optional(),
    directoryUri: z.string().nullable().optional(),
    telephoneNumber: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    mobileNumber: z.string().nullable().optional(),
    homeNumber: z.string().nullable().optional(),
    pagerNumber: z.string().nullable().optional(),
  })
  .passthrough();

const UsersOutputSchema = z.object({
  axlVersion: z.string(),
  total: z.number(),
  users: z.array(UserSchema),
});

// Default fields for listUser (LUser elements)
const DEFAULT_RETURNED_TAGS = [
  "userid",
  "firstName",
  "middleName",
  "lastName",
  "mailid",
  "department",
  "manager",
  "primaryExtension",
  "enableCti",
  "enableMobility",
  "imAndPresenceEnable",
  "homeCluster",
  "directoryUri",
  "telephoneNumber",
  "title",
  "mobileNumber",
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
  "presenceGroupName",
  "subscribeCallingSearchSpaceName",
  "defaultProfile",
  "serviceProfile",
  "customerName",
]);

function normalizeUser(raw: Record<string, unknown>): Record<string, unknown> {
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
  parseAttributeValue: false,
  removeNSPrefix: true,
  isArray: (_name, jpath) =>
    jpath === "Envelope.Body.listUserResponse.return.user" ||
    jpath.endsWith(".associatedDevices.device") ||
    jpath.endsWith(".associatedGroups.userGroup"),
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
  type: "@notthatjesus/cisco-unified-communications-manager/user",
  version: "2026.04.07.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    users: {
      description: "End users returned by listUser",
      schema: UsersOutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    user: {
      description: "Full user detail returned by getUser, keyed by userid",
      schema: UserDetailSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    listUser: {
      description:
        "List end users from CUCM AXL. At least one searchCriteria field is required; use '%' for wildcard.",
      arguments: z.object({
        searchCriteria: z
          .object({
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            userid: z.string().optional(),
            department: z.string().optional(),
          })
          .default({ userid: "%" })
          .describe("At least one field required. Use '%' for wildcard match."),
        returnedTags: z
          .array(z.string())
          .default(DEFAULT_RETURNED_TAGS)
          .describe(
            "LUser fields to return. Defaults to a practical core set.",
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
            "searchCriteria must have at least one field. Use userid='%' to match all users.",
          );
        }

        const tagsLines = returnedTags.map((t) => `        <${t}/>`).join("\n");

        const paginationLines = [
          skip !== undefined ? `      <skip>${skip}</skip>` : "",
          first !== undefined ? `      <first>${first}</first>` : "",
        ]
          .filter(Boolean)
          .join("\n");

        const bodyInner = `    <axl:listUser sequence="1">
      <searchCriteria>
${criteriaLines}
      </searchCriteria>
      <returnedTags>
${tagsLines}
      </returnedTags>
${paginationLines}
    </axl:listUser>`;

        const parsed = await soapRequest(
          host,
          auth,
          axlVersion,
          "listUser",
          bodyInner,
        );

        const users: unknown[] =
          parsed?.Envelope?.Body?.listUserResponse?.return?.user ?? [];

        const normalized = (users as Record<string, unknown>[]).map(
          normalizeUser,
        );
        context.logger.info(`listUser returned ${normalized.length} users`);

        const handle = await context.writeResource("users", "main", {
          axlVersion,
          total: normalized.length,
          users: normalized,
        });

        return { dataHandles: [handle] };
      },
    },

    getUser: {
      description:
        "Get full details of a single end user by userid or UUID. Stores result keyed by userid.",
      arguments: z.object({
        userid: z.string().optional().describe("User ID (login name)"),
        uuid: z.string().optional().describe("User UUID"),
      }).refine((a) => a.userid || a.uuid, {
        message: "Either userid or uuid is required",
      }),
      execute: async (args, context) => {
        const { host, username, password, version: configuredVersion } =
          context.globalArgs;
        const auth = basicAuth(username, password);
        const axlVersion = configuredVersion ??
          (await discoverVersion(host, auth));
        context.logger.info(`Using AXL version ${axlVersion}`);

        const lookup = args.userid
          ? `      <userid>${args.userid}</userid>`
          : `      <uuid>${args.uuid}</uuid>`;

        const bodyInner = `    <axl:getUser sequence="1">
${lookup}
    </axl:getUser>`;

        const parsed = await soapRequest(
          host,
          auth,
          axlVersion,
          "getUser",
          bodyInner,
        );

        const raw = parsed?.Envelope?.Body?.getUserResponse?.return?.user;
        if (!raw || typeof raw !== "object") {
          throw new Error("getUser returned no user object");
        }

        const user = normalizeUser(raw as Record<string, unknown>);
        const instanceName = (user.userid as string) ?? args.userid ??
          args.uuid ?? "unknown";

        context.logger.info(`getUser returned user "${instanceName}"`);

        const handle = await context.writeResource("user", instanceName, user);
        return { dataHandles: [handle] };
      },
    },

    addUser: {
      description: "Add a new end user to CUCM.",
      arguments: z.object({
        // Required by XUser
        userid: z.string().describe("Unique user ID (login name)"),
        lastName: z.string().describe("Last name"),
        presenceGroupName: z.string().default("Standard Presence group")
          .describe("Presence group name"),
        // Optional common fields
        firstName: z.string().optional(),
        middleName: z.string().optional(),
        displayName: z.string().optional(),
        mailid: z.string().optional().describe("Email address"),
        department: z.string().optional(),
        manager: z.string().optional(),
        password: z.string().optional().describe("Web application password"),
        pin: z.string().optional().describe("Phone PIN"),
        telephoneNumber: z.string().optional().describe(
          "Phone number shown in directory",
        ),
        title: z.string().optional(),
        mobileNumber: z.string().optional(),
        homeNumber: z.string().optional(),
        directoryUri: z.string().optional().describe(
          "URI (user@domain format)",
        ),
        enableCti: z.boolean().default(true),
        enableMobility: z.boolean().default(false),
        enableMobileVoiceAccess: z.boolean().default(false),
        imAndPresenceEnable: z.boolean().default(false),
        homeCluster: z.boolean().default(true),
        associatedDevices: z
          .array(z.string())
          .optional()
          .describe("List of device names to associate (controlled devices)"),
        primaryExtension: z
          .object({
            pattern: z.string(),
            routePartitionName: z.string().nullable().default(null),
          })
          .optional()
          .describe("Primary extension DN"),
      }),
      execute: async (args, context) => {
        const { host, username, password, version: configuredVersion } =
          context.globalArgs;
        const auth = basicAuth(username, password);
        const axlVersion = configuredVersion ??
          (await discoverVersion(host, auth));
        context.logger.info(`Using AXL version ${axlVersion}`);

        const optEl = (tag: string, value: string | undefined) =>
          value !== undefined ? `        <${tag}>${value}</${tag}>` : "";

        const boolEl = (tag: string, value: boolean | undefined) =>
          value !== undefined ? `        <${tag}>${value}</${tag}>` : "";

        const devicesXml =
          args.associatedDevices && args.associatedDevices.length > 0
            ? `        <associatedDevices>
${
              args.associatedDevices.map((d) =>
                `          <device>${d}</device>`
              ).join("\n")
            }
        </associatedDevices>`
            : "";

        const primaryExtXml = args.primaryExtension
          ? `        <primaryExtension>
          <pattern>${args.primaryExtension.pattern}</pattern>
          ${
            args.primaryExtension.routePartitionName
              ? `<routePartitionName>${args.primaryExtension.routePartitionName}</routePartitionName>`
              : `<routePartitionName xsi:nil="true"/>`
          }
        </primaryExtension>`
          : "";

        const bodyInner = `    <axl:addUser sequence="1">
      <user>
        <userid>${args.userid}</userid>
        <lastName>${args.lastName}</lastName>
${optEl("firstName", args.firstName)}
${optEl("middleName", args.middleName)}
${optEl("displayName", args.displayName)}
${optEl("mailid", args.mailid)}
${optEl("department", args.department)}
${optEl("manager", args.manager)}
${optEl("password", args.password)}
${optEl("pin", args.pin)}
${optEl("telephoneNumber", args.telephoneNumber)}
${optEl("title", args.title)}
${optEl("mobileNumber", args.mobileNumber)}
${optEl("homeNumber", args.homeNumber)}
${optEl("directoryUri", args.directoryUri)}
        <presenceGroupName>${args.presenceGroupName}</presenceGroupName>
${boolEl("enableCti", args.enableCti)}
${boolEl("enableMobility", args.enableMobility)}
${boolEl("enableMobileVoiceAccess", args.enableMobileVoiceAccess)}
${boolEl("imAndPresenceEnable", args.imAndPresenceEnable)}
${boolEl("homeCluster", args.homeCluster)}
${devicesXml}
${primaryExtXml}
      </user>
    </axl:addUser>`;

        const result = await soapRequest(
          host,
          auth,
          axlVersion,
          "addUser",
          bodyInner,
        );
        const newUuid =
          result?.Envelope?.Body?.addUserResponse?.return?.["#text"] ??
            result?.Envelope?.Body?.addUserResponse?.return;
        context.logger.info(
          `addUser created user "${args.userid}" with UUID ${newUuid}`,
        );

        // Fetch and store the full user record
        const refreshed = await soapRequest(
          host,
          auth,
          axlVersion,
          "getUser",
          `    <axl:getUser sequence="1">\n      <userid>${args.userid}</userid>\n    </axl:getUser>`,
        );
        const raw = refreshed?.Envelope?.Body?.getUserResponse?.return?.user;
        const user = normalizeUser((raw ?? {}) as Record<string, unknown>);

        const handle = await context.writeResource("user", args.userid, user);
        return { dataHandles: [handle] };
      },
    },

    updateUser: {
      description:
        "Update an end user in CUCM AXL. Identify by userid or UUID. Only provided fields are updated. Refreshes stored user record afterwards.",
      arguments: z
        .object({
          userid: z.string().optional().describe("Current user ID"),
          uuid: z.string().optional().describe("User UUID"),
          newUserid: z.string().optional().describe("Rename the user ID"),
          firstName: z.string().optional(),
          middleName: z.string().optional(),
          lastName: z.string().optional(),
          displayName: z.string().optional(),
          mailid: z.string().optional(),
          department: z.string().optional(),
          manager: z.string().optional(),
          password: z.string().optional(),
          pin: z.string().optional(),
          telephoneNumber: z.string().nullable().optional(),
          title: z.string().nullable().optional(),
          mobileNumber: z.string().nullable().optional(),
          homeNumber: z.string().nullable().optional(),
          directoryUri: z.string().nullable().optional(),
          presenceGroupName: z.string().optional(),
          enableCti: z.boolean().optional(),
          enableMobility: z.boolean().optional(),
          enableMobileVoiceAccess: z.boolean().optional(),
          imAndPresenceEnable: z.boolean().optional(),
          homeCluster: z.boolean().optional(),
          associatedDevices: z
            .array(z.string())
            .optional()
            .describe("Full replacement list of associated device names"),
          primaryExtension: z
            .object({
              pattern: z.string(),
              routePartitionName: z.string().nullable().default(null),
            })
            .optional(),
        })
        .refine((a) => a.userid || a.uuid, {
          message: "Either userid or uuid is required",
        }),
      execute: async (args, context) => {
        const { host, username, password, version: configuredVersion } =
          context.globalArgs;
        const auth = basicAuth(username, password);
        const axlVersion = configuredVersion ??
          (await discoverVersion(host, auth));
        context.logger.info(`Using AXL version ${axlVersion}`);

        const {
          userid,
          uuid,
          newUserid,
          associatedDevices,
          primaryExtension,
          ...scalarFields
        } = args;

        const lookup = userid
          ? `      <userid>${userid}</userid>`
          : `      <uuid>${uuid}</uuid>`;

        const fieldLines = Object.entries(scalarFields)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => {
            if (v === null) return `      <${k} xsi:nil="true"/>`;
            if (typeof v === "boolean") return `      <${k}>${v}</${k}>`;
            return `      <${k}>${v}</${k}>`;
          })
          .join("\n");

        const renameLine = newUserid
          ? `      <newUserid>${newUserid}</newUserid>`
          : "";

        const devicesXml = associatedDevices !== undefined
          ? associatedDevices.length > 0
            ? `      <associatedDevices>
${associatedDevices.map((d) => `        <device>${d}</device>`).join("\n")}
      </associatedDevices>`
            : `      <associatedDevices/>`
          : "";

        const primaryExtXml = primaryExtension
          ? `      <primaryExtension>
        <pattern>${primaryExtension.pattern}</pattern>
        ${
            primaryExtension.routePartitionName
              ? `<routePartitionName>${primaryExtension.routePartitionName}</routePartitionName>`
              : `<routePartitionName xsi:nil="true"/>`
          }
      </primaryExtension>`
          : "";

        const bodyInner = `    <axl:updateUser sequence="1">
${lookup}
${renameLine}
${fieldLines}
${devicesXml}
${primaryExtXml}
    </axl:updateUser>`;

        await soapRequest(host, auth, axlVersion, "updateUser", bodyInner);

        const refreshUserId = newUserid ?? userid;
        const refreshLookup = refreshUserId
          ? `      <userid>${refreshUserId}</userid>`
          : `      <uuid>${uuid}</uuid>`;

        const refreshed = await soapRequest(
          host,
          auth,
          axlVersion,
          "getUser",
          `    <axl:getUser sequence="1">\n${refreshLookup}\n    </axl:getUser>`,
        );

        const raw = refreshed?.Envelope?.Body?.getUserResponse?.return?.user;
        const user = normalizeUser((raw ?? {}) as Record<string, unknown>);
        const instanceName = (user.userid as string) ?? refreshUserId ??
          "unknown";

        context.logger.info(
          `updateUser succeeded, refreshed "${instanceName}"`,
        );

        const handle = await context.writeResource("user", instanceName, user);
        return { dataHandles: [handle] };
      },
    },

    removeUser: {
      description: "Remove an end user from CUCM by userid or UUID.",
      arguments: z
        .object({
          userid: z.string().optional().describe("User ID"),
          uuid: z.string().optional().describe("User UUID"),
        })
        .refine((a) => a.userid || a.uuid, {
          message: "Either userid or uuid is required",
        }),
      execute: async (args, context) => {
        const { host, username, password, version: configuredVersion } =
          context.globalArgs;
        const auth = basicAuth(username, password);
        const axlVersion = configuredVersion ??
          (await discoverVersion(host, auth));
        context.logger.info(`Using AXL version ${axlVersion}`);

        const lookup = args.userid
          ? `      <userid>${args.userid}</userid>`
          : `      <uuid>${args.uuid}</uuid>`;

        const bodyInner = `    <axl:removeUser sequence="1">
${lookup}
    </axl:removeUser>`;

        await soapRequest(host, auth, axlVersion, "removeUser", bodyInner);

        context.logger.info(`removeUser deleted "${args.userid ?? args.uuid}"`);
        return { dataHandles: [] };
      },
    },
  },
};
