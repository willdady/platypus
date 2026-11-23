import { admin } from "better-auth/plugins";

const adminPlugin = admin();

export const authPlugins = [adminPlugin] as [typeof adminPlugin];

export const authUserFieldOverrides = {
  banned: {
    type: "boolean",
    required: true,
    defaultValue: false,
    input: false,
  },
} as const;
