import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { z } from "zod";

const monitoring = join(__dirname, "../../monitoring");
const datasource = z.object({
  type: z.literal("prometheus"),
  uid: z.string().min(1),
});
const dashboardSchema = z.object({
  uid: z.string().min(1),
  title: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  panels: z
    .array(
      z.object({
        id: z.number().int().positive(),
        type: z.literal("stat"),
        title: z.string().min(1),
        datasource,
        gridPos: z.object({
          x: z.number().int().nonnegative(),
          y: z.number().int().nonnegative(),
          w: z.number().int().positive(),
          h: z.number().int().positive(),
        }),
        targets: z
          .array(
            z.object({
              expr: z.string().min(1),
              refId: z.string().min(1),
              instant: z.literal(true),
            }),
          )
          .min(1),
        fieldConfig: z.object({
          defaults: z.object({
            thresholds: z.object({
              mode: z.literal("absolute"),
              steps: z
                .array(
                  z.object({
                    color: z.string(),
                    value: z.number().nullable(),
                  }),
                )
                .min(1),
            }),
          }),
        }),
      }),
    )
    .length(8),
});

describe("provider float monitoring", () => {
  it("defines a Grafana dashboard with balance and alert-colored runway panels for all four providers", () => {
    const dashboard = dashboardSchema.parse(
      JSON.parse(
        readFileSync(join(monitoring, "dashboards/float-runway.json"), "utf8"),
      ),
    );
    expect(new Set(dashboard.panels.map(({ id }) => id)).size).toBe(8);

    for (const provider of ["mtn", "orange", "airtel", "mpesa"]) {
      expect(dashboard.panels).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            targets: [
              expect.objectContaining({
                expr: `mobile_money_provider_float_balance{provider="${provider}"}`,
              }),
            ],
          }),
          expect.objectContaining({
            targets: [
              expect.objectContaining({
                expr: expect.stringContaining(
                  `mobile_money_provider_float_runway_hours{provider="${provider}"}`,
                ),
              }),
            ],
            fieldConfig: {
              defaults: {
                thresholds: {
                  mode: "absolute",
                  steps: [
                    { color: "red", value: null },
                    { color: "green", value: 24 },
                  ],
                },
              },
            },
          }),
        ]),
      );
    }
  });

  it("loads the Prometheus rule file and checks the alert threshold", () => {
    expect(
      load(readFileSync(join(monitoring, "prometheus-rules.yml"), "utf8")),
    ).toMatchObject({
      groups: [
        {
          rules: [
            { record: "mobile_money_provider_float_runway_hours" },
            {
              alert: "MobileMoneyProviderFloatDepletion",
              expr: expect.stringContaining(
                "mobile_money_provider_float_runway_hours < 24",
              ),
            },
          ],
        },
      ],
    });
  });
});
