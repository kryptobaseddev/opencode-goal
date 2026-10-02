// Shared RPC contract (plain object; Rpc.define is an identity function).
export const ProbeRpc = {
  id: "probe-rpc",
  methods: {
    ping: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
      output: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    },
  },
  events: {
    tick: { schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false } },
  },
} as const
