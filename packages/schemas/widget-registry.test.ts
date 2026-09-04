import { describe, it, expect } from "vitest";
import {
  embedWidgetDataSchema,
  widgetSchema,
  widgetTypeRegistry,
  widgetTypeSchema,
  widgetUpdateDataSchema,
} from "./widget-registry.ts";

describe("embed widget schemas", () => {
  const widgetEnvelope = {
    id: "widget-1",
    dashboardId: "dashboard-1",
    title: "Status",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("accepts an HTTPS URL and registers embed as a widget type", () => {
    expect(
      embedWidgetDataSchema.safeParse({
        url: "https://grafana.example.com/d/status",
      }).success,
    ).toBe(true);
    expect(widgetTypeSchema.safeParse("embed").success).toBe(true);
  });

  it.each([
    "http://example.com",
    "javascript:alert(1)",
    "data:text/html,hello",
  ])("rejects a non-HTTPS embed URL: %s", (url) => {
    expect(embedWidgetDataSchema.safeParse({ url }).success).toBe(false);
  });

  it("rejects data outside the URL-only contract", () => {
    expect(
      embedWidgetDataSchema.safeParse({
        url: "https://example.com",
        sandbox: "allow-top-navigation",
      }).success,
    ).toBe(false);
  });

  it("allows the human update contract to save embed data", () => {
    expect(
      widgetUpdateDataSchema.safeParse({
        type: "embed",
        title: "Operations",
        data: { url: "https://status.example.com/embed" },
      }).success,
    ).toBe(true);
  });

  it("rejects a non-HTTPS URL when parsing a complete embed widget", () => {
    expect(
      widgetSchema.safeParse({
        ...widgetEnvelope,
        type: "embed",
        data: { url: "http://status.example.com/embed" },
      }).success,
    ).toBe(false);
  });

  it("accepts complete embed and image widgets under their own data contracts", () => {
    expect(
      widgetSchema.safeParse({
        ...widgetEnvelope,
        type: "embed",
        data: { url: "https://status.example.com/embed" },
      }).success,
    ).toBe(true);
    expect(
      widgetSchema.safeParse({
        ...widgetEnvelope,
        type: "image",
        data: { url: "http://cdn.example.com/status.png" },
      }).success,
    ).toBe(true);
  });

  it("rejects data that belongs to a different widget type", () => {
    expect(
      widgetSchema.safeParse({
        ...widgetEnvelope,
        type: "text",
        data: { url: "https://example.com/not-text" },
      }).success,
    ).toBe(false);
  });

  it.each(widgetTypeSchema.options)(
    "keeps null data valid for a %s widget",
    (type) => {
      expect(
        widgetSchema.safeParse({
          ...widgetEnvelope,
          type,
          data: null,
        }).success,
      ).toBe(true);
    },
  );
});

describe("widget type registry", () => {
  it("derives widgetTypeSchema from the registry keys", () => {
    expect([...widgetTypeSchema.options].sort()).toEqual(
      Object.keys(widgetTypeRegistry).sort(),
    );
  });

  it("gives every registry entry a data contract and a default size", () => {
    for (const [type, definition] of Object.entries(widgetTypeRegistry)) {
      expect(definition.label, type).toBeTruthy();
      expect(definition.dataSchema, type).toBeDefined();
      expect(typeof definition.agentWritable, type).toBe("boolean");
      expect(definition.defaultSize.h, type).toBeGreaterThanOrEqual(3);
      expect(definition.defaultSize.w, type).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps the human update contract open to every registry type", () => {
    for (const type of widgetTypeSchema.options) {
      expect(
        widgetUpdateDataSchema.options.some(
          (member) => member.shape.type.value === type,
        ),
        type,
      ).toBe(true);
    }
  });

  it("keeps Embed human-owned", () => {
    expect(widgetTypeRegistry.embed.agentWritable).toBe(false);
  });
});
